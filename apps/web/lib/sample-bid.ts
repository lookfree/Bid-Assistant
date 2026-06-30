/* -------------------------------------------------------------------------- */
/*  全流程唯一演示数据源：某市政务云平台运维服务采购项目                          */
/*  读标 / 提纲 / 标书生成 / 审查 / 述标 全部从这里引用，保证前后自洽              */
/*  纯前端演示假数据，无需后端                                                   */
/* -------------------------------------------------------------------------- */

import {
  FileText,
  ShieldCheck,
  Wallet,
  Cpu,
  Target,
  ClipboardList,
  type LucideIcon,
} from "lucide-react"

/* ============================ 1. 项目基本信息 ============================ */
export const projectMeta = {
  name: "某市政务云平台运维服务采购项目",
  code: "ZCY-2026-ZWY-018",
  buyer: "某市大数据管理局",
  servicePeriod: "2 年",
  budget: "￥1,680 万",
  bidValidity: "90 日历天",
  deposit: "￥30 万",
  deadline: "2026-07-15 09:30",
  bidOpenLocation: "某市公共资源交易中心",
  fileName: "某市政务云平台运维服务采购-招标文件.pdf",
}

/* ============================ 2. 招标文件原文 ============================ */
/** 单条条款：每段原文都有稳定 id，便于右栏条目精确定位到「具体那一条」 */
export type Clause = { id: string; text: string }
export type TenderSection = { id: string; title: string; paragraphs: Clause[] }

/** 把字符串段落数组转为带稳定 id 的条款数组，id 规则：`${sectionId}-c${序号}` */
function withClauseIds(
  sections: { id: string; title: string; paragraphs: string[] }[],
): TenderSection[] {
  return sections.map((s) => ({
    id: s.id,
    title: s.title,
    paragraphs: s.paragraphs.map((text, i) => ({ id: `${s.id}-c${i + 1}`, text })),
  }))
}

export const tenderDoc: TenderSection[] = withClauseIds([
  {
    id: "sec-notice",
    title: "第一章 投标须知",
    paragraphs: [
      "项目名称：某市政务云平台运维服务采购项目；招标编号：ZCY-2026-ZWY-018；采购人：某市大数据管理局；采购方式：公开招标。",
      "本项目服务期为 2 年，最高限价（预算金额）人民币 1,680 万元，投标报价超过最高限价的按无效投标处理。",
      "投标保证金：人民币 30 万元，须于投标截止时间前以电汇或银行保函形式缴纳至指定账户，到账时间以采购代理机构账户实际收讫为准。",
      "投标文件递交截止时间为 2026 年 7 月 15 日 09:30，开标地点为某市公共资源交易中心三楼开标室；投标有效期自投标截止之日起 90 日历天。逾期送达或不符合规定的投标文件将被拒收。",
    ],
  },
  {
    id: "sec-qualification",
    title: "第二章 投标人资格要求",
    paragraphs: [
      "1. 投标人须为依法注册的独立法人，持有有效的营业执照，且经营范围涵盖信息系统运行维护服务。",
      "2. 投标人须通过 ISO9001 质量管理体系认证，并取得 ★ISO27001 信息安全管理体系认证（本项为不可偏离项，未提供者作无效投标处理）。",
      "3. 投标人须具备信息系统集成及服务资质二级及以上（或同等效力的行业资质）。",
      "4. 近三年（2023—2025 年）须承担过不少于 2 个类似政务云 / 信息系统运维项目，并提供合同关键页及验收证明复印件。",
      "5. 投标人未被列入“信用中国”失信被执行人、重大税收违法及政府采购严重违法失信名单。",
      "6. 投标人须按本须知规定足额缴纳投标保证金。",
    ],
  },
  {
    id: "sec-commercial",
    title: "第三章 商务条款",
    paragraphs: [
      "1. 报价方式：采用总价包干，报价须为完成招标范围内全部运维服务的含税总价，包含人力、工具平台、备品备件、差旅及税金等一切费用。",
      "2. 付款方式：合同签订并具备服务条件后支付合同总额 20% 作为启动款，其余款项按服务季度考核结果分期支付，末次付款于服务期满并通过年度考核后结清。",
      "3. 服务期：自合同签订之日起 2 年；服务期内采购人可按考核结果对服务质量进行评价。",
      "4. 投标报价应唯一，不得提交选择性报价或附有采购人不能接受的条件，否则按无效投标处理。",
    ],
  },
  {
    id: "sec-technical",
    title: "第四章 技术需求",
    paragraphs: [
      "1. 服务范围：负责政务云平台计算、存储、网络、数据库、中间件及云管平台的日常运维、监控值守、安全防护与备品备件更换。",
      "2. ★运维服务保障：须提供 7×24 小时驻场与远程相结合的运维服务，平台整体可用性不低于 99.9%，本项为不可偏离项。",
      "3. ★分级 SLA 响应：投标人须按故障等级明确响应时间与到场时间，并提供未达 SLA 的赔付条款；本项为不可偏离项，须在技术方案中以分级响应时间表形式逐级载明。",
      "4. 安全合规：运维服务须满足网络安全等级保护 2.0 三级要求，建立涵盖边界防护、入侵检测、日志审计、漏洞管理的安全防护体系，并配合采购人完成等保测评整改。",
      "5. 团队配置：投标人须配置不少于 8 名驻场运维人员，其中项目经理 1 名（持 PMP 或信息系统项目管理师证书）、安全工程师不少于 2 名。",
    ],
  },
  {
    id: "sec-scoring",
    title: "第五章 评分办法",
    paragraphs: [
      "评标采用综合评分法，满分 100 分，由技术方案、商务条款、投标报价三部分构成。",
      "技术方案 50 分：其中★运维服务体系 20 分、★应急保障与安全 15 分、实施团队 15 分。标注★的评分项为实质性要求，缺失或负偏离将被扣减关键分值乃至作无效投标。",
      "商务条款 20 分：商务条款响应程度、付款与服务承诺、企业信誉与业绩等。",
      "投标报价 30 分：以满足招标文件要求且不低于成本的有效最低报价为评标基准价，采用低价优先法计算价格分。",
    ],
  },
  {
    id: "sec-format",
    title: "第六章 投标文件格式",
    paragraphs: [
      "1. 投标文件须按“投标函及附录—资格与资质证明—商务文件—技术文件—投标报价表”的顺序编制并装订成册。",
      "2. 投标文件正本 1 份、副本 4 份，正本与副本须一致；关键页须加盖单位公章并由法定代表人或授权代表签字。",
      "3. 电子投标文件须通过指定电子交易平台上传，使用 CA 数字证书加密与电子签章。",
      "4. 投标文件未按规定密封、签章，或缺少★不可偏离项要求的实质性内容的，作无效投标处理。",
    ],
  },
])

