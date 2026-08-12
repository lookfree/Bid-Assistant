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

const KEY = "bid.uploading"
// 过期兜底：硬刷新会杀掉在途请求，标记却留在 sessionStorage 里，不设上限用户会永远卡在
// 进行中态。传 5 份大文件按客户网络（实测 21–75KB/s）算，15 分钟足够宽。
const STALE_MS = 15 * 60 * 1000

type Mark = { page: string; at: number }

/** 开始上传：记下是哪个页面在传。 */
export function markUploading(page: string): void {
  if (typeof window === "undefined") return
  sessionStorage.setItem(KEY, JSON.stringify({ page, at: Date.now() } satisfies Mark))
}

/** 结束（成功或失败都要调，否则用户卡在进行中态）。 */
export function clearUploading(): void {
  if (typeof window === "undefined") return
  sessionStorage.removeItem(KEY)
}

/** 该页当前是否有在途上传。过期的标记顺手清掉，不留给下一次误判。 */
export function isUploading(page: string): boolean {
  if (typeof window === "undefined") return false
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return false
  let mark: Mark
  try {
    mark = JSON.parse(raw) as Mark
  } catch {
    clearUploading()
    return false
  }
  if (!mark.at || Date.now() - mark.at > STALE_MS) {
    clearUploading()
    return false
  }
  return mark.page === page
}
