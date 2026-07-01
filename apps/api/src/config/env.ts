import { z } from "zod"

// 布尔解析：不能用 z.coerce.boolean()（它把字符串 "false" 也判为 true）。
const envBool = (def: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : v),
      z.boolean(),
    )
    .default(def)

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),

  // —— Redis（库3 + 前缀 bid:；密码含全角字符，用分离参数连接）——
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(3),
  REDIS_KEY_PREFIX: z.string().default("bid:"),

  // —— 阿里云短信 ——
  ALIYUN_SMS_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_SMS_SIGN_NAME: z.string().optional(),
  ALIYUN_SMS_TEMPLATE_CODE: z.string().optional(),

  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // —— 前端跨域白名单（逗号分隔的允许 Origin；CORS 用）——
  WEB_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),

  // —— 人机验证（滑块）：默认开启 ——
  CAPTCHA_ENABLED: envBool(true),
  ALIYUN_CAPTCHA_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_CAPTCHA_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_CAPTCHA_SCENE_ID: z.string().optional(),

  // —— 限频类防刷：各层独立开关，默认关闭（按需开启）；阈值可配 ——
  SMS_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SMS_COOLDOWN_ENABLED: envBool(false),
  SMS_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  SMS_PHONE_LIMIT_ENABLED: envBool(false),
  SMS_MAX_PER_PHONE_HOUR: z.coerce.number().int().positive().default(5),
  SMS_MAX_PER_PHONE_DAY: z.coerce.number().int().positive().default(10),
  SMS_IP_LIMIT_ENABLED: envBool(false),
  SMS_MAX_PER_IP_HOUR: z.coerce.number().int().positive().default(20),
  SMS_MAX_PER_IP_DAY: z.coerce.number().int().positive().default(50),
  SMS_ATTEMPT_LIMIT_ENABLED: envBool(false),
  SMS_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
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
