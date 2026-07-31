import type { Step } from "./step-finalize"

// 步结果形状守卫（2026-07-31 生产事故）：App 此前拿到 agent 的 run 结果就无条件写进步位行，
// 不管里面是什么。present→export 是静态边，检查点停在 present 之后时续跑会越界跑 export，
// agent 上报「本次跑过的最后一个节点」的结果 → export 的产物快照 {pdf,docx,pptx,pdfPages}
// 被当成 present 步结果落库，盖住真 deck；前端 realDeck.slides 成 undefined → 述标页整页崩，
// 而这一步还被标成 done、净扣 80 积分——用户付了钱、什么都没拿到、也不知道为什么。
//
// 图的静态边已改条件边，但根因不该只堵在一处：**跑出来的东西对不对，落库前必须自己判**。
// 形状不符 = 这一步没成功 → 走失败分支（全额退款 + status=failed），符合「失败必退」铁律。
//
// 判据只取「这一步的下游真正依赖的那个字段」，宽松到不会误杀合法结果：
// 多几个键、少几个可选键都放行，只有连主干字段都没有才判失败。

/** 该步结果里必须存在的主干字段；不在表内的步骤不做形状校验（宽进）。 */
const REQUIRED: Partial<Record<Step, (r: Record<string, unknown>) => boolean>> = {
  // 述标：下游（前端编辑器/渲染器）全靠 slides
  present: (r) => Array.isArray(r.slides),
  // 提纲：chapters 是正文生成的输入
  outline: (r) => Array.isArray(r.chapters),
  // 读标：categories 是所有后续步骤的依据
  read: (r) => Array.isArray(r.categories),
  // 导出：至少要有一个产物 key，否则下载侧拿不到东西
  export: (r) => typeof r.docx === "string" || typeof r.pptx === "string",
}

/**
 * 这一步的结果形状对不对。
 * null/非对象一律不合格（除 content 外——content 的 result 是 {章id: html} 自由字典，
 * 键名由模型决定，无法按固定字段判，只要求是非空对象）。
 */
export function resultShapeOk(step: Step, result: unknown): boolean {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return false
  const obj = result as Record<string, unknown>
  if (step === "content") return Object.keys(obj).length > 0
  const check = REQUIRED[step]
  return check ? check(obj) : true
}

/** 给用户看的失败原因：说清是「这一步没产出该产的东西」，而不是含糊的“生成失败”。 */
export const SHAPE_MISMATCH_ERROR = "step_result_shape_mismatch"
