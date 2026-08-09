// 「资格证明文件」附录系统章节（2026-08-09 附录系统章节设计 Plan A①）——web 侧纯函数。
// 章 HTML 里的占位图只带 data-file-id/data-object-key/alt 三个属性、无 src 无字节（App/agent
// 两端 buildCredentialsChapterHtml 同形产出）；这里只负责「抠出图引用了哪些文件」与
// 「跟资料库现状比对是否过期」，不碰网络、不碰 DOM——解析预签名 URL 填 src 是另一层接线的事。

/** 系统章 id，与 App(credentials-chapter.ts)/agent(credentials_chapter.py) 两端字面量同形。 */
export const SYS_CREDS_ID = "sys-creds"

// 逐个匹配 <img ...> 标签，标签内部再抠 data-file-id 属性值——不依赖属性顺序（TipTap 保存后
// 会重排属性）、不依赖引号风格（单/双引号都认）。
const IMG_TAG_RE = /<img\b[^>]*>/gi
const DATA_FILE_ID_RE = /data-file-id\s*=\s*(?:"([^"]*)"|'([^']*)')/i

/** 抠出章节 HTML 里全部占位图的 data-file-id（不论 src 是否已解析出来）——供过期比对用，
 *  给的是「这份章节引用了资料库哪些文件」，与图片当前是否已经现取过预签名地址无关。 */
export function placeholderFileIds(html: string): string[] {
  const ids: string[] = []
  for (const tag of html.match(IMG_TAG_RE) ?? []) {
    const m = DATA_FILE_ID_RE.exec(tag)
    const id = m?.[1] ?? m?.[2]
    if (id) ids.push(id)
  }
  return ids
}

/** 附录是否过期：章节里引用的资质图片集合与资料库现存资质图片集合不同即过期——集合语义，
 *  元素相同、顺序不同不算过期；用户在资料库里加/删一张证照，附录章仍是生成那一刻的旧快照
 *  才判过期。 */
export function appendixStale(chapterFileIds: string[], libraryFileIds: string[]): boolean {
  const a = new Set(chapterFileIds)
  const b = new Set(libraryFileIds)
  if (a.size !== b.size) return true
  for (const id of a) if (!b.has(id)) return true
  return false
}
