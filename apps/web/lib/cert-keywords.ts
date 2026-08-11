// 缺证预警（2026-08-09 资料库定向注入设计,计划⑤）——读标结束就告诉用户「招标要求的证照，
// 资料库里没有」，别等到正文生成完才在证照占位处看到「（待补充：xxx）」才反应过来。

// 证照词表字面量——与计划 Global Constraints、agent 侧
// services/agent/src/agent/agents/bidding_agent/nodes/cert_placement.py 逐字同形（两端各自
// 持有确定性实现,字面量一改就要同步改另一处，注释互指）。
export const CERT_KEYWORDS = ["营业执照", "资质证书", "授权书", "法定代表人身份证明", "检测证书", "许可证",
  // 财务与资格类材料（2026-08-11 加，与 agent 侧同步）：这类材料放在资料库「财务材料」分类里，
  // 此前既不进附录章也不会被定向插图——词表只覆盖资质类。
  "审计报告", "资产负债表", "利润表", "财务报表", "纳税证明", "完税证明",
  "社保证明", "银行资信证明", "开户许可证"] as const

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
  const hits = CERT_KEYWORDS.filter(
    (kw) => hitTitles.some((t) => t.includes(kw)) && !credentialTitles.some((t) => t.includes(kw)),
  )
  // 词表存在包含关系（「开户许可证」⊃「许可证」）：两个都命中会让预警条重复念同一件材料。
  // 与 agent 侧 `_matched_keywords` 同一手法——被别的命中词整个包含的词一律丢弃。
  return hits.filter((kw) => !hits.some((other) => other !== kw && other.includes(kw)))
}
