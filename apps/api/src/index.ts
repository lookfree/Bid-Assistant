import { createApp } from "./app"
import { getEnv } from "./config/env"
import { pingDb, closeDb } from "./db/client"

const env = getEnv()
const app = createApp({ pingDb })

// 优雅关闭：归还 DB 连接池，避免重启/热重载累积泄漏连接。
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void closeDb().finally(() => process.exit(0))
  })
}

export default { port: env.PORT, fetch: app.fetch }
