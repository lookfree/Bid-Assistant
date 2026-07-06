"use client"

import { useState } from "react"
import { currentProjectId } from "./project"

const KEY = "bid.demo"

/** 退出示例体验：清除跨页 demo 标记（read 页「退出示例」等入口调用）。 */
export function clearDemoMode(): void {
  if (typeof window !== "undefined") sessionStorage.removeItem(KEY)
}

/**
 * 示例（demo）模式判定，read/outline/content/present 四个工具页共用：
 * - 有真实项目（localStorage bid.projectId）→ 永远 false，并顺手清除 demo 标记（真实项目优先）；
 * - URL 带 ?demo=1（上传页「示例体验」入口）→ true，写 sessionStorage 使 demo 跨页保持；
 * - 否则读 sessionStorage 里的跨页标记。
 * 只有 demo 模式允许渲染 lib/sample-bid.ts / lib/present.ts 的示例内容。
 */
export function useDemoMode(): boolean {
  const [isDemo] = useState(() => {
    if (typeof window === "undefined") return false
    if (currentProjectId()) {
      sessionStorage.removeItem(KEY)
      return false
    }
    if (new URLSearchParams(window.location.search).get("demo") === "1") {
      sessionStorage.setItem(KEY, "1")
      return true
    }
    return sessionStorage.getItem(KEY) === "1"
  })
  return isDemo
}
