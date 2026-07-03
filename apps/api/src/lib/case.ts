// agent（Python）产出 snake_case，前端原型读 camelCase（isNew/chapterTitle/clauseIds…）。
// App 层在返前端前递归转换 key（值原样保留），前端可直接复用原型 TS 类型。

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// 递归把对象/数组里所有 key 由 snake_case 转 camelCase。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCamel<T = any>(input: unknown): T {
  if (Array.isArray(input)) return input.map((v) => toCamel(v)) as T
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[snakeToCamel(k)] = toCamel(v)
    }
    return out as T
  }
  return input as T
}