/** 根据条款 id 列表生成人类可读的来源提示，如「第二章 · 第2条」「第四章 · 第2/3条」 */
export function clauseLocation(clauseIds?: string[]): string {
  if (!clauseIds || clauseIds.length === 0) return ""
  const bySection = new Map<string, number[]>()
  for (const cid of clauseIds) {
    const m = cid.match(/^(.*)-c(\d+)$/)
    if (!m) continue
    const [, secId, num] = m
    if (!bySection.has(secId)) bySection.set(secId, [])
    bySection.get(secId)!.push(Number(num))
  }
  const parts: string[] = []
  for (const [secId, nums] of bySection) {
    const sec = tenderDoc.find((s) => s.id === secId)
    const chap = sec ? sec.title.split(/\s+/)[0] : secId
    parts.push(`${chap} · 第${nums.sort((a, b) => a - b).join("/")}条`)
  }
  return parts.join("；")
}

/* ============================ 3. 评分办法表 ============================ */
export type ScoringRow = {
  id: string
  category: "技术方案" | "商务条款" | "投标报价"
  name: string
  score: number
  /** 是否★不可偏离项 */
  star?: boolean
  desc: string
  /** 招标原文条款 id（可多条） */
  clauseIds: string[]
  /** 对应标书章节 id */
  chapterId: string
}

export const scoringTable: ScoringRow[] = [
  {
    id: "sc-tech-1",
    category: "技术方案",
    name: "★运维服务体系",
    score: 20,
    star: true,
    desc: "运维组织、流程与分级 SLA 响应时间表、赔付条款的完整性与可行性",
    clauseIds: ["sec-technical-c2", "sec-technical-c3"],
    chapterId: "t3",
  },
  {
    id: "sc-tech-2",
    category: "技术方案",
    name: "★应急保障与安全",
    score: 15,
    star: true,
    desc: "等保 2.0 三级安全防护体系、应急预案与重大故障处置能力",
    clauseIds: ["sec-technical-c4"],
    chapterId: "t5",
  },
  {
    id: "sc-tech-3",
    category: "技术方案",
    name: "实施团队",
    score: 15,
    desc: "项目经理与安全工程师资质、团队配置与人员稳定性",
    clauseIds: ["sec-technical-c5"],
    chapterId: "t4",
  },
  {
    id: "sc-biz-1",
    category: "商务条款",
    name: "商务响应与信誉",
    score: 20,
    desc: "商务条款响应程度、付款与服务承诺、企业资质信誉与类似业绩",
    clauseIds: ["sec-scoring-c3"],
    chapterId: "b4",
  },
  {
    id: "sc-price-1",
    category: "投标报价",
    name: "投标报价",
    score: 30,
    desc: "以有效最低报价为基准价，低价优先法计算；报价须不低于成本",
    clauseIds: ["sec-scoring-c4"],
    chapterId: "b3",
  },
]

