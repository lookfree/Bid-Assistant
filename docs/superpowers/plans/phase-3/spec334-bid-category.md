# spec334 标书分类管线：判定 + 人工纠偏 + 知识注入机制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。

**Goal:** 把「这是一本什么类型的标书」（货物 / 服务 / 工程）变成贯穿全链路的一等维度——**本 spec 只做管线**：
判定、用户确认与纠偏、把分类下发到各生成节点、以及各节点消费知识的接口。**知识内容本身在 spec335**，
本 spec 落地时那些接口可以是空的，管线照样能上线、能测、能验收。

**为什么值得做（决策依据）：** 同一个客户，买设备的标要求中小企业声明函**填列所有制造商**，买服务的标
**只填投标人自己一家**——**填反直接废标**。库里真实数据也印证：信息安全设备采购标要的是技术参数逐条响应、
质保期、到货验收；攻防演练服务标的包件说明里白纸黑字写着「人员要求：高级≥1人、中级≥1人、初级≥2人」，
正对服务类必查项「人员配置覆盖招标全部岗位与人数」。这些差异与客户在哪个行业无关。

**Architecture:** 与 spec324 选包同构，逐点复用其管线。`ReadResult` 增 `bid_category`（系统判定值 +
置信度 + 证据条款，**读标收尾的一次轻量结构化模型调用**）；项目表增 `bid_category` 列（**用户确认值**，
与判定值分开存）；App 在 outline 及之后各步的 `run_input` 带有效值；agent 在**五个注入点**按类取知识块。
未判定 ⇒ 全链路行为与今天逐字节一致。

```
read 节点收尾
   ├─ 单包标书 ⇒ 一次轻量分类调用（喂读标结论摘要，非全文）
   │     └─ ReadResult.bid_category {value[], confidence, reason, evidence_clause_ids}
   └─ 多包标书（packages > 1）⇒ 不判定，value=[]     ← 此时系统还不知道用户要投哪个包
读标页
   ├─ 选包卡（spec324，多包时渲染）
   └─ 分类卡（在选包卡下方）
         └─ PATCH /projects/:id/category            ← 用户确认/改判 → 项目行
         └─ 判定值 ≠ 确认值 ⇒ 记一条纠偏样本         ← 判定质量迭代的燃料
有效值 = 确认值 ?? 判定值  →  run_input.bid_category  →  五个注入点
   ├─ outline           ：必备章节（**只按主类别**）
   ├─ content 规划轮     ：章节层面的写作要点与陷阱
   ├─ content 子写手     ：落笔层面的要点  ← 拼进 subagent 的 system_prompt，不靠规划轮转述
   ├─ review            ：必查项（**主次类别都给**）+ 行业资质补丁
   └─ /generate/checklist：投递前核对项   ← 同步接口不是图节点，没有 run_input
```

## Global Constraints

- 作者 `lookfree <etwuman@126.com>`；禁止 Claude 相关内容。函数 ≤80 行、文件 ≤800 行。
- **有效值 = 用户确认值 ?? 系统判定值。判定值默认生效，不等用户点。**
  否则绝大多数用户根本不会点那张卡，功能等于没做。默认生效是安全的：分类只加提示词、不碰钱、
  带证据条款可查、随时可改判且改判后重跑即生效。前端文案必须诚实——写「系统判定：服务标 ·
  已按此生成（可修改）」，不能写成「请选择」却又在背后已经用上了。
  **「清除」必须能真正关掉分类，不能被 `??` 又兜回判定值**：`bid_projects.bid_category` 用三态——
  `null`（用户没表态，回落判定值）/ 非空数组（用户选定）/ **空数组 `[]`（用户明确要求不用分类）**。
  第三态不可省：判定给了一个用户认为都不合适的类别时，他必须有办法关掉，否则每次重跑都被强加一次。
- **未判定（空）时行为逐字节不变**——分类是加法，不是前置门槛。不像选包那样卡 `package_required`：
  选包不选会拿错数据生成，分类判不出只是少一层增强。**不得因为缺分类就拒绝开跑。**
- **招标文件优先于分类知识**：必备章节只补招标文件**没提到**的章；凡 `required_structure` 已给出的
  一律以招标文件为准。分类知识是行业经验，不是招标要求，二者冲突时经验让路。
