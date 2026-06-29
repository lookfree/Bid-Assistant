"use client"

import { useEffect } from "react"

/**
 * 统一的弹窗关闭快捷键：监听键盘 Escape 触发 onClose。
 * @param onClose 关闭回调
 * @param enabled 是否启用（弹窗打开时才绑定，默认 true）
 */
export function useEscapeClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose, enabled])
}