/* ============== 4. 评分点→章节映射（评分项 id → 标书章节 id） ============== */
export const scoringMap: Record<string, string> = scoringTable.reduce(
  (acc, row) => {
    acc[row.id] = row.chapterId
    return acc
  },
  {} as Record<string, string>,
)

/* ===================== 5. 招标解读：六大分类解读（读标右栏） ===================== */
export type AnalysisItem = {
  title: string
  value: string
  /** 精确定位到的招标原文条款 id（可一条对多条）；missing 项为空 */
  clauseIds: string[]
  status: "found" | "missing"
  /** 是否废标风险点 */
  risk?: boolean
}

export const analysisCategories: {
  key: string
  title: string
  icon: LucideIcon
  items: AnalysisItem[]
}[] = [
  {
    key: "overview",
    title: "项目概况",
    icon: FileText,
    items: [
      { title: "项目标识", value: `${projectMeta.name} · ${projectMeta.code}`, clauseIds: ["sec-notice-c1"], status: "found" },
      { title: "采购主体", value: `${projectMeta.buyer}（采购人）`, clauseIds: ["sec-notice-c1"], status: "found" },
      { title: "采购概况", value: `公开招标 · 预算/限价 ${projectMeta.budget} · 服务期 ${projectMeta.servicePeriod}`, clauseIds: ["sec-notice-c2"], status: "found" },
      { title: "关键时间", value: `递交截止 ${projectMeta.deadline} · 有效期 ${projectMeta.bidValidity}`, clauseIds: ["sec-notice-c4"], status: "found", risk: true },
      { title: "政策属性", value: "招标文件未明确中小微 / 联合体专项政策", clauseIds: [], status: "missing" },
    ],
  },
  {
    key: "qualification",
    title: "资格要求",
    icon: ShieldCheck,
    items: [
      { title: "通用资格", value: "独立法人 + 营业执照，经营范围含运维服务", clauseIds: ["sec-qualification-c1"], status: "found" },
      { title: "★信息安全认证", value: "ISO27001 信息安全管理体系认证（不可偏离）", clauseIds: ["sec-qualification-c2"], status: "found", risk: true },
      { title: "体系与资质", value: "ISO9001 + 系统集成及服务资质二级及以上", clauseIds: ["sec-qualification-c2", "sec-qualification-c3"], status: "found" },
      { title: "业绩要求", value: "近三年 ≥ 2 个类似政务云/运维项目（附合同+验收）", clauseIds: ["sec-qualification-c4"], status: "found" },
      { title: "信用要求", value: "未被列入失信被执行人 / 政府采购严重违法失信名单", clauseIds: ["sec-qualification-c5"], status: "found" },
      { title: "证明清单", value: "招标文件未给出逐条证明文件对照清单", clauseIds: [], status: "missing" },
    ],
  },
  {
    key: "commercial",
    title: "商务条款",
    icon: Wallet,
    items: [
      { title: "报价规则", value: "总价包干 · 含税 · 报价唯一不得附条件", clauseIds: ["sec-commercial-c1", "sec-commercial-c4"], status: "found" },
      { title: "投标保证金", value: `${projectMeta.deposit}，截止前到账（电汇/保函）`, clauseIds: ["sec-notice-c3"], status: "found", risk: true },
      { title: "付款条件", value: "20% 启动款 + 按季度考核分期 + 期满结清", clauseIds: ["sec-commercial-c2"], status: "found" },
      { title: "服务期", value: `${projectMeta.servicePeriod}，按季度考核服务质量`, clauseIds: ["sec-commercial-c3"], status: "found" },
      { title: "履约保证金", value: "招标文件未明确履约保证金比例", clauseIds: [], status: "missing" },
    ],
  },
  {
    key: "technical",
    title: "技术需求",
    icon: Cpu,
    items: [
      { title: "★运维保障", value: "7×24 运维，可用性 ≥ 99.9%（不可偏离）", clauseIds: ["sec-technical-c2"], status: "found", risk: true },
      { title: "★分级 SLA", value: "须按故障等级载明响应/到场时间与赔付条款（不可偏离）", clauseIds: ["sec-technical-c3"], status: "found", risk: true },
      { title: "安全合规", value: "满足等保 2.0 三级，建立安全防护体系", clauseIds: ["sec-technical-c4"], status: "found" },
      { title: "服务范围", value: "计算/存储/网络/数据库/中间件/云管平台运维", clauseIds: ["sec-technical-c1"], status: "found" },
      { title: "团队配置", value: "≥ 8 名驻场（项目经理 1 / 安全工程师 ≥ 2）", clauseIds: ["sec-technical-c5"], status: "found" },
    ],
  },
  {
    key: "scoring",
    title: "评分办法",
    icon: Target,
    items: [
      { title: "技术方案", value: "50 分（★运维体系 20 / ★应急保障 15 / 团队 15）", clauseIds: ["sec-scoring-c2"], status: "found", risk: true },
      { title: "商务条款", value: "20 分（响应 / 信誉 / 业绩）", clauseIds: ["sec-scoring-c3"], status: "found" },
      { title: "投标报价", value: "30 分 · 低价优先法，不低于成本", clauseIds: ["sec-scoring-c4"], status: "found" },
      { title: "得分映射", value: "招标文件未逐条映射证明材料页码", clauseIds: [], status: "missing" },
    ],
  },
  {
    key: "format",
    title: "格式与红线",
    icon: ClipboardList,
    items: [
      { title: "文件目录", value: "投标函—资格资质—商务—技术—报价表 顺序装订", clauseIds: ["sec-format-c1"], status: "found" },
      { title: "签章要求", value: "公章 + 法人/授权代表签字，关键页签章", clauseIds: ["sec-format-c2"], status: "found", risk: true },
      { title: "装订封装", value: "正本 1 份 / 副本 4 份，正副本一致", clauseIds: ["sec-format-c2"], status: "found" },
      { title: "电子投标", value: "指定平台上传 · CA 加密 · 电子签章", clauseIds: ["sec-format-c3"], status: "found" },
      { title: "废标红线（★）", value: "缺 ISO27001 / 缺★实质性内容 / 未签章即无效", clauseIds: ["sec-format-c4"], status: "found", risk: true },
    ],
  },
]

