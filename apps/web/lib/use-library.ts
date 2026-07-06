"use client"

import { useCallback, useEffect, useState } from "react"
import { listEntries, type LibraryEntry } from "./library-api"

// 资料库数据源 hook：挂载时拉 GET /api/library，供资料库页与「从资料库插入」选择器共用。
export function useLibrary() {
  const [items, setItems] = useState<LibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await listEntries())
    } catch {
      setError("资料库加载失败，请重试")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, setItems, loading, error, reload }
}
