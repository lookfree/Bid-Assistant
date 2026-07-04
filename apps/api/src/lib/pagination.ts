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

/** 分页查询收尾：并行取「本页行」+「总数」，统一成 { items, total }（消除各处 Promise.all + Number(cnt!.n) 样板）。 */
export async function pagedResult<T>(
  itemsQuery: PromiseLike<T[]>,
  countQuery: PromiseLike<{ n: number }[]>,
): Promise<{ items: T[]; total: number }> {
  const [items, [cnt]] = await Promise.all([itemsQuery, countQuery])
  return { items, total: Number(cnt?.n ?? 0) }
}

/** 统一分页响应体：{ items, page, pageSize, total, hasMore }（hasMore = 本页尾未达总数）。 */
export function pagedBody<T>(
  p: { page: number; pageSize: number; offset: number },
  r: { items: T[]; total: number },
): { items: T[]; page: number; pageSize: number; total: number; hasMore: boolean } {
  return { items: r.items, page: p.page, pageSize: p.pageSize, total: r.total, hasMore: p.offset + r.items.length < r.total }
}
