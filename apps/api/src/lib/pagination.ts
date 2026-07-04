import { z } from "zod"

// 分页规范（spec308）：page 从 1 起，pageSize 默认 20、上限 100（超出截断而非报错，避免前端传大值即 400）。
// page 非法（0/负/非数字）→ 抛 ZodError，路由层转 400。
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().default(20).transform((n) => Math.min(n, 100)),
})

export function parsePagination(query: Record<string, string | undefined>): {
  page: number
  pageSize: number
  offset: number
} {
  const { page, pageSize } = paginationSchema.parse(query)
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** 统一分页响应体：{ items, page, pageSize, total, hasMore }（hasMore = 本页尾未达总数）。 */
export function pagedBody<T>(
  p: { page: number; pageSize: number; offset: number },
  r: { items: T[]; total: number },
): { items: T[]; page: number; pageSize: number; total: number; hasMore: boolean } {
  return { items: r.items, page: p.page, pageSize: p.pageSize, total: r.total, hasMore: p.offset + r.items.length < r.total }
}