- 分类**不额外计费**：判定调用只吃摘要（几 k tokens，相对本步本身可忽略），**随它所在那一步结算**
  ——生成流水线与带招标文件的线下标书随**读标步**，无招标文件的自查随**审查步**。
  **分类调用失败不得让所在步失败**——不能为一次锦上添花赔上一整轮读标或审查费用。
- 迁移手写 SQL（沿 0026 惯例，drizzle snapshot 已滞后不可 db:generate）。
- 命名用 `bid_category` / `bidCategory`，**不用 `bidType`**——`apps/web/app/(tool)/content/page.tsx:70`
  的 `bidType` 已经是「技术标/商务标/全文」的 tab 键，同名两义必然出事。

## 混合标：值是**有序数组**，不是单值

零信任平台采购这类标 = 买软硬件（货物）+ 部署实施（服务）+ 运维（服务），招标文件里必然同时出现
「交货期/质保期/到货验收」和「服务期/运维服务/驻场」。硬选一个必然丢掉另一半的必查项。

- `bid_category` 是 **1–2 个值的有序数组**，**首元素为主类别**。
- **必备章节只按主类别**——提纲结构只能有一套，两套必备章节会让提纲膨胀出重复的技术标骨架。
- **必查项主次都给**——查多了只是多看一眼，漏了是废标。
- 单一类别就是长度为 1 的数组，与今天的单值语义完全一致，下游不需要分支。

## 任务顺序与依赖

**按 A → C → B → D → E 执行。** 顺序不是随意的：

| Task | 依赖 | 为什么 |
|---|---|---|
| A 判定 | 无 | 自包含，判定值落进步结果即可自测 |
| C App API | A | 有效值解析要读 A 产出的 `result -> 'bid_category'` |
| B 注入点 | C | 节点读的是 `run_input.bid_category`，那是 C 下发的；**B 自身可用测试夹具先行开发**，但端到端要等 C |
| D Web | C | 调 C 的 PATCH 与详情接口 |
| E 运营 | C | 读 C 建的纠偏表 |

**A 与 B 都会改 `nodes/review.py`**（A 加节点开头的分类调用，B 加必查项注入），按此顺序执行不会撞车。

## Task A: Agent — 分类判定（读标收尾的一次轻量模型调用）+ ReadResult 字段

**为什么用模型而不是关键词打分**：分类是**语义判断**，不是字面匹配。实测（见「附录：判定方案实测」）
关键词方案把一份房地产开发项目判成「服务」、把「统一身份认证平台升级改造（**定制开发**）」判成货物——
「定制开发属于服务」这种事没有任何关键词抓得住。更要命的是维护成本：词表天然带着编写者所在行业的
口音，换一个行业就要重配一次，而模型天然泛化。**关键词只保留在「行业资质触发」上**，那才是字面匹配任务。

**调用形态（三条硬约束，缺一条就退回到当初否掉它的理由）：**
1. **不塞进 `submit_read_result`**——读标的提交工具 schema 已经很大，加字段有被小模型静默跳过的
   先例；分段并行 6 路还要额外定义合并语义。分类走**读标收尾的一次独立结构化调用**。
2. **喂读标结论摘要，不喂全文**：`project_meta` + 技术需求条目前 N 条 + 评分表类目 + `required_structure`
   标题列表，量级几 k tokens。读标本身是 6 路并行、百万字量级的调用，这次分类连 1% 都不到。
3. **必须回证据**：`evidence_clause_ids` 取自摘要里带的条款 id，前端可点开定位原文。
   **没有证据的判定不给用户看**——用户无从判断该不该改判。

**判定规则：**
- `value: list[Literal["goods","services","engineering"]]`，长度 0–2，**首元素为主类别**；
  判据不足一律返回 `[]`，**不许猜**。招标文件确实横跨两类时返回 2 个值，主类别在前。
- `confidence ∈ {high, medium, low}`；`low` 在前端等同于「请你确认」，不预选。
  `value=[]` 时 `confidence` 无意义，固定写 `low`，前端只看 `value` 是否为空来决定预不预选。
- **调用抛错 / 超时 / 返回不合法 ⇒ 一律吞掉记日志，`value=[]`，读标步照常成功。**
- **分类调用复用本 run 的模型（`ctx.gateway`），不引入独立的模型配置。** 由此「模型未配置」这条
  分支在本 spec 里是**走不到的**——run 创建时 `projects.ts` 的 `resolveModel()` 已经把未配置挡在
  400 `model_not_configured`，读标根本不会开跑。写死这条是为了避免实现时顺手加一个后台没有的
  配置项：**要独立模型就得先在运营后台加配置入口，那不在本 spec 范围内。**