/* ============================ 6. 标书正文章节 ============================ */
export type Group = "tech" | "business"
export type OutlineItem = { id: string; label: string; clauseIds?: string[]; isNew?: boolean }

export type BidChapter = {
  id: string
  no: string
  title: string
  group: Group
  /** 是否能在招标文件中索引到来源；false 表示提纲新增、正文待生成 */
  sourced: boolean
  /** 提纲子项 */
  items: OutlineItem[]
  /** 正文 HTML；空字符串表示尚未生成（待生成空状态） */
  body: string
  /** 待生成章节（body 为空）点击「AI 生成本章正文」后展示的写实 demo 正文 */
  demoBody?: string
}

export const chapters: BidChapter[] = [
  /* ---------------- 技术标 ---------------- */
  {
    id: "t1",
    no: "第一章",
    title: "项目理解与整体方案",
    group: "tech",
    sourced: true,
    items: [
      { id: "t1-1", label: "1.1 项目背景与需求理解", clauseIds: ["sec-notice-c1", "sec-notice-c2"] },
      { id: "t1-2", label: "1.2 总体运维服务目标", clauseIds: ["sec-technical-c1", "sec-technical-c2"] },
      { id: "t1-3", label: "1.3 方案亮点与服务承诺", isNew: true },
    ],
    body: `<h3>1.1 项目背景与需求理解</h3><p>我方深入研读了《${projectMeta.name}》（招标编号 ${projectMeta.code}）招标文件，准确把握采购人某市大数据管理局对政务云平台"安全、稳定、高效"的核心诉求。本项目服务期 ${projectMeta.servicePeriod}，运维对象覆盖政务云平台的计算、存储、网络、数据库、中间件及云管平台，承载全市政务应用，对连续性与信息安全要求极高。</p><p>我方理解，本项目的关键成功要素有三：一是以不低于 99.9% 的可用性保障业务连续；二是建立分级 SLA 与 7×24 值守的快速响应机制；三是落实网络安全等级保护 2.0 三级要求，确保政务数据安全合规。</p><h3>1.2 总体运维服务目标</h3><p>围绕上述诉求，我方提出"统一监控、分级响应、主动运维、安全兜底"的整体服务方针，建立覆盖事件、问题、变更、配置、发布的全流程 ITSM 运维管理体系，实现从被动救火向主动预防的转变。</p><ul><li>平台整体可用性 ≥ 99.9%，核心系统故障年累计中断时间可控；</li><li>7×24 小时驻场与远程相结合，重大故障快速响应、快速到场；</li><li>安全防护满足等保 2.0 三级，全年安全事件零重大定级；</li><li>季度考核优良，服务报告与健康巡检按月交付。</li></ul><h3>1.3 方案亮点与服务承诺</h3><p>我方将依托自有自动化运维平台与多年政务云运维经验，提供可视化监控大屏、智能告警与知识库沉淀，并郑重承诺：服务期内各项指标达标，未达 SLA 主动赔付，让采购人省心、放心。</p>`,
  },
  {
    id: "t2",
    no: "第二章",
    title: "技术实现与架构设计",
    group: "tech",
    sourced: true,
    items: [
      { id: "t2-1", label: "2.1 运维支撑分层架构", clauseIds: ["sec-technical-c1"] },
      { id: "t2-2", label: "2.2 监控与自动化运维", isNew: true },
      { id: "t2-3", label: "2.3 等保 2.0 三级安全防护", clauseIds: ["sec-technical-c4"] },
    ],
    body: `<h3>2.1 运维支撑分层架构</h3><p>我方运维支撑体系遵循"分层解耦、弹性扩展"原则，自底向上划分为基础资源层、平台服务层、运维支撑层与安全防护层四个层次，各层通过标准化接口协同，保证体系的可维护性与可演进性。</p><ul><li><strong>基础资源层：</strong>统一纳管计算、存储、网络等资源，建立 CMDB 配置基线；</li><li><strong>平台服务层：</strong>对数据库、中间件、云管平台提供专项运维与性能调优；</li><li><strong>运维支撑层：</strong>以 ITSM 流程驱动事件、问题、变更管理，工单全程可追溯；</li><li><strong>安全防护层：</strong>纵深防御，统一安全态势感知。</li></ul><h3>2.2 监控与自动化运维</h3><p>部署统一监控平台，对主机、网络、数据库、应用进行指标采集与阈值告警，实现分钟级故障发现。通过自动化脚本与编排实现批量巡检、日志归集与常见故障自愈，降低人工误操作风险，提升处置效率。</p><h3>2.3 等保 2.0 三级安全防护</h3><p>严格落实网络安全等级保护 2.0 三级要求，部署 WAF、IDS/IPS、堡垒机、日志审计与漏洞扫描等安全组件，构建边界防护、访问控制、安全审计、入侵防范的纵深防御体系，并配合采购人完成等保测评与整改闭环，确保政务数据全生命周期安全可审计。</p>`,
  },
  {
    id: "t3",
    no: "第三章",
    title: "运维服务体系",
    group: "tech",
    sourced: true,
    items: [
      { id: "t3-1", label: "3.1 服务组织与流程", clauseIds: ["sec-technical-c2"] },
      { id: "t3-2", label: "3.2 7×24 值守与故障处理", clauseIds: ["sec-technical-c2"] },
      { id: "t3-3", label: "3.3 服务级别承诺 SLA", isNew: true },
    ],
    // 故意不写"分级 SLA 响应时间表"——对应中风险
    body: `<h3>3.1 服务组织与流程</h3><p>我方组建专职运维服务团队，设项目经理 1 名总体负责，下设系统运维组、数据库与中间件组、安全运维组，按 ITSM 标准建立事件、问题、变更、发布、配置五大流程，所有服务请求经统一服务台受理、派单、处置、回访闭环，工单全程留痕、可追溯、可考核。</p><h3>3.2 7×24 值守与故障处理</h3><p>提供 7×24 小时驻场与远程相结合的值守服务，建立"监控发现—服务台受理—分级处置—升级协同—复盘归档"的故障处理机制。重大故障启动应急协同，及时通报采购人并组织多方会商，确保平台整体可用性不低于 99.9%。</p><p>我方建立标准化运维知识库，沉淀典型故障处置预案与操作手册，持续提升一次解决率，减少重复故障与处置时长。</p><h3>3.3 服务级别承诺 SLA</h3><p>我方承诺严格执行服务级别管理，对各类服务请求和故障实行闭环管理，并接受采购人按季度考核。我方将提供月度服务报告与健康巡检报告，对服务质量进行持续改进。</p>`,
  },
  {
    id: "t4",
    no: "第四章",
    title: "项目实施团队",
    group: "tech",
    sourced: true,
    items: [
      { id: "t4-1", label: "4.1 团队组织架构", clauseIds: ["sec-technical-c5"] },
      { id: "t4-2", label: "4.2 核心人员配置与资质", clauseIds: ["sec-technical-c5"] },
      { id: "t4-3", label: "4.3 人员稳定性保障", isNew: true },
    ],
    // 业绩举证偏薄——对应中风险
    body: `<h3>4.1 团队组织架构</h3><p>我方为本项目配置不少于 8 名驻场运维人员，采用"项目经理负责制 + 专业分组"的矩阵式组织。项目经理统筹服务交付与考核，系统、数据库、安全各专业组分工协作，并设远程专家组提供二线技术支撑。</p><h3>4.2 核心人员配置与资质</h3><p>项目经理张工，持 PMP 与信息系统项目管理师证书，具备多年政务云运维管理经验；安全工程师 2 名，持 CISP 等安全资质，负责等保合规与安全事件处置；数据库、中间件工程师具备相应原厂或行业认证。全部驻场人员社保由我司连续缴纳，满足招标文件对人员资格的要求。</p><h3>4.3 人员稳定性保障</h3><p>我方建立人员到岗承诺与备份机制，核心岗位实行 AB 角，关键人员变更须提前报采购人审批并平滑交接，保障服务连续性。</p><p class="text-muted-foreground">（注：本章类似项目业绩举证较薄，建议补充近三年同类政务云运维项目的合同关键页与验收报告作为佐证。）</p>`,
  },
  {
    id: "t5",
    no: "第五章",
    title: "应急预案与保障措施",
    group: "tech",
    sourced: false,
    items: [
      { id: "t5-1", label: "5.1 风险识别与分级", isNew: true },
      { id: "t5-2", label: "5.2 重大故障应急预案", isNew: true },
      { id: "t5-3", label: "5.3 演练与持续改进", isNew: true },
    ],
    body: "",
    demoBody: `<h3>5.1 风险识别与分级</h3><p>我方建立覆盖硬件、网络、系统、数据、安全与人为操作六大类的风险识别清单，按影响范围与紧急程度将故障划分为四级：</p><ul><li><strong>一级（重大）：</strong>核心政务应用整体不可用或数据安全事件，15 分钟内响应、30 分钟内到场、4 小时内恢复；</li><li><strong>二级（严重）：</strong>关键模块功能受损或性能严重下降，30 分钟内响应、2 小时内到场；</li><li><strong>三级（一般）：</strong>非核心功能异常，1 小时内响应、4 小时内处置；</li><li><strong>四级（轻微）：</strong>咨询与优化类，按工单约定时限处理。</li></ul><h3>5.2 重大故障应急预案</h3><p>针对一级、二级故障，我方启动"发现告警—服务台受理—应急小组集结—分级处置—多方协同—恢复验证—复盘归档"的标准应急流程，并明确指挥、技术、沟通三条线职责。</p><ul><li>成立由项目经理任组长的应急指挥小组，30 分钟内完成集结与定责；</li><li>对数据库、网络、安全等场景预置专项处置预案与回滚方案，确保操作可控；</li><li>故障期间每 30 分钟向采购人通报进展，恢复后 2 个工作日内提交根因分析报告。</li></ul><h3>5.3 演练与持续改进</h3><p>我方每半年组织一次不少于两个场景的应急演练（含断网、数据库故障、安全攻击模拟），演练结果纳入服务质量考核，并基于演练与真实故障复盘持续修订预案、更新知识库，形成"预案—演练—复盘—改进"的闭环，不断提升应急处置能力。</p>`,
  },

  /* ---------------- 商务标 ---------------- */
  {
    id: "b1",
    no: "第一章",
    title: "投标函及投标函附录",
    group: "business",
    sourced: true,
    items: [
      { id: "b1-1", label: "1.1 投标函", clauseIds: ["sec-format-c1"] },
      { id: "b1-2", label: "1.2 投标函附录", clauseIds: ["sec-format-c1"] },
      { id: "b1-3", label: "1.3 投标人声明", isNew: true },
    ],
    body: `<h3>1.1 投标函</h3><p>致：${projectMeta.buyer}</p><p>根据贵方 ${projectMeta.name}（招标编号 ${projectMeta.code}）的招标文件，我方经研究上述招标文件的全部内容后，愿以投标报价表所列总价承担本项目全部运维服务，并承诺如下：</p><ul><li>我方已仔细阅读并完全响应招标文件的全部条款，无保留、无附加条件；</li><li>本投标文件投标有效期为自投标截止之日起 ${projectMeta.bidValidity}；</li><li>我方已按招标文件要求缴纳投标保证金人民币 ${projectMeta.deposit}；</li><li>若我方中标，将在规定期限内签订合同并按约履行服务期 ${projectMeta.servicePeriod} 的各项义务。</li></ul><h3>1.2 投标函附录</h3><p>投标函附录就投标有效期、保证金、服务期、响应承诺等关键事项与招标文件逐条对照，作为投标函不可分割的组成部分。</p><h3>1.3 投标人声明</h3><p>我方郑重声明：所提交的全部资格证明与投标资料真实、合法、有效，不存在弄虚作假；我方未被列入失信被执行人及政府采购严重违法失信名单。如有不实，愿承担相应责任并接受废标处理。</p>`,
  },
  {
    id: "b2",
    no: "第二章",
    title: "法定代表人资格与授权",
    group: "business",
    sourced: true,
    items: [
      { id: "b2-1", label: "2.1 法定代表人身份证明", clauseIds: ["sec-qualification-c1"] },
      { id: "b2-2", label: "2.2 授权委托书", clauseIds: ["sec-qualification-c1"] },
      { id: "b2-3", label: "2.3 投标人基本情况表", isNew: true },
    ],
    body: `<h3>2.1 法定代表人身份证明</h3><p>兹证明 ×× 同志现任我单位法定代表人，特此证明。附法定代表人身份证复印件及任职文件，并加盖单位公章。</p><h3>2.2 授权委托书</h3><p>本授权委托书声明：我 ××（法定代表人）系投标人的法定代表人，现授权 ××（授权代表）为我方就本项目投标活动的合法代理人，代理人在开标、澄清、签约等过程中所签署的一切文件和处理的相关事务，我方均予以承认。授权期限与投标有效期一致。</p><h3>2.3 投标人基本情况表</h3><p>投标人名称、统一社会信用代码、注册资本、成立时间、经营范围、注册地址及联系方式等基本信息如实填列，与营业执照及资质证书保持一致。</p>`,
  },
  {
    id: "b3",
    no: "第三章",
    title: "商务报价与价格构成",
    group: "business",
    sourced: true,
    items: [
      { id: "b3-1", label: "3.1 投标报价一览表", clauseIds: ["sec-commercial-c1"] },
      { id: "b3-2", label: "3.2 价格构成明细", clauseIds: ["sec-commercial-c1"] },
      { id: "b3-3", label: "3.3 价格合理性说明", isNew: true },
    ],
    body: `<h3>3.1 投标报价一览表</h3><p>我方就本项目 ${projectMeta.servicePeriod} 运维服务的投标总报价为人民币 <strong>1,560.00 万元</strong>（含税），低于最高限价 ${projectMeta.budget} 且不低于成本，报价唯一、无附加条件。</p><h3>3.2 价格构成明细</h3><table class="w-full border-collapse text-sm"><thead><tr><th class="border border-border bg-muted px-3 py-2 text-left font-semibold">费用项</th><th class="border border-border bg-muted px-3 py-2 text-left font-semibold">说明</th><th class="border border-border bg-muted px-3 py-2 text-right font-semibold">金额（万元）</th></tr></thead><tbody><tr><td class="border border-border px-3 py-2">人力服务费</td><td class="border border-border px-3 py-2">≥ 8 名驻场及远程专家 2 年人力成本</td><td class="border border-border px-3 py-2 text-right">1,020.00</td></tr><tr><td class="border border-border px-3 py-2">工具平台费</td><td class="border border-border px-3 py-2">监控/自动化/安全工具平台及许可</td><td class="border border-border px-3 py-2 text-right">240.00</td></tr><tr><td class="border border-border px-3 py-2">备品备件费</td><td class="border border-border px-3 py-2">易损件更换与应急备件储备</td><td class="border border-border px-3 py-2 text-right">180.00</td></tr><tr><td class="border border-border px-3 py-2">税金</td><td class="border border-border px-3 py-2">增值税及附加</td><td class="border border-border px-3 py-2 text-right">120.00</td></tr><tr><td class="border border-border px-3 py-2 font-semibold">合计</td><td class="border border-border px-3 py-2"></td><td class="border border-border px-3 py-2 text-right font-semibold">1,560.00</td></tr></tbody></table><h3>3.3 价格合理性说明</h3><p>本次报价基于规模化运维复用与自有工具平台的成本优势，价格构成透明、分项合计与总价一致，不存在低于成本的恶意竞标，能够保障服务质量与人员稳定。</p>`,
  },
  {
    id: "b4",
    no: "第四章",
    title: "企业资质与信誉证明",
    group: "business",
    sourced: true,
    items: [
      { id: "b4-1", label: "4.1 营业执照与体系认证", clauseIds: ["sec-qualification-c2", "sec-qualification-c3"] },
      { id: "b4-2", label: "4.2 类似项目业绩", clauseIds: ["sec-qualification-c4"] },
      { id: "b4-3", label: "4.3 信誉与无违规承诺", clauseIds: ["sec-qualification-c5"] },
    ],
    // 故意缺 ISO27001——对应高风险
    body: `<h3>4.1 营业执照与体系认证</h3><p>我方持有有效营业执照，经营范围涵盖信息系统运行维护服务；已通过 ISO9001 质量管理体系认证，并具备信息系统集成及服务资质二级。相关证书复印件加盖公章随附。</p><p class="text-muted-foreground">（待补充：招标文件第二章明确要求的 ★ISO27001 信息安全管理体系认证证书尚未附入本章。）</p><h3>4.2 类似项目业绩</h3><p>我方近三年承担多个信息系统运维项目，具备政务云运维服务能力，附主要项目合同关键页与验收证明。</p><h3>4.3 信誉与无违规承诺</h3><p>经"信用中国"查询，我方未被列入失信被执行人、重大税收违法及政府采购严重违法失信名单；我方承诺投标过程诚实守信，无围标串标等违规行为。</p>`,
  },
  {
    id: "b5",
    no: "第五章",
    title: "售后服务与增值承诺",
    group: "business",
    sourced: false,
    items: [
      { id: "b5-1", label: "5.1 售后服务体系", isNew: true },
      { id: "b5-2", label: "5.2 增值服务承诺", isNew: true },
      { id: "b5-3", label: "5.3 服务质量保障", isNew: true },
    ],
    body: "",
    demoBody: `<h3>5.1 售后服务体系</h3><p>我方建立"服务台 + 驻场 + 远程专家 + 原厂联动"的四级售后服务体系，提供 7×24 小时全天候支持。统一服务热线与在线工单双通道受理，所有请求均闭环管理、可追溯、可考核。</p><ul><li>一线服务台：统一受理、初判与派单，常见问题即时解决；</li><li>二线驻场工程师：现场处置系统、数据库、网络等专业故障；</li><li>三线远程专家与原厂：疑难问题升级支援，必要时启动原厂资源。</li></ul><h3>5.2 增值服务承诺</h3><p>在满足招标文件基本要求的基础上，我方额外提供以下增值服务，不另行收费：</p><ul><li>每季度提交运维健康度评估与优化建议报告，助力平台持续调优；</li><li>免费为采购人方运维人员提供不少于 2 次/年的技能培训与知识转移；</li><li>提供容量规划与成本优化建议，协助提升资源利用率；</li><li>重大保障期（如重要会议、政务高峰）提供专项值守与预案支持。</li></ul><h3>5.3 服务质量保障</h3><p>我方承诺接受采购人按季度对服务质量进行考核，考核结果与服务费用挂钩；未达约定 SLA 指标的，按合同约定主动赔付。我方设立服务质量回访与满意度调查机制，持续改进服务，确保采购人满意。</p>`,
  },
]

