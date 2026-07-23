import Dm, { SingleSendMailRequest } from "@alicloud/dm20151123"
import { Config as OpenApiConfig } from "@alicloud/openapi-client"
import { getEnv, type Env } from "../config/env"

// 发票开具邮件（spec332 · 阿里云 DirectMail）。凭据缺失自动回退 Fake（不真发），与短信同款降级。
export interface InvoiceEmailData {
  to: string
  title: string // 发票抬头
  invoiceNo: string
  amountCents: number
  fileUrl?: string | null
}

export interface EmailSender {
  sendInvoiceIssued(data: InvoiceEmailData): Promise<void>
}

// 开发/未配置期：不真发，打印到控制台。
export class FakeEmailSender implements EmailSender {
  async sendInvoiceIssued(d: InvoiceEmailData): Promise<void> {
    console.log(`[FakeEmail] 发票开具通知 -> ${d.to} 发票号=${d.invoiceNo} 金额=¥${(d.amountCents / 100).toFixed(2)}`)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)
}

// 邮件正文（HTML）：抬头/发票号/金额 + 下载链接（无链接则引导站内查看）。
function invoiceHtml(d: InvoiceEmailData): string {
  const amount = `¥${(d.amountCents / 100).toFixed(2)}`
  const download = d.fileUrl
    ? `<p>电子发票下载：<a href="${escapeHtml(d.fileUrl)}">${escapeHtml(d.fileUrl)}</a></p>`
    : `<p>如需电子发票文件，请登录会员中心「我的发票」查看，或联系客服。</p>`
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">
    <p>您好，</p>
    <p>您申请的发票已开具，详情如下：</p>
    <p>发票抬头：${escapeHtml(d.title)}<br/>发票号码：${escapeHtml(d.invoiceNo)}<br/>开票金额：${amount}</p>
    ${download}
    <p style="color:#888;font-size:12px">本邮件由系统自动发送，请勿直接回复。</p>
  </div>`
}

export class AliyunEmailSender implements EmailSender {
  private client: Dm
  constructor(
    private cfg: { accessKeyId: string; accessKeySecret: string; accountName: string; fromAlias?: string; endpoint: string },
  ) {
    this.client = new Dm(
      new OpenApiConfig({ accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, endpoint: cfg.endpoint }),
    )
  }
  async sendInvoiceIssued(d: InvoiceEmailData): Promise<void> {
    const req = new SingleSendMailRequest({
      accountName: this.cfg.accountName, // 已验证的发信地址
      addressType: 1, // 1=使用发信地址
      replyToAddress: false,
      toAddress: d.to,
      subject: "【智启元】您申请的发票已开具",
      htmlBody: invoiceHtml(d),
      fromAlias: this.cfg.fromAlias,
    })
    const res = await this.client.singleSendMail(req)
    if (!res.body?.requestId) throw new Error("DirectMail 未返回 requestId（发送可能失败）")
  }
}

export function createEmailSender(env: Env): EmailSender {
  const id = env.ALIYUN_DM_ACCESS_KEY_ID
  const secret = env.ALIYUN_DM_ACCESS_KEY_SECRET
  const accountName = env.ALIYUN_DM_ACCOUNT_NAME
  if (id && secret && accountName) {
    return new AliyunEmailSender({ accessKeyId: id, accessKeySecret: secret, accountName, fromAlias: env.ALIYUN_DM_FROM_ALIAS, endpoint: env.ALIYUN_DM_ENDPOINT })
  }
  console.warn("[email] 阿里云 DirectMail 凭据缺失，使用 FakeEmailSender（不真发，仅日志）")
  return new FakeEmailSender()
}

// 惰性单例（同 getEnv 风格）：首次消费时按 env 决定真发/Fake。
let cached: EmailSender | null = null
export function getEmailSender(): EmailSender {
  return (cached ??= createEmailSender(getEnv()))
}
