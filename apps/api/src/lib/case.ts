// agent（Python）产出 snake_case，前端原型读 camelCase（isNew/chapterTitle/clauseIds…）。
// App 层在返前端前递归转换 key（值原样保留），前端可直接复用原型 TS 类型。

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

// 递归把对象/数组里所有 key 由 snake_case 转 camelCase。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCamel<T = any>(input: unknown): T {
  if (Array.isArray(input)) return input.map((v) => toCamel(v)) as T
  const proto = input && typeof input === "object" ? Object.getPrototypeOf(input) : undefined
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[snakeToCamel(k)] = toCamel(v)
    }
    return out as T
  }
  return input as T
}

// toCamel 的逆向：前端编辑回写（camelCase）落库前递归转回 snake_case（DB 与 agent 契约都是 snake 原样）。
// 已是 snake 的 key 无大写字母 → 原样返回（幂等）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toSnake<T = any>(input: unknown): T {
  if (Array.isArray(input)) return input.map((v) => toSnake(v)) as T
  const proto = input && typeof input === "object" ? Object.getPrototypeOf(input) : undefined
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[camelToSnake(k)] = toSnake(v)
    }
    return out as T
  }
  return input as T
}
