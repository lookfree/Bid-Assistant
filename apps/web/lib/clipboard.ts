// 复制文本（共享工具）：HTTP 非安全上下文下 navigator.clipboard 不存在（本环境走公网 HTTP），
// 须降级 execCommand；降级路径 try/finally 保证临时 textarea 必被移除、异常不外抛（返回 false）。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 继续走降级
  }
  const ta = document.createElement("textarea")
  ta.value = text
  ta.style.position = "fixed"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  try {
    ta.select()
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    ta.remove()
  }
}
