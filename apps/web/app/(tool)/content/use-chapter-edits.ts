"use client"

import { useRef, useState, type Dispatch, type SetStateAction } from "react"
import type { Editor as TiptapEditor } from "@tiptap/react"
import { patchErrorMessage, patchStep } from "@/lib/project"
import { imageFileToDataUrl, imageAlt, ocrDataUrl, escAttrValue } from "@/lib/image-insert"
import type { Chapter } from "./chapter-nav"

type Group = "tech" | "business"

/** 章节编辑/保存/撤销/插入（从 content/page.tsx 拆出，800 行规则）：
 *  失焦全量回写 content 步结果 + 章节级快照撤销栈 + 光标处插入（资料库条目/本地图片）。 */
export function useChapterEdits(opts: {
  isReal: boolean
  projectId: string | null
  data: Record<Group, Chapter[]>
  setData: Dispatch<SetStateAction<Record<Group, Chapter[]>>>
  editor: TiptapEditor | null
  active: Chapter
  /** AI 改写/快照回退后换 key 重挂 RichEditor（内容与撤销栈干净重置） */
  bumpEpoch: () => void
  /** 编辑器滚动容器：重挂会把滚动位置清零，替换正文后要还原（否则用户被甩回文首找不到改了哪） */
  scrollRef?: { current: HTMLElement | null }
  /** 正文发生实际变更时通知外部（导出侧据此重新按「要收费」显示，见 use-export 的 freeRerender）。
   *  不通知的话，本次会话内「导出→改正文→再导出」会一直沿用导出成功时的免费判断，
   *  界面写着「不消耗积分」而服务端照扣——静默扣费是红线。 */
  onContentChanged?: () => void
}) {
  const { isReal, projectId, data, setData, editor, active, bumpEpoch, scrollRef, onContentChanged } = opts

  /** 重挂 RichEditor 但保住滚动位置：换 key 会重建 DOM、scrollTop 归零。
   *  先记下当前位置，两帧后（新内容已挂载测量完）还原——生产反馈「改完跳到文章开头，找不到改了哪」。 */
  function bumpKeepingScroll() {
    const top = scrollRef?.current?.scrollTop ?? 0
    bumpEpoch()
    if (!top) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = scrollRef?.current
      if (!el) return
      el.scrollTop = Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight))
    }))
  }

  /* 编辑持久化状态（真实项目失焦自动全量回写 content 步结果） */
  const [contentSaveState, setContentSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [contentSaveError, setContentSaveError] = useState<string>("")

  /** 把某章正文替换进两组数据（按 id 定位，不依赖 id 前缀约定） */
  function withChapterHtml(prev: Record<Group, Chapter[]>, chapterId: string, html: string) {
    const replace = (list: Chapter[]) => list.map((c) => (c.id === chapterId ? { ...c, html } : c))
    return { tech: replace(prev.tech), business: replace(prev.business) }
  }

  /** 真实项目：把当前全部章节正文（{chapterId: html}）整份回写 content 步结果 */
  function persistContent(next: Record<Group, Chapter[]>) {
    if (!isReal || !projectId) return
    const result: Record<string, string> = {}
    for (const c of [...next.tech, ...next.business]) result[c.id] = c.html
    setContentSaveState("saving")
    patchStep(projectId, "content", result)
      .then(() => {
        setContentSaveState("saved")
        onContentChanged?.()
      })
      .catch((e: unknown) => {
        // 404 = 该步无真实 done 结果（step_not_done），精确提示
        setContentSaveError(patchErrorMessage(e))
        setContentSaveState("error")
      })
  }

  /* 章节级撤销栈（误删文字可回撤，生产反馈）：浏览器原生撤销栈在每次失焦保存（innerHTML 重设）后
     即被清空靠不住。这里每次保存/AI 改写覆盖前，把被覆盖的版本压入本章快照栈（每章封顶 20）。 */
  const historyRef = useRef<Record<string, string[]>>({})
  function pushHistory(chapterId: string, html: string) {
    const stack = (historyRef.current[chapterId] ??= [])
    stack.push(html)
    if (stack.length > 20) stack.shift()
  }

  /** 撤销（两档）：先走 TipTap 原生撤销（编辑中的细粒度回退）；原生栈见底后从章节快照栈
   *  弹出上一保存版恢复并持久化（跨保存/AI 改写的粗粒度回退,经 epoch 重挂,撤销栈干净重置）。 */
  function undoChapter() {
    if (!editor) return
    if (editor.can().undo()) {
      editor.chain().focus().undo().run()
      return
    }
    const prev = historyRef.current[active.id]?.pop()
    if (prev === undefined) return
    const next = withChapterHtml(data, active.id, prev)
    setData(next)
    persistContent(next)
    bumpKeepingScroll()
  }

  /** 失焦保存（RichEditor onBlur 吐 HTML）：无变化不回写;被覆盖版本入撤销栈。 */
  function saveEditor(html?: string) {
    const cur = html ?? editor?.getHTML()
    if (cur === undefined) return
    if (cur === active.html && contentSaveState !== "error") return
    if (cur !== active.html) pushHistory(active.id, active.html)
    const next = withChapterHtml(data, active.id, cur)
    setData(next)
    persistContent(next)
  }

  /** 单章改写完成：替换该章正文（后端已把改写结果合入 content 步结果，无需再回写）。
   *  改写覆盖前旧版入撤销栈——AI 改写不满意也能一键回退。 */
  function applyRewrite(chapterId: string, html: string) {
    setData((prev) => {
      const old = [...prev.tech, ...prev.business].find((c) => c.id === chapterId)?.html
      if (old !== undefined && old !== html) pushHistory(chapterId, old)
      return withChapterHtml(prev, chapterId, html)
    })
    bumpKeepingScroll() // 改写替换经重挂生效（见 RichEditor 文档注释），滚动位置保持不动
    onContentChanged?.()  // 改写已在服务端落库（rewrite 路由自行置脏），导出侧要同步改回「要收费」
  }

  /* 插入内容：TipTap 失焦仍保留文档内选区,insertContent 落在光标处;
     用户从未点过正文时选区停在文首（会插到视口外顶端,生产实测投诉）→ 追加到末尾并滚到位 */
  function insertAtCaret(html: string) {
    // 空章（正文未生成）根本没挂编辑器，editor 为 null——但工具栏的「从资料库插入 / 插入图片」
    // 一直可点，原来直接 return 等于点了没反应（用户反馈"资料库插入依然有问题"）。
    // 这里直接写进该章正文：写完 html 非空，编辑器随即挂载，用户就看到插入的内容。
    if (!editor) {
      const next = withChapterHtml(data, active.id, `${active.html ?? ""}${html}`)
      setData(next)
      persistContent(next)
      return
    }
    const neverFocused = !editor.view.hasFocus() && editor.state.selection.from <= 1
    const chain = editor.chain()
    ;(neverFocused ? chain.focus("end") : chain.focus()).insertContent(html).scrollIntoView().run()
    saveEditor()
  }

  /* 插入图片：选本地图 → 压缩 data URL 内嵌（原是写死占位图） */
  const imageInputRef = useRef<HTMLInputElement>(null)
  function openImagePicker() {
    imageInputRef.current?.click()
  }
  async function onImageChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // 允许连续选同一文件
    if (!file || !file.type.startsWith("image/")) return
    try {
      const dataUrl = await imageFileToDataUrl(file)
      // 识别图里的文字写进 alt：审查侧只看得到 alt（图片本身被换成占位符），
      // 只写「插图」的话，用户把营业执照放进正文、审查照样报「缺少该材料」。
      // 识别失败回空串，退化成只有文件名——不挡插图。
      const alt = escAttrValue(imageAlt(file.name, await ocrDataUrl(dataUrl)))
      insertAtCaret(`<img src="${dataUrl}" alt="${alt}" class="my-3 rounded-lg border border-border max-w-full" />`)
    } catch {
      window.alert("图片读取失败，请换一张（支持 JPG/PNG 等常见格式）")
    }
  }

  return {
    contentSaveState, contentSaveError,
    saveEditor, undoChapter, applyRewrite, insertAtCaret,
    imageInputRef, openImagePicker, onImageChosen,
  }
}
