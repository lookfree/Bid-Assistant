import { createApp } from "./app"
import { getEnv } from "./config/env"
import { pingDb } from "./db/client"

const env = getEnv()
const app = createApp({ pingDb })

export default { port: env.PORT, fetch: app.fetch }
