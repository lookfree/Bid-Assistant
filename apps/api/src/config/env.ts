import { z } from "zod"

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
})

export type Env = z.infer<typeof schema>

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => i.path.join(".") + " " + i.message)
      .join("; ")
    throw new Error(`环境变量校验失败: ${detail}`)
  }
  return parsed.data
}

// 惰性单例：只在首次被消费者调用时校验 process.env，避免 import 副作用（测试可只用 parseEnv）。
let cached: Env | undefined
export function getEnv(): Env {
  return (cached ??= parseEnv())
}
