/** 测试用等待（真实计时器；cron 系列测试共用）。 */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
