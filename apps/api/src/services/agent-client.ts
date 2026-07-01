import { getEnv } from "../config/env"

// 封装 Agent Service 的 run 契约（spec104）。App 对 agent 内部无知，只发 {agent_type, thread_id, input}。
// base_url 走惰性 getEnv（AGENT_BASE_URL），import 无副作用。

export async function createRun(opts: { agentType: string; threadId: string; input: unknown }) {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/agents/${opts.agentType}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread_id: opts.threadId, input: opts.input }),
  })
  if (!r.ok) throw new Error(`agent createRun ${r.status}`)
  return (await r.json()) as { run_id: string }
}

export async function* relayStream(runId: string): AsyncGenerator<string> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}/stream`)
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield dec.decode(value) // 透传 SSE 分片给前端
  }
}

export async function getRun(runId: string) {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}`)
  return (await r.json()) as { status: string; result?: unknown }
}

export type AgentClient = {
  createRun: typeof createRun
  relayStream: typeof relayStream
  getRun: typeof getRun
}
