"use client"

// 「线下标书正在上传并创建」的跨页标记。
//
// 为什么需要：上传是页面组件里的一段 async，切菜单（next/link 客户端跳转）会把组件卸载，
// 但那段 async **照样跑完**——文件传完、项目建好。用户看到的却是：上传界面凭空消失，
// 没有任何"还在传"的痕迹，直到它突然完成。2026-08-12 用户实测反馈。
//
// 真正的危险不是看不见，而是**切回来时面板重新挂载成一张空表单**：用户以为没传成功，
// 很可能再传一遍，建出重复项目，后面每一步都重复扣费。所以标记在时一律渲染进行中态，
// 不给那张空表单出现的机会。

// 一页一个槽：单槽的话，述标那边开一笔上传会把审查那笔的标记覆盖掉，
// 谁先传完谁的 clearUploading 又把另一笔的抹了。
const keyOf = (page: string) => `bid.uploading:${page}`
// 过期兜底：硬刷新会杀掉在途请求，标记却留在 sessionStorage 里，不设上限用户会永远卡在
// 进行中态。传 5 份大文件按客户网络（实测 21–75KB/s）算，15 分钟足够宽。
const STALE_MS = 15 * 60 * 1000

type Mark = { page: string; at: number }

/** 开始上传：记下是哪个页面在传。 */
export function markUploading(page: string): void {
  if (typeof window === "undefined") return
  sessionStorage.setItem(keyOf(page), JSON.stringify({ page, at: Date.now() } satisfies Mark))
  // 整页跳转/刷新/关标签 = 文档被拆掉，在途请求当场死掉，标记必须跟着消失。
  // 少了这一句，面板里那个「从我的标书选择」（它是 window.location.href 硬跳）就会留下一个
  // 死标记，把整个废标审查页——包括已经生成好的报告——挡上 15 分钟（2026-08-12 评审实证）。
  // 切菜单走的是 next/link 客户端路由，**不触发 pagehide**，那种情况上传还活着，标记正该留着。
  window.addEventListener("pagehide", () => clearUploading(page), { once: true })
}

/** 结束（成功或失败都要调，否则用户卡在进行中态）。 */
export function clearUploading(page: string): void {
  if (typeof window === "undefined") return
  sessionStorage.removeItem(keyOf(page))
}

/** 该页当前是否有在途上传。过期的标记顺手清掉，不留给下一次误判。 */
export function isUploading(page: string): boolean {
  if (typeof window === "undefined") return false
  const raw = sessionStorage.getItem(keyOf(page))
  if (!raw) return false
  let mark: Mark
  try {
    mark = JSON.parse(raw) as Mark
  } catch {
    clearUploading(page)
    return false
  }
  if (!mark.at || Date.now() - mark.at > STALE_MS) {
    clearUploading(page)
    return false
  }
  return true
}
