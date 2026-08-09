"use client"

import { useEffect, useState } from "react"
import { fileDownloadUrl } from "@/lib/files"
import { placeholderFileIds, appendixStale, noCredentialsNoticeVisible, SYS_CREDS_ID } from "@/lib/credentials-appendix"
import { refreshCredentialsAppendix, type ExportPreview } from "@/lib/project"
import { ApiError } from "@/lib/api-client"
import type { Chapter } from "./chapter-nav"

const IMG_TAG_RE = /<img\b[^>]*>/gi
const DATA_FILE_ID_RE = /data-file-id\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const HAS_SRC_RE = /\bsrc\s*=/i

/** 附录占位图 → 现取的预签名地址（Task 5；终审 I-1 起对所有章节生效——Task 4 的资质定向注入
 *  post-pass 会把同一种无 src 占位图 <img data-file-id> 插进普通章节，不止 sys-creds 附录章，
 *  "三端同源"要求编辑器不能对着占位图裂图）。拆出这段是为了让 useCredentialsAppendix 收在
 *  80 行内——行为不变，既有测试覆盖不动。 */
function useResolvedCredentialSrc(html: string) {
  // fileId → 现取的预签名下载地址，取到就一直缓存到本组件卸载（预签名有效期远长于一次编辑
  // 会话；过期也无所谓，见 lib/credentials-appendix.ts 顶部注释，用户重新打开正文页会再取一遍）。
  // 值为 null = 取过但失败（文件已被删/网络错）——必须仍然记一个键：不记的话这个 id 会被
  // pendingIds 永远当"还没取"，一张坏图就把整章的加载态卡死，其余图也一起显示不出来。
  const [srcMap, setSrcMap] = useState<Record<string, string | null>>({})
  const pendingIds = placeholderFileIds(html).filter((id) => !(id in srcMap))
  const pendingKey = pendingIds.join(",")

  useEffect(() => {
    if (!pendingKey) return
    const ids = pendingKey.split(",")
    let cancelled = false
    Promise.all(ids.map(async (id) => [id, await fileDownloadUrl(id).catch(() => null)] as const)).then((pairs) => {
      if (cancelled) return
      setSrcMap((prev) => {
        const next = { ...prev }
        for (const [id, url] of pairs) next[id] = url // 失败也写 null，标记"已尝试"
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // pendingKey 已经是 pendingIds 的去重字符串化，比较它足以判断"要不要发新一轮请求"，
    // 不需要把 pendingIds 数组本身（每次渲染新引用）也放进依赖，否则会陷入渲染死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey])

  /** 把已取到的预签名地址现填进占位图 src（原始 HTML 不动，只在喂给编辑器前现填）；
   *  还没取到 URL 的、已经带 src 的（用户编辑过或本来就是普通插图）原样跳过——对所有章节生效。 */
  function withResolvedSrc(htmlIn: string): string {
    return htmlIn.replace(IMG_TAG_RE, (tag) => {
      if (HAS_SRC_RE.test(tag)) return tag
      const m = DATA_FILE_ID_RE.exec(tag)
      const id = m?.[1] ?? m?.[2]
      const url = id ? srcMap[id] : undefined
      return url ? tag.replace(/<img\b/i, `<img src="${url}"`) : tag
    })
  }

  return { pendingResolve: pendingIds.length > 0, withResolvedSrc }
}

/** 「资格证明文件」附录章占位图解析 + 过期提示（2026-08-09 附录系统章节 Task 5）：
 *  服务端存的是无 src 的占位图 <img data-file-id data-object-key>，编辑器现取预签名地址
 *  才能显示；资料库改过而附录章还是生成那一刻的旧快照时，给一条可一键刷新的横条。
 *  占位图解析对所有章节生效（终审 I-1：Task 4 post-pass 会把这种占位图插进普通章节）；
 *  过期提示/刷新仍只对 sys-creds 章生效——其余章节没有"整章重建"这个概念。 */
export function useCredentialsAppendix(opts: {
  active: Chapter
  preview: ExportPreview | null
  projectId: string | null
  /** 刷新成功后替换该章 HTML（复用 use-chapter-edits 的 applyRewrite：换 key 重挂 + 撤销栈
   *  入历史 + 通知导出侧内容已变——刷新端点与单章改写在服务端走同一条置脏路径，语义相同）。 */
  applyRefresh: (chapterId: string, html: string) => void
}) {
  const { active, preview, projectId, applyRefresh } = opts
  const isSysCreds = active.id === SYS_CREDS_ID

  const { pendingResolve, withResolvedSrc } = useResolvedCredentialSrc(active.html)

  // 过期判定：sys-creds 章存在（active 就是它）且 export-preview 已到手时，比对章内占位图集合
  // 与资料库现存资质图片集合。preview 还没到手（首屏未加载完）时按"未过期"处理，不误报。
  const stale = isSysCreds && preview ? appendixStale(placeholderFileIds(active.html), preview.credential_file_ids) : false

  const [refreshing, setRefreshing] = useState(false)
  // 刷新遇 409 no_credentials（资料库资质条目已清零，2026-08-09 终审 I1）：这种失败点一次
  // 「刷新」解决不了，重试只会再 409——过期横条继续说"过期，点击刷新"会把用户晾在死循环里。
  // 换成一次性提示 + 手动删附录章的引导；下一次刷新前先清掉，不让陈旧提示挂着不走。
  const [noCredentialsNotice, setNoCredentialsNotice] = useState(false)
  // 切章即失效（终审复审实证）：这个 state 此前跟 active.id 完全脱钩——409 提示会挂到切走
  // 后的任意无关章顶上，且切回附录章也不消失（不再是"一次性"）。active.id 一变就清空；
  // 是否显示再叠加 isSysCreds 守卫（见 noCredentialsNoticeVisible），两道一起堵。
  useEffect(() => {
    setNoCredentialsNotice(false)
  }, [active.id])
  /** 点「刷新附录」：调 Task 4 的免费重建端点，成功就地替换该章 HTML；409 content_not_done/
   *  404 静默收起（点一下解决不了，不值得弹窗打断）；409 no_credentials 转成一次性提示。 */
  async function refreshAppendix() {
    if (!projectId || refreshing) return
    setRefreshing(true)
    setNoCredentialsNotice(false)
    try {
      const { html } = await refreshCredentialsAppendix(projectId)
      applyRefresh(SYS_CREDS_ID, html)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "no_credentials") {
        setNoCredentialsNotice(true)
      } else if (!(e instanceof ApiError && (e.status === 409 || e.status === 404))) {
        console.warn("[credentials-appendix] 刷新失败:", e)
      }
    } finally {
      setRefreshing(false)
    }
  }

  return {
    /** true 时附录章还有占位图没现取到 src——调用方应先展示加载态，别把 TipTap 喂给它
     *  （无 src 的 <img> 不会被识别为图片节点，会被静默丢弃且无法再补回）。 */
    pendingResolve,
    withResolvedSrc,
    stale,
    refreshing,
    noCredentialsNotice: noCredentialsNoticeVisible(noCredentialsNotice, isSysCreds),
    dismissNoCredentialsNotice: () => setNoCredentialsNotice(false),
    refreshAppendix,
  }
}