**多包件招标：不判定，直接交用户。** 判定发生在选包**之前**——读标面向全文（`projects.ts` 明确：
`package` 只对 `step≠read` 下发），此时系统还不知道用户要投哪个包。各包可能分属不同类别，拿全文判出来
安到某个具体包上是错的。`packages` 长度 > 1 ⇒ 直接 `value=[]`，前端分类卡文案改为「请选择所投包件的类型」。

> **实测依据**：库里 3 份多包标（4 包的设备采购标、两份 3 包的服务标）各包同类，**跨类多包一次都没
> 观测到**。所以选最省的做法——多包时让用户点一下，而不是为一个没见过的场景加「选包后重新判定」的链路。
> 用户在那一页本来就要做选包动作，顺手选类型成本极低。

**线下上传标书（`kind=review`）同样启用，输入源与触发点按形态二选一。** 这类项目有两种形态
（`routes/projects.ts:455`）：带招标文件的 `status=draft / currentStep=read`，不带招标文件的
`status=running / currentStep=review`——**后者根本不跑 read，没有读标结论可喂**。

| 形态 | 分类输入 | 触发点 | 用户确认在哪 |
|---|---|---|---|
| 线下标书 + 招标文件 | 读标结论摘要 | read 收尾 | 读标页分类卡（与生成流水线一致） |
| **线下标书，无招标文件（自查）** | **上传标书正文摘要**：`parse_bid_chapters` 出的章节标题清单 + 每章前若干字 | **review 节点开头，先分类再审查** | `/risk` 页分类卡（该项目没有读标页） |

> 第二种为什么放节点开头：放在之后，用户看到分类时这轮审查已经跑完、**并没有用上分类知识**，
> 得再花一次钱重跑才生效。放在开头则当轮即用。

**判定值怎么回到 App 和前端（两条路径，均已核对现有代码，不需要改结果通道）：**

| | 生成流水线 / 带招标文件的线下标书 | 无招标文件的线下自查 |
|---|---|---|
| 判定发生在 | read 节点收尾 | review 节点开头 |
| 挂在哪 | `{"read": {**result.model_dump(), "doc_sections": clauses, "bid_category": cat}}` | `{"risk": {**result.model_dump(), "bid_category": cat}}` |
| App 怎么拿到 | `_RESULT_KEY["read"]="read"` → 落 `project_steps.result` | `_RESULT_KEY["review"]="risk"` → 同上 |
| 前端怎么拿到 | 该步 result 经 `toCamel` → `bidCategory` | 同左 |

三点关键，**都核对过现有代码，不是推断**：

1. **不进工具 schema。** `bid_category` 是**另一次调用**的产物，塞进 `submit_read_result` /
   `submit_risk_report` 等于把它暴露在「小模型静默跳过字段」的风险下。沿用现成成例：
   `nodes/read.py:283` 已经在往 `model_dump()` 后的 dict 里塞 `doc_sections`——而 `ReadResult`
   **并没有** `doc_sections` 这个字段。schema 之外的键照样能随结果落库。
2. **非会员裁剪不会吃掉它。** `lockRiskAdvice`（`entitlements.ts:44`）是 `{...r, items, adviceLocked}`
   展开式，不是白名单重建，未知键原样透传。（必须核对而不能假设：白名单式重建静默丢字段的坑本仓库刚踩过。）
3. **App 侧读判定值只取那一个 JSON 键。** 照抄多包件门禁 `projects.ts:706` 的
   `select result -> 'packages'`——大标书 read result 可达 1MB，绝不为一个标量把整列拖过隧道。

**重跑时不重复判定：** App 下发 `run_input.bid_category` 后，节点直接用，**跳过分类调用**。