/** 便捷分组取值 */
export const techChapters = chapters.filter((c) => c.group === "tech")
export const businessChapters = chapters.filter((c) => c.group === "business")

/* ============================ 7. 风险项（审查 / 体检共用） ============================ */
export type RiskFinding = {
  level: string
  tone: "destructive" | "warning"
  title: string
  /** 对应标书章节标题 */
  chapterTitle: string
  /** 对应招标条款（"对应：…"展示串） */
  tenderRef: string
  advice: string
  /** 定位目标：标书 tab 与章节 id */
  targetTab: Group
  targetId: string
}

export const riskFindings = {
  score: 78,
  high: 1,
  mid: 2,
  passed: 9,
  items: [
    {
      level: "高风险",
      tone: "destructive",
      title: "缺少 ISO27001 信息安全管理体系认证",
      chapterTitle: "企业资质与信誉证明",
      tenderRef: "对应：第二章 投标人资格要求（★不可偏离）",
      advice:
        "ISO27001 为招标文件明确的强制资格条件，缺失将直接废标。请在资料库补充 ISO27001 认证证书并附入商务标第四章，或确认是否可由联合体成员提供。",
      targetTab: "business",
      targetId: "b4",
    },
    {
      level: "中风险",
      tone: "warning",
      title: "技术方案未明确分级 SLA 响应时间承诺",
      chapterTitle: "运维服务体系",
      tenderRef: "对应：第四章 技术需求（★分级 SLA）",
      advice:
        "招标文件要求以分级响应时间表载明各级故障的响应/到场时间与赔付条款。建议在技术标第三章 3.3 节补充分级 SLA 响应时间表与未达标赔付条款。",
      targetTab: "tech",
      targetId: "t3",
    },
    {
      level: "中风险",
      tone: "warning",
      title: "类似项目业绩证明材料不足",
      chapterTitle: "项目实施团队",
      tenderRef: "对应：第二章 投标人资格要求（业绩）",
      advice:
        "招标要求近三年不少于 2 个类似项目并附合同与验收。当前业绩举证偏薄，建议从资料库补充同类政务云运维项目的合同关键页与验收报告。",
      targetTab: "tech",
      targetId: "t4",
    },
  ] as RiskFinding[],
  passedItems: [
    "投标报价 1,560 万未超最高限价且不低于成本，价格构成完整",
    "投标函格式与签章符合招标文件要求",
    "法定代表人授权委托手续齐全",
    "技术方案满足等保 2.0 三级安全要求",
    "投标保证金 30 万金额正确、形式合规",
    "投标有效期 90 日历天满足招标规定",
    "投标文件按规定目录顺序装订",
    "ISO9001 与系统集成资质二级满足要求",
    "信用记录正常，未列入失信名单",
  ],
}
