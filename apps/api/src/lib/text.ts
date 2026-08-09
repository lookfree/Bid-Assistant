/** UTF-16 安全截断：JS 字符串按 UTF-16 code unit 切片，切点若落在代理对中间（切出的末位是
 *  高位代理 0xD800-0xDBFF），会产出一个孤立代理——JSON.stringify 把孤代理原样转义为 \uD83D，
 *  Python json.loads 照单全收，但孤代理经 httpx 编码请求体时会抛 UnicodeEncodeError，
 *  拖垮同一请求里发出的所有模型调用（2026-08-09 review campaign 实测：资料库字段/OCR 文本
 *  被裸 slice 截断，emoji 跨界即毒化正文步全链路）。回退一位保证切点不落在代理对中间——
 *  被砍掉的那个字符整体消失，好过留下半个坏字符。 */
export function sliceAtCodePoint(s: string, n: number): string {
  if (n <= 0) return ""
  if (n >= s.length) return s
  const atCut = s.charCodeAt(n - 1)
  const end = atCut >= 0xd800 && atCut <= 0xdbff ? n - 1 : n
  return s.slice(0, end)
}