**Files:**
- Add: `agents/bidding_agent/nodes/classify.py`（分类调用；**两种摘要构造**：读标结论摘要 / 上传标书正文摘要；失败吞掉返回 `[]`）
- Add: `agents/bidding_agent/prompts/classify.py`（三类定义、判据不足必须返回空、横跨两类时主类别在前、必须回证据条款）
- Modify: `schemas.py`（新增独立的 `BidCategory{value, confidence, reason, evidence_clause_ids}`，**不要挂到 `ReadResult` 上**——挂上去就等于混进 `submit_read_result` 的工具 schema，正是本 Task 第 1 条要躲的坑）
- Modify: `nodes/read.py:283`（返回处并入；`packages` 长度 > 1 直接跳过调用）
- Modify: `nodes/review.py`（无读标结论时在节点开头分类）
- Test: 三类各一份代表性摘要判对；横跨两类 ⇒ 返回 2 个值且主类别在前；判据不足 → `[]`；
  **多包件 ⇒ 不调用模型、直接 `[]`**；**模型未配置/抛错 ⇒ 读标步与审查步仍然成功且值为 `[]`**（钱的守卫，必须有）；
  证据条款 id 必须来自摘要中出现过的 id（防模型编 id）；
  **无招标文件的自查项目 ⇒ 走上传标书正文摘要、且在审查之前完成**

- [x] Task A（提交 `feat(agent): bid category classification at read completion`）

## Task B: Agent — 五个注入点与知识接口（**知识内容见 spec335，本 Task 只做机制**）

本 Task 交付的是**接口与注入机制**。`prompts/categories.py` 提供：

```python
# 知识条目的唯一数据结构（spec335 往里填内容，本 spec 定形状）
# purpose: chapters=必备章节 / planning=章节层面要点 / writing=落笔要点 /
#          review=必查项 / checklist=投递前核对项
CATEGORY_KNOWLEDGE: list[dict]      # {category, purpose, status, text}
INDUSTRY_PATCHES:  list[dict]       # {keywords, item, level, status}

def category_scope(categories: list[str], purpose: str) -> str: ...
def industry_patches(text: str) -> str: ...
```

**本 spec 落地时两张表可以是空的**——空表 ⇒ 两个函数返回空串 ⇒ 全链路逐字节等同于改动前。
管线因此可以独立上线、独立验收，不被知识验证卡住。

**`status` 由谁转成措辞：本 spec 的 `category_scope()` 负责，不是知识表里存两份文案。**
表里 `text` 只写**要求本身**（如「施工组织设计含施工方案/进度计划/质量保证/安全文明施工四大块」），
`category_scope()` 按 `status` 套模板：`已验证` ⇒ 「本标为<类>标，<text>」；`待验证` ⇒
「<类>标通常<text>，**请核对本次招标文件是否有此要求**」。
**这是两份 spec 之间唯一的接口缝隙，必须在本 spec 这边闭合**——放到知识表里存两份文案，
spec335 每加一条都要写两遍、还会写漂；放在这里，spec335 只管内容与状态。模板文案的权威定义
在 spec335「措辞模板」一节，本 spec 实现它。

**五个注入点，口径与注入方式各不相同：**

| # | 消费点 | 代码位置 | 注入方式 | purpose | 取哪些类别 |
|---|---|---|---|---|---|
| 1 | 提纲 | `nodes/outline.py`，紧邻 `user += package_scope(...)` | user 消息追加 | `chapters` | **只取主类别** |
| 2 | 正文·规划轮 | `nodes/content.py:394`（`package_scope` 同处） | user 消息追加 | `planning` | **只取主类别** |
| 3 | **正文·子写手** | `nodes/content.py:373` 的 `subagents=[{... "system_prompt": CHAPTER_WRITER_PROMPT}]` | **直接拼进子写手 system_prompt** | `writing` | **只取主类别** |
| 4 | 审查 | `nodes/review.py` 的 `user` 拼接处 | user 消息追加 | `review` + 行业补丁 | **主次都取** |
| 5 | 审核表 | **`routes/generate.py` 的 `POST /generate/checklist`**——**不是图节点** | body 新增可选字段 | `checklist` | **主次都取** |

**取主类别还是主次都取，规则只有一条**：**产出「写什么」的取主类别，产出「查什么」的主次都取。**
写作侧（提纲/规划/落笔）两套并行会让标书结构和口径打架；检查侧多查一条只是多看一眼，漏一条是废标。

**#3 是本 Task 最容易做错、错了会静默失效的一处。** `content` 是 deepagent：规划轮
(`CONTENT_PLANNER_PROMPT`) 派活，真正落笔的是子写手 (`CHAPTER_WRITER_PROMPT`)。只把要点加在规划轮的
user 消息里，**能不能到子写手完全取决于规划轮肯不肯转述**——这正是 `desc` 踩过的坑
（`prompts/content.py` 里那句「必须原样转述给子写手…丢掉等于把用户的意图默默扔了」就是事后补的）。
子写手的 `system_prompt` 在节点内构造 `create_deep_agent` 时传入，**可以动态拼接**，不必依赖转述。

