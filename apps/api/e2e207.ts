// spec207 端到端冒烟（一次性）：真实 App 编排 × 真实 agent 服务 × 真实 DeepSeek/MinIO。
// 上传好的招标 docx → 建项目 → read→outline→content→review→present→export 六步全走 → 产物预签名 URL。
import { Hono } from "hono"
import { projectRoutes, STEP_ORDER } from "./src/routes/projects"
import { loginWithPhone } from "./src/services/auth"

const FILE_KEY = "uploads/e2e207/tender.docx"

const app = new Hono()
app.route("/api/projects", projectRoutes())

const phone = `+8613${Date.now().toString().slice(-9)}`
const { token } = await loginWithPhone(phone, { agreedToTerms: true }, 30, async () => true)
const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" }

const createRes = await app.request("/api/projects", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ fileKey: FILE_KEY }),
})
const { id, threadId } = (await createRes.json()) as { id: string; threadId: string }
console.log("project", id, threadId)

for (const step of STEP_ORDER) {
  const t0 = Date.now()
  console.log(`\n=== step ${step} ===`)
  const res = await app.request(`/api/projects/${id}/steps/${step}`, { method: "POST", headers: auth })
  if (res.status !== 200) throw new Error(`step ${step} http ${res.status}: ${await res.text()}`)
  const sse = await res.text() // 等 SSE 收尾（run 完成）
  const m = [...sse.matchAll(/event:\s*step\.done\s*\ndata:\s*(.+)/g)].at(-1)
  if (!m) throw new Error(`step ${step} 无 step.done：${sse.slice(-500)}`)
  const payload = JSON.parse(m[1]!) as { status: string; cost: number; result: unknown }
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(`status=${payload.status} cost=${payload.cost} ${secs}s`)
  if (payload.status !== "done") throw new Error(`step ${step} failed`)
  const r = payload.result as Record<string, unknown> | null
  if (step === "read") console.log("categories:", (r?.categories as unknown[])?.length, "riskSummary:", r?.riskSummary)
  if (step === "outline") console.log("chapters:", (r?.chapters as unknown[])?.length)
  if (step === "content") console.log("chapter ids:", Object.keys(r ?? {}).length)
  if (step === "review") console.log("score:", r?.score, "high:", r?.high, "mid:", r?.mid)
  if (step === "present") console.log("slides:", (r?.slides as unknown[])?.length, "qa:", (r?.qa as unknown[])?.length)
  if (step === "export") console.log("artifacts:", r?.artifacts)
}

for (const kind of ["docx", "pptx"] as const) {
  const res = await app.request(`/api/projects/${id}/artifacts/${kind}`, { headers: auth })
  const { url } = (await res.json()) as { url: string }
  const head = await fetch(url) // 预签名 URL 真能下
  const buf = new Uint8Array(await head.arrayBuffer())
  console.log(`${kind}: ${res.status} bytes=${buf.length} magic=${String.fromCharCode(...buf.slice(0, 2))}`)
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`${kind} 不是合法 zip`)
}

const proj = await app.request(`/api/projects/${id}`, { headers: auth })
const info = (await proj.json()) as { project: { status: string; currentStep: string }; steps: { step: string; costPoints: number }[] }
console.log("\nproject status:", info.project.status, "| steps:", info.steps.map((s) => `${s.step}:${s.costPoints}`).join(" "))
console.log("E2E OK")
process.exit(0)
