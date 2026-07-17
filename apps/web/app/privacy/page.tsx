import Link from "next/link"

// 隐私政策（备案合规静态页）：纯 server component，无交互，文案为运营/法务口径。
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">隐私政策</h1>
      <p className="mt-1.5 text-xs text-muted-foreground">更新日期：2026-07-17</p>

      <section className="mt-8">
        <h2 className="text-base font-semibold text-foreground">一、收集的信息</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          在使用本产品过程中，我们会收集：手机号、短信验证码验证记录、账号标识；使用本产品各功能步骤产生的操作记录；用户主动上传的招标文件与企业资料（如资质证明、业绩案例）。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">二、处理目的</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          上述信息用于：登录鉴权与账号安全；项目与标书内容管理；招标解读、提纲、正文、审查、述标等内容生成；积分计费与订单结算；安全审计与异常行为排查；客服与工单处理。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">三、第三方共享</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>
            大模型服务商：为完成内容生成，我们会向国内大模型服务商传输完成该次生成所必需的文本片段与指令，不包含用户手机号、账号标识或支付信息；
          </li>
          <li>短信服务商：仅用于发送与校验登录验证码；</li>
          <li>支付服务商：仅处理订单号与支付金额，不涉及其他个人信息。</li>
        </ul>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          除法律法规要求或用户明确授权外，我们不会向其他第三方共享用户个人信息。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">四、存储与安全</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          用户数据传输采用 HTTPS 加密；不同用户的数据按账号隔离存储，系统与人员访问遵循最小权限原则，仅限完成对应功能所必需的范围。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">五、用户权利</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          用户可对自己的账号信息与上传资料提出查询、更正、删除请求，或申请注销账号；相关请求请登录后进入「帮助与反馈」页在线提交，我们将在合理期限内处理。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">六、未成年人</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本产品面向企业及职业用户提供投标文件编制辅助服务，不以未成年人为服务对象；如发现未成年人使用本产品，请通过「帮助与反馈」页联系我们处理。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">七、政策变更</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本政策可能随产品迭代或监管要求更新，更新后的版本将在本页面公示并注明更新日期；用户继续使用本产品即视为接受更新后的政策内容。
        </p>
      </section>

      <div className="mt-10 border-t border-border pt-6">
        <Link href="/" className="text-sm font-medium text-primary hover:underline">
          返回首页
        </Link>
      </div>
    </main>
  )
}