**#5 是接口而非节点。** `POST /generate/checklist` 同步无状态、不进 thread、**没有 `run_input`**，
body 只有 `read_result` + `model`。所以 body 增可选 `bid_category`，由 App 下发**有效值**；
不传时回落 `read_result.bid_category`。**不能只靠回落**——用户改判后的确认值不在 read result 里。

**审查那处的口径必须写死**：「这些是行业经验必查项，**不是本次招标的明文要求**：能对上招标条款的
按高风险报，对不上的按中风险提醒」。否则会把经验当红线，刷出一堆招标文件根本没要求的「废标风险」，
用户信错一次就再也不信体检报告了。

**行业资质补丁在什么文本上匹配：**

| 项目形态 | 匹配输入 | 为什么不用全文 |
|---|---|---|
| 有读标结论 | `read.categories[].items[]` 的 title/value + `project_meta`（经 `filter_read_by_package` 收窄后的那份） | 补丁词是资质类术语，只出现在需求与资格条款里；拿 `doc_sections` 全文匹配只增噪声和成本 |
| 无读标（自查） | `parse_bid_chapters` 出的章节正文（review 节点已截断的那份） | 同上 |

**Files:**
- Add: `prompts/categories.py`（两张表的**结构** + `category_scope` / `industry_patches`；内容留空，由 spec335 填）
- Modify: `nodes/outline.py`（#1）、`nodes/content.py`（#2 规划轮 user；**#3 子写手 system_prompt**）、`nodes/review.py`（#4 + 补丁匹配）
- Modify: `checklist_gen.py` + `routes/generate.py`（#5 body 可选 `bid_category`，回落 `read_result.bid_category`）
- Test: 五处各断言两态（有/无分类的消息差异，用测试夹具塞几条假知识，不依赖 spec335 的真内容）；
  **#3 断言子写手 system_prompt 确实含该类要点**（只测规划轮会漏掉整个失效路径）；
  **主类别取 `chapters`、主次都取 `review`**；行业关键词命中 ⇒ 补丁进入 review 消息、未命中 ⇒ 不进；
  `/generate/checklist` 传 `bid_category` 与仅靠回落两条路径各一例；
  **知识表为空 ⇒ 各处消息与改动前逐字节一致**

- [x] Task B（提交 `feat(agent): category knowledge injection points`）

## Task C: App API — bid_category 列 + 确认接口 + 纠偏记录 + 下发

**Files:**
- Modify: `db/schema/bid-projects.ts`（`bidCategory: jsonb("bid_category").$type<string[]>()` 可空）+ 手写迁移 0040
- Add: `db/schema/` 纠偏表 `bid_category_corrections`（project_id / detected / confirmed / confidence / created_at）
- Modify: `routes/projects.ts`
  - 新 `PATCH /:id/category` body `{category: string[]}`（zod：数组、长度 1–2、元素为三值枚举、去重）设置，裸 `null` 清除（照抄 `PATCH /:id/package`，`projects.ts:466`）
  - **纠偏记录**：**判定值非空**且确认值 ≠ 判定值时才写一条。
    **判定值为空时的用户选择不是纠偏，绝不能记**——多包件、判据不足、分类调用失败三种情况判定值都是
    `[]`，那时用户的任何选择都会满足「≠ 判定值」，全记下来会让 Task E 的「判错方向」统计里混满
    「我们压根没判」的样本，直接失去指导意义。判定值为空是**覆盖率**问题，不是**准确率**问题，
    两者要分开看：前者靠 `[]` 出现频次统计，后者才靠这张纠偏表。
  - **有效值解析（唯一实现，只此一处）**：`effectiveCategory(project) = project.bidCategory ?? 判定值`，
    判定值来自该项目最近一次 done 的 read 步（自查项目取 review 步）result，**只走窄 SQL**
    `select result -> 'bid_category'`。**必须是唯一实现**——散在几处各写各的，迟早出现
    「提纲按 A 生成、审查按 B 检查」的分叉。
  - run 组装处（`projects.ts:726`）：有效值非空且 `step ≠ read` ⇒ 带 `bid_category`
  - 调 `/generate/checklist` 处一并下发有效值
  - GET 详情回 `bidCategory`（确认值，含空数组三态）与 `detectedCategory`（判定值 + 证据）；
    **`?slim=1` 回的是有效值**（字段名 `effectiveCategory`），不是确认值——项目卡的分类标签走 slim，
    只回确认值会让「已按判定值生成」的项目在列表里不显示标签，**显示与实际生效的不一致**。
    有效值仍只需 `select result -> 'bid_category'`，不碰 result 整列，与 slim 的初衷不冲突。
