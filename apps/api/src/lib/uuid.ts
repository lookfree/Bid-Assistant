import { z } from "zod"

// 路径参数 :id 非 uuid 时 PG 会直接抛 22P02（invalid input syntax）→ 500。
// 各路由统一先用它前置校验，非 uuid 与「不存在」同语义返回 404。
export const isUuid = (s: string) => z.string().uuid().safeParse(s).success
