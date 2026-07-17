import Link from "next/link"
import { SUPPORT_EMAIL } from "@/lib/site"

// 用户协议（备案合规静态页）：纯 server component，无交互，文案为运营/法务口径。
// 分节拆两个子组件渲染（一~五 / 六~九），保持单函数 ≤80 行。
export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">用户协议</h1>
      <p className="mt-1.5 text-xs text-muted-foreground">更新日期：2026-07-17</p>

      <TermsSectionsOne />
      <TermsSectionsTwo />

      <div className="mt-10 border-t border-border pt-6">
        <Link href="/" className="text-sm font-medium text-primary hover:underline">
          返回首页
        </Link>
      </div>
    </main>
  )
}

/** 一~五：服务性质 / 账号与登录 / 上传内容合法性 / AI 生成内容性质与人工复核 / 积分与计费。 */
function TermsSectionsOne() {
  return (
    <>
      <section className="mt-8">
        <h2 className="text-base font-semibold text-foreground">一、服务性质</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本产品（智启元投标助手，以下简称“本产品”）是面向企业与职业用户的 AI 辅助投标文件编制工具，基于用户主动上传的招标文件与企业资料，辅助完成招标解读、提纲编排、正文撰写、风险审查与述标材料生成。本产品输出内容仅供用户编制投标文件时参考，不构成法律、财务或专业投标咨询意见；本产品及运营方不对使用本产品生成的内容所涉及的投标结果（包括但不限于是否中标）作出任何保证或承诺。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">二、账号与登录</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          用户通过手机号 + 短信验证码方式注册与登录本产品。用户应确保所留手机号真实有效并妥善保管账号，因账号信息保管不善导致的损失由用户自行承担。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">三、用户上传内容合法性承诺</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          用户上传的招标文件、企业资质、业绩案例等资料，应来源合法、已获得合法使用或披露授权。用户承诺不上传涉及国家秘密、非本人或本单位所有的商业秘密、他人未经授权的个人信息，或其他违反法律法规的内容；因用户上传内容导致的权属纠纷或法律责任，由用户自行承担。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">四、AI 生成内容性质与人工复核义务</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本内容由智启元投标助手生成合成类算法辅助生成，仅供投标文件编制参考，请结合招标文件原文和企业实际情况复核确认后使用。用户在提交投标文件前，应对生成内容的准确性、完整性与合规性进行人工复核确认，本产品不因用户未尽复核义务导致的后果承担责任。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">五、积分与计费</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本产品按步骤消耗积分，且积分消耗均在用户显式点击触发对应生成步骤时才发生，触发前会明确标注本次消耗数量；若该次生成失败，已预扣积分将自动全额退还，无需用户另行申请。
        </p>
      </section>
    </>
  )
}

/** 六~九：禁止行为 / 知识产权与商业秘密 / 责任限制 / 协议变更与联系方式（含申诉渠道 + 选填客服邮箱）。 */
function TermsSectionsTwo() {
  return (
    <>
      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">六、禁止行为</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>诱导本产品生成违法、违规或侵害他人合法权益的内容；</li>
          <li>通过技术手段批量、异常调用本产品接口造成资源滥用；</li>
          <li>以任何方式绕过计费机制获取本应付费的服务；</li>
          <li>将本产品生成内容用于欺诈、虚假投标或其他欺骗招标人的用途。</li>
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">七、知识产权与商业秘密</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          用户上传内容的知识产权归用户或原权利人所有；本产品依用户指令生成的投标文件内容，其著作权归属由用户与本产品运营方另行约定或按法律规定处理，运营方不因提供生成服务而主张对用户投标文件内容的权利。本产品的软件、算法、界面等技术成果的知识产权归运营方所有，用户及第三方对其中涉及的商业秘密负有保密义务。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">八、责任限制</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本产品按现状提供，运营方在法律允许的最大范围内不对因网络、第三方服务异常或不可抗力导致的服务中断承担责任；对本产品生成内容引发的任何直接或间接损失，运营方的赔偿责任以用户就该项服务实际支付的费用为限（法律另有强制性规定的除外）。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">九、协议变更与联系方式</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本协议可能随产品迭代或监管要求更新，更新后的协议将在本页面公示并注明更新日期；用户继续使用本产品即视为接受更新后的协议内容。用户对本协议、生成内容、计费或个人信息处理有异议的，可登录后进入「帮助与反馈」页在线提交。
        </p>
        {SUPPORT_EMAIL && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">客服邮箱：{SUPPORT_EMAIL}</p>
        )}
      </section>
    </>
  )
}
