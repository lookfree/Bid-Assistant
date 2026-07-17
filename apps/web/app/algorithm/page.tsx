import Link from "next/link"
import { SUPPORT_EMAIL } from "@/lib/site"

// 算法公示（备案合规静态页）：纯 server component，无交互，文案与备案报告口径一致。
export default function AlgorithmPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">算法公示</h1>
      <p className="mt-1.5 text-xs text-muted-foreground">更新日期：2026-07-17</p>

      <section className="mt-8">
        <h2 className="text-base font-semibold text-foreground">一、算法名称</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">智启元投标助手生成合成类算法</p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">二、服务主体</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">上海安几科技有限公司</p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">三、算法机制机理</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本算法以用户主动上传的招标文件、企业资料与显式操作指令为输入，依次经过文档解析、招标条款分块、结构化读标、检索增强、章节内容生成、合规风险审查到文档导出的固定处理流程；每一处理步骤均由用户在界面上主动点击触发，不存在自动执行环节。本算法不使用用户数据对模型进行训练或微调，不基于用户行为构建用户画像，不含内容推荐或排序功能。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">四、应用场景与目的</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本算法应用于招标文件解读、投标文件草拟、标书风险自查与述标材料准备等场景，目的是提升投标文件编制效率，辅助用户更全面地覆盖招标文件要求，不用于其他用途。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">五、用户权益保障</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>每一处理步骤均需用户显式触发，不存在未经用户同意的自动生成；</li>
          <li>生成结果可自由编辑、重新生成或删除；</li>
          <li>生成失败时已预扣积分自动全额退还；</li>
          <li>读标结果可逐条溯源至招标文件原文对应位置；</li>
          <li>生成内容均附带显式 AI 生成标识，提示用户核实。</li>
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-foreground">六、申诉与反馈渠道</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          如对生成内容或本算法的运行有疑问、投诉或建议，请登录后进入「帮助与反馈」页在线提交。
        </p>
        {SUPPORT_EMAIL && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">客服邮箱：{SUPPORT_EMAIL}</p>
        )}
      </section>

      <p className="mt-8 text-xs text-muted-foreground">备案编号：待备案通过后公示</p>

      <div className="mt-10 border-t border-border pt-6">
        <Link href="/" className="text-sm font-medium text-primary hover:underline">
          返回首页
        </Link>
      </div>
    </main>
  )
}