- **重跑不覆盖用户确认值**：`bid_projects.bid_category` 只由 PATCH 写。
- Test: PATCH 往返 / 属主隔离 / 非法枚举与超长数组 400 / run_input 含 `bid_category`（read 步不含）/
  **未确认时下发判定值、确认后下发确认值** / 重跑读标后项目行分类不变 / 改判写纠偏记录、同判不写 /
  **有效值解析不触碰 result 整列**

- [x] Task C（提交 `feat(api): project bid category, correction log and run input`）

## Task D: Web — 分类卡 + 项目概况标签

**Files:**
- Modify: `apps/web/lib/bid-types.ts` + `lib/project.ts`（`bidCategory: string[]` + `setProjectCategory` API）
- Modify: `app/(tool)/read/page.tsx`（**选包卡下方**渲染分类卡：主类别三选一 + 「本标还涉及」可选第二类；
  默认选中系统判定值，文案「系统判定：X · 已按此生成（可修改）」；判定为空时**不预选**、
  文案「未能可靠判定本标类型，请选择」，多包件时改为「请选择所投包件的类型」；证据条款可点击定位原文）
- Modify: `app/(tool)/risk/page.tsx`（无招标文件的线下标书没有读标页，同一张卡渲染在审查页；改判后提示「重跑审查后生效」）
- Modify: 项目卡展示分类标签（只读）——列表接口按 `selectDistinctOn` **一条批量查询**取本页各项目的判定值（与既有 `doneRows` 同法，避免 N+1），回生效值
- Test: tsc + `bun test`；空判定 / 单类 / 双类三态渲染；线下标书（无招标文件）在 `/risk` 页渲染分类卡

- [x] Task D（提交 `feat(web): bid category card`）

## Task E: 运营侧 — 纠偏样本可见

**Files:**
- Modify: `apps/api/src/routes/admin/` + admin 前端（只读列表：判定值 / 确认值 / 置信度 / 时间，按「判错方向」聚合计数）
- 用途：定期看「哪类标判错了、错成什么」，据此改分类提示词。**没有这一步，判定质量就没有反馈回路。**
- Test: 列表接口鉴权 + 分页

- [x] Task E（提交 `feat(admin): bid category correction review`）

## 验证口径

agent / api / web 三门禁绿。**本 spec 的验收不依赖 spec335 的知识内容**：知识表为空时全链路逐字节等同于
改动前；用测试夹具塞入假知识后，五个注入点各自出现对应文本。归总 e2e：真实标各类若干跑读标 →
判定与人工判断一致率、不判定率记录在案；改判后重跑，注入内容随之改变。

## 决策记录

- **判定用模型，不用关键词打分（本条为改判，先前结论已作废）**，理由见「附录：判定方案实测」。
  **关键词只留在行业资质触发上**——那是精确术语匹配，模型是浪费。
- **判不准就交给用户，不做兜底猜测**：与「模型未配置即 400、绝不静默回退默认模型」同一条铁律。
  提示词里必须写死「判据不足一律返回空，不许猜」。反面做法是「取最高分、初值给某一类」——
  那让「不判定」这条路径永远走不到，判不准时不是不判，是**默认某一类**。
- **分类失败绝不拖垮读标步 / 审查步**：读标是这条链上最贵的一步。
- **混合标用有序数组而非单值**：硬选一个会丢掉另一半的必查项，而必查项漏一条就是废标。
  **必备章节只按主类别**（提纲结构只能有一套），**必查项主次都给**（查多了只多看一眼）。
- **多包件不自动判、直接交用户**：判定发生在选包之前，各包可能分属不同类别。
- **管线与知识拆成两个 spec**：管线是一次做完的工程改造，知识是持续增补、需要业务参与、
  且每条都要核到现行法规或真实标书的资产。绑在一起会让管线**等知识验证完才能开工**，等于什么都不做。
- **线下自查项目的分类也走模型，而不是让用户在上传时选**：后者更省，但会让「AI 判 + 人工纠偏」
  在两个入口不一致，用户得学两套交互。选一致。

