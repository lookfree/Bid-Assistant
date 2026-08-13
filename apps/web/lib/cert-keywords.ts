// 缺证预警（2026-08-09 资料库定向注入设计,计划⑤）——读标结束就告诉用户「招标要求的证照，
// 资料库里没有」，别等到正文生成完才在证照占位处看到「（待补充：xxx）」才反应过来。

// 证照词表字面量——与计划 Global Constraints、agent 侧
// services/agent/src/agent/agents/bidding_agent/nodes/cert_placement.py 逐字同形（两端各自
// 持有确定性实现,字面量一改就要同步改另一处，注释互指）。
// 证照词组：每组 = [标准名, 该组全部写法…]。**匹配用组内任一写法，展示用标准名。**
// 平表时代要求"招标要求的措辞"与"用户给条目起的名字"命中同一个词——「法人身份证」对不上
// 「法定代表人身份证明」、「公司执照」对不上「营业执照」（2026-08-11 用户实测踩到两次）。
// 与 agent 侧 nodes/cert_placement.py 的 CERT_GROUPS 逐字同形（一改就要同步改另一处）。
export const CERT_GROUPS = [
  ["营业执照", "营业执照", "工商执照", "公司执照", "营业执照副本", "三证合一"],
  ["资质证书", "资质证书", "资质证明", "企业资质", "等级证书"],
  ["授权书", "授权书", "授权委托书", "法定代表人授权书"],
  ["厂家授权", "厂家授权", "原厂授权", "制造商授权", "厂商授权"],
  ["法定代表人身份证明", "法定代表人身份证明", "法定代表人身份证", "法人身份证明",
    "法人身份证", "法人代表身份证", "法定代表人证明书"],
  ["检测证书", "检测证书", "检测报告", "检验报告", "型式试验"],
  ["许可证", "许可证", "经营许可"],
  ["审计报告", "审计报告", "审计意见", "经审计的财务"],
  ["资产负债表", "资产负债表"],
  ["利润表", "利润表", "损益表"],
  ["财务报表", "财务报表", "财务状况", "财务报告"],
  ["纳税证明", "纳税证明", "完税证明", "纳税记录", "税收缴纳"],
  ["社保证明", "社保证明", "社会保险", "社保缴纳"],
  ["银行资信证明", "银行资信证明", "资信证明", "银行资信"],
  ["开户许可证", "开户许可证", "基本账户", "开户证明"],
  ["信用中国截图", "信用中国", "信用记录截图", "信用查询截图"],
] as const

/** 标准名列表（展示用，也是双端同表断言的锚点）。 */
export const CERT_KEYWORDS = CERT_GROUPS.map((g) => g[0]) as readonly string[]

/** 一段文字命中哪一组 → 标准名；都不命中给 null。取**最长**的匹配写法所在组，
 *  避免「开户许可证」同时命中「许可证」组（包含关系）。 */
function groupOf(text: string): string | null {
  let best: { len: number; name: string } | null = null
  for (const group of CERT_GROUPS) {
    for (const alias of group.slice(1)) {
      if (text.includes(alias) && (!best || alias.length > best.len)) best = { len: alias.length, name: group[0]! }
    }
  }
  return best?.name ?? null
}

/** 标准名 → 该组全部写法（查库存时任一写法命中即算这份材料已有）。 */
function aliasesOf(canonical: string): readonly string[] {
  return CERT_GROUPS.find((g) => g[0] === canonical)?.slice(1) ?? [canonical]
}

// 缺证判定只看读标结论里资格/商务两类条目——技术类要求命中证照字样极罕见且易误报
// （与 agent 侧 _CERT_CATEGORY_KEYS 同一取舍）。
const CERT_CATEGORY_KEYS = new Set(["qualification", "commercial"])

/** 缺证清单（纯函数）：资格/商务类条目 title 命中词表某词 K，且资料库现存资质条目 title
 *  无一含 K → 收集 K（去重，保持词表序——遍历词表而非命中标题，天然去重定序，与 agent 侧
 *  `_matched_keywords` 同一手法）。categories 传入读标页已合并好的分类（真实结果到手后即
 *  等价于 real.categories），credentialTitles 取自 export-preview 的 credentials[].title。 */
export function missingCerts(
  categories: { key: string; items: { title: string }[] }[],
  credentialTitles: string[],
): string[] {
  const hitTitles = categories
    .filter((cat) => CERT_CATEGORY_KEYS.has(cat.key))
    .flatMap((cat) => cat.items.map((it) => it.title))
  // 每条要求各自归组（组内取最长写法，天然处理包含关系），库存也按组内任一写法算命中。
  const matched = new Set(hitTitles.map(groupOf).filter((g): g is string => !!g))
  return CERT_KEYWORDS.filter(
    (kw) => matched.has(kw) && !credentialTitles.some((t) => aliasesOf(kw).some((a) => t.includes(a))),
  )
}
