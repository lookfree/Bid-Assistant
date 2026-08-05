// 上传文件的文件头（魔数）校验：扩展名对、内容不对的文件在上传确认这一步就拦掉，不进后续流程。
//
// 2026-08-05 生产实测：一份 7.6MB 的 .pdf 文件头是 `%TSD-Header-###%`、无 `%%EOF`——被文档透明加密
// （DLP）软件整体封装成了密文。它一路走到读标才失败，pypdf 报「流意外结束」，读标据此降级到
// 「让模型自己调 parse_document」的兜底路径，烧掉四轮 token 后抛出「模型未通过 submit_read_result
// 提交结构化结果」——一个文件问题被报成了模型问题，用户与排查方向全被带偏。

/** 已知的文档透明加密软件封装头。命中即密文，扩展名不再代表内容。 */
export const TSD_WRAPPER_HEADER = "%TSD-Header-###%"

const enc = (s: string) => new TextEncoder().encode(s)

const ENCRYPTED_WRAPPERS: ReadonlyArray<Uint8Array> = [enc(TSD_WRAPPER_HEADER)]

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // OOXML 都是 ZIP 容器
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff])

// 扩展名 → 必须出现在文件头部的魔数。只列魔数无歧义的格式：
// doc/xls 故意不列——.doc 里装 RTF、装 docx 都是历史常见写法，agent 侧靠 LibreOffice 照样能转，
// 在这里强判会误伤本来能用的文件。它们仍受上面的封装头检查保护。
const REQUIRED_MAGIC: Record<string, Uint8Array> = {
  pdf: enc("%PDF-"),
  docx: ZIP,
  xlsx: ZIP,
  pptx: ZIP,
  potx: ZIP,
  png: PNG,
  jpg: JPEG,
  jpeg: JPEG,
}

/** 校验的取样长度：PDF 规范容忍文件头前有少量前导字节，故在头部一段范围内找而不是要求偏移 0。 */
export const MAGIC_SAMPLE_BYTES = 1024

/** 只回判定与原因码——面向用户的中文文案统一在 web 的 uploadErrorMessage 里，不在这儿再存一份。 */
export type MagicVerdict = { ok: true } | { ok: false; code: "encrypted_wrapper" | "content_mismatch" }

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * 按扩展名校验文件头。`head` 传对象开头的一段字节（见 MAGIC_SAMPLE_BYTES）。
 * 白名单之外的扩展名一律放行——支持类型在 files.ts 的 SUPPORTED_EXTS 把关，这里不重复也不误伤。
 */
export function checkFileMagic(head: Uint8Array, ext: string): MagicVerdict {
  for (const sig of ENCRYPTED_WRAPPERS) {
    if (indexOfBytes(head.subarray(0, sig.length), sig) === 0) {
      return { ok: false, code: "encrypted_wrapper" }
    }
  }
  const magic = REQUIRED_MAGIC[ext]
  if (magic && indexOfBytes(head, magic) < 0) {
    return { ok: false, code: "content_mismatch" }
  }
  return { ok: true }
}