## 未决问题

1. **分类选择要不要提前到上传页**：现方案放在读标后（此时才有全文依据）。若产品要「进门即分流」
   （不同类型给不同引导文案/上传清单），则上传页加一次选择、读标判定退化为「校验并提示不一致」。
   产品动线问题，不是技术问题。
2. **纠偏数据攒够后，是否需要在分类之下再加 IT 细分**（软件开发 / 系统集成 / 安全服务 / 设备采购 /
   运维外包）。现在**不做**——行业维度先由 spec335 的关键词补丁表兜着，等纠偏数据证明确实需要再说。

## 附录：判定方案实测（选型依据，留档）

判定方案在两批语料上做过对照，结论是关键词打分不可用：

**第一批**（5 份公开真实招标文件，两套打分判据对照）

| 判据 | 计分方式 | 结果 |
|---|---|---|
| 朴素打分 | 强信号 `2×出现次数`、中信号 `1×出现次数`，含泛词，取最高分 | 5 份中 1 份判错：服务类文件判成货物类 |
| 收紧后 | 只用强信号、同词只计一次、最高分 ≥3 且领先次高 ≥2 | 0 份判错，1 份「不判定」——正是前者判错的那份 |

判错机理：一份文件名含「政府采购」的**服务类**文件里 `采购` 出现 231 次、`产品` 230 次，泛词按词频
累加把「货物」顶到 732 分，压过「服务」的 682 分。一份纯工程标里 `管理` 出现 102 次，让「服务」拿到
167 分——**分数被文档长度和废词支配**。

**第二批**（我们自己库里 12 份不同的招标文件，用收紧后的判据）

| 结果 | 数量 | 案例 |
|---|---|---|
| 判对 | ~7 | 信息安全设备采购 → 货物；攻防演练服务 → 服务 |
| **判错** | 1 | **房地产开发项目 → 判成「服务」**：工程侧命中 `分部分项工程/主体结构/施工现场`（6 分），输给服务侧 `人员配置/服务期/咨询/驻场`（8 分） |
| 存疑 | 1 | 「统一身份认证平台升级改造（**定制开发**）」→ 判成货物；服务侧只命中一个「咨询」 |
| 不判定 | 1 | 「零信任安全接入网关**建设工程**…采购」平手 → 交用户。这是真·混合标，**在本 spec 的设计下它应当被判成 `[goods, services]` 两个值，而不是不判定**——关键词方案没有表达混合的能力，只能弃权 |

两条结论：① **词表天然带编写者的行业口音**——手头那版偏物业后勤类（物业管理/保安/保洁/餐饮/护工），
而我们语料 12 份里 11 份是 IT 采购，一份**网络攻防演练**标居然命中了「物业管理」；② 关键词对全文打分，
导致同一份 4 包招标文件的「包件一」与「包件四」得分逐位相同——**方法本身拿不到包级输入**。


## 实现记录（2026-08-01 落地）

五个 Task 全部完成，门禁：agent `494 passed`、web `141 pass` + `tsc` 干净、api 分类相关
`10 pass` + admin `3 pass` + `tsc` 干净。**与方案不符、以实现为准的三处：**

0. **Task D 的「项目卡分类标签」曾被漏做却标成完成**，评审抓出后补齐：列表接口加一条
   `selectDistinctOn` 批量查询（同既有 `doneRows` 的形状，绝不逐项目查），卡片渲染生效值。
1. **`BidCategory` 不挂 `ReadResult`。** 方案 Files 一栏原写 `ReadResult.bid_category: BidCategory | None`，
   与同一 Task 第 1 条「不塞进 `submit_read_result`」**直接矛盾**——挂到 `ReadResult` 上，
   `convert_to_openai_tool` 就会把它带进读标的提交工具 schema。实际按 `doc_sections` 的成例做：
   独立 schema + 并进结果 dict。已回改方案原文。
2. **迁移号 0040**（方案写的 0036 已被占用）。
3. **`category_scope(categories, purpose)` 收的是分类数组本身**，不是 `run_input`——
   `package_scope(run_input)` 那个形态在这里不合用：审查节点的分类可能来自读标结果或现判，
   不一定在 `run_input` 里。

**顺带修掉的既有测试**：`test_read_node_multifile.py` 三处 `len(gw.chats)` 断言改成只数读标轮
（`_read_rounds`）——分类多了一次模型调用，而那三条断言想说的是「读标提交了几次」。
