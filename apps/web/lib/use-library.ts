"use client"

import { useCallback, useEffect, useState } from "react"
import { listEntries, type LibraryEntry } from "./library-api"

// 模块级缓存（与 use-membership 的 cachedOverview 同法）：跨页面/弹层复用上次结果,
// 再次进入先渲染缓存（不闪加载骨架）,后台静默刷新校准——资料库页与「从资料库插入」
// 选择器共用,曾经每次挂载都全量重拉 + 必闪 loading。
let cachedItems: LibraryEntry[] | null = null

// 资料库数据源 hook：挂载时拉 GET /api/library，供资料库页与「从资料库插入」选择器共用。
export function useLibrary() {
  const [items, setItems] = useState<LibraryEntry[]>(cachedItems ?? [])
  const [loading, setLoading] = useState(cachedItems === null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    setError(null)
    try {
      const list = await listEntries()
      cachedItems = list
      setItems(list)
    } catch {
      if (!opts.silent) setError("资料库加载失败，请重试") // 静默刷新失败保留已展示数据
    } finally {
      if (!opts.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 有缓存 → 已即时渲染,后台静默校准;无缓存 → 正常加载态
    void reload({ silent: cachedItems !== null })
  }, [reload])

  // 变更入口（上传/删除）会调 reload 或 setItems——同步回模块缓存,别的页面下次秒开也拿到新列表
  const setItemsCached = useCallback((updater: React.SetStateAction<LibraryEntry[]>) => {
    setItems((prev) => {
      const next = typeof updater === "function" ? (updater as (p: LibraryEntry[]) => LibraryEntry[])(prev) : updater
      cachedItems = next
      return next
    })
  }, [])

  return { items, setItems: setItemsCached, loading, error, reload }
}
