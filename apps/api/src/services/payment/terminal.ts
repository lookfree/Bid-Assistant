import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { eq } from "drizzle-orm"
import { getDb } from "../../db/client"
import { paymentTerminals } from "../../db/schema"
import { sqbPost, type GatewayJson } from "./gateway"
import type { CronJob } from "../cron"

// 收钱吧终端凭证生命周期（架构 §6.0）：激活码+device_id → 激活得 terminal_sn/terminal_key（落库，集群共享）
// → 每日签到轮换 terminal_key。terminal_key 加密落库（AES-256-GCM，密钥走 env）；签到失败保留旧 key。
// 端点路径以收钱吧线上文档为准（doc.shouqianba.com「激活」「签到」），Task 4 真实冒烟校验。

export type SqbTerminalConfig = {
  gateway: string // https://vsi-api.shouqianba.com
  vendorSn: string // 服务商序列号（仅激活用）
  vendorKey: string // 服务商密钥（仅激活用）
  appId: string
  activationCode: string // 测试/生产激活码
  deviceId: string // 自定义设备号（集群共享一个终端身份）
  keySecret: string // terminal_key 落库加密密钥（env TERMINAL_KEY_SECRET）
}

// —— terminal_key 落库加解密（AES-256-GCM；格式 iv.tag.cipher 均 hex）——
// crypto 的二进制入参统一转 Uint8Array（@types/node Buffer 与本项目 TS lib 的迭代器类型不合），
// 密文进出走 hex 字符串编码 API，避开 Buffer.concat。
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"))

function aesKey(secret: string): Uint8Array {
  // scrypt（非裸哈希）：TERMINAL_KEY_SECRET 熵不足或部分泄漏时，离线爆破每次猜测都要付 KDF 成本
  return new Uint8Array(scryptSync(secret, "bidsaas:terminal-key:v1", 32))
}

function encryptKey(plain: string, secret: string): string {
  const iv = randomBytes(12).toString("hex")
  const cipher = createCipheriv("aes-256-gcm", aesKey(secret), fromHex(iv))
  const data = cipher.update(plain, "utf8", "hex") + cipher.final("hex")
  return [iv, cipher.getAuthTag().toString("hex"), data].join(".")
}

function decryptKey(stored: string, secret: string): string {
  const [iv, tag, data] = stored.split(".")
  if (!iv || !tag || !data) throw new Error("terminal_key 密文格式非法")
  const decipher = createDecipheriv("aes-256-gcm", aesKey(secret), fromHex(iv))
  decipher.setAuthTag(fromHex(tag))
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8")
}

export function makeTerminalService(cfg: SqbTerminalConfig, fetchFn: typeof fetch = fetch) {
  /** 激活/签到 POST：业务失败/网络异常抛错（调用方决定重试）。 */
  async function post(path: string, payload: Record<string, string>, sn: string, key: string): Promise<GatewayJson> {
    const json = await sqbPost(fetchFn, cfg.gateway, path, payload, sn, key)
    if (json.result_code !== "200") {
      throw new Error(`收钱吧网关失败 ${path}: ${json.result_code ?? "无业务码"} ${json.error_message ?? ""}`)
    }
    return json
  }

  async function loadRow() {
    const [row] = await getDb().select().from(paymentTerminals).where(eq(paymentTerminals.deviceId, cfg.deviceId))
    if (!row) throw new Error(`收钱吧终端未激活（device_id=${cfg.deviceId}），先跑 activate()`)
    return row
  }

  return {
    /** 激活：vendor 参数签名，成功后 terminal_sn/terminal_key（加密）落库；重复激活覆盖旧凭证。 */
    async activate(): Promise<string> {
      const json = await post(
        "/terminal/activate",
        { app_id: cfg.appId, code: cfg.activationCode, device_id: cfg.deviceId },
        cfg.vendorSn,
        cfg.vendorKey,
      )
      const { terminal_sn: sn, terminal_key: key } = json.biz_response ?? {}
      if (!sn || !key) throw new Error("激活响应缺 terminal_sn/terminal_key")
      const encrypted = encryptKey(key, cfg.keySecret)
      await getDb()
        .insert(paymentTerminals)
        .values({ terminalSn: sn, terminalKey: encrypted, deviceId: cfg.deviceId })
        .onConflictDoUpdate({ target: paymentTerminals.deviceId, set: { terminalSn: sn, terminalKey: encrypted, activatedAt: new Date() } })
      return sn
    },

    /** 每日签到：terminal 参数（当前 key）签名，成功才写入轮换后的 key + last_checkin_at；失败抛错、不动旧 key。 */
    async checkin(): Promise<void> {
      const row = await loadRow()
      const currentKey = decryptKey(row.terminalKey, cfg.keySecret)
      const json = await post("/terminal/checkin", { terminal_sn: row.terminalSn, device_id: cfg.deviceId }, row.terminalSn, currentKey)
      const rotated = json.biz_response?.terminal_key ?? currentKey // 网关可能不轮换，沿用当前 key
      await getDb()
        .update(paymentTerminals)
        .set({ terminalKey: encryptKey(rotated, cfg.keySecret), lastCheckinAt: new Date() })
        .where(eq(paymentTerminals.id, row.id))
    },

    /** 取解密后的终端凭证（provider 拼签名用）。 */
    async getCredentials(): Promise<{ terminalSn: string; terminalKey: string }> {
      const row = await loadRow()
      return { terminalSn: row.terminalSn, terminalKey: decryptKey(row.terminalKey, cfg.keySecret) }
    },
  }
}

export type TerminalService = ReturnType<typeof makeTerminalService>

/** 每日签到 CronJob（spec303 startCronRunner 注册；锁内执行，集群单实例签到）。 */
export function sqbCheckinJob(svc: TerminalService): CronJob {
  return { name: "sqb-checkin", everyMs: 24 * 60 * 60 * 1000, jobFn: () => svc.checkin() }
}
