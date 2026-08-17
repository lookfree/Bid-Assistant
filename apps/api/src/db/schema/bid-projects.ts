import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, index } from "drizzle-orm/pg-core"
import { id, createdAt } from "./columns"
import { users } from "./users"

// 标书分类（spec334）：《政府采购法》的货物/服务/工程三分法。与前端 content 页的 `bidType`
// （技术标/商务标/全文）是两回事，故不复用那个名字。
export const BID_CATEGORIES = ["goods", "services", "engineering"] as const
export type BidCategoryValue = (typeof BID_CATEGORIES)[number]

// 一本标书一个项目行，持有贯穿 agent 工作流的 thread_id（§spec207）。
export const bidProjects = pgTable(
  "bid_projects",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().unique(), // 一本标书一个 thread（贯穿 agent 工作流）
    name: text("name"), // 项目名：建项时取 project_files.filename（原始文件名）；旧行/查不到为 null
    tenderFileKey: text("tender_file_key"), // 招标文件 MinIO key（=tenderFileKeys[0]，向后兼容旧读侧）
    tenderFileKeys: jsonb("tender_file_keys").$type<string[]>(), // spec320：全部招标文件 key（公告/主文件/技术规范书/附件…）
    // spec324：多包件招标用户选投的包（{id,name}）；可空——单包标书/未选包时全链路行为不变。
    selectedPackage: jsonb("selected_package").$type<{ id: string; name: string }>(),
    // spec334 标书分类**用户确认值**（判定值另存在 read/review 步 result 里，重跑只刷判定值、
    // 绝不覆盖用户改判）。有序数组、首元素为主类别；1–2 个值——平台采购这类标同时是货物与服务，
    // 硬选一个会丢掉另一半的必查项。三态：null=没表态（回落判定值）/ 非空=选定 / **[]=明确不用分类**。
    bidCategory: jsonb("bid_category").$type<BidCategoryValue[]>(),
    // spec328：项目类型——bid=生成流水线（默认,存量不变）;review=独立审查（线下标书,只跑 read/review）
    kind: text("kind").notNull().default("bid").$type<"bid" | "review">(),
    bidFileKey: text("bid_file_key"), // spec328：线下上传的投标文件 key（=bidFileKeys[0]，向后兼容旧读侧）
    // 商务标与技术标常常分册出卷，一份标书可能是多个文件；与 tenderFileKeys 同构。
    bidFileKeys: jsonb("bid_file_keys").$type<string[]>(),
    status: text("status").notNull().default("draft"), // draft/running/done
    currentStep: text("current_step").notNull().default("read"),
    // 导出计费脏标记（2026-07-31 产品口径「章节修改不收费、内容改过后重新导出收费」）：
    // 改提纲/正文（编辑回写、AI 改写、重跑该步）置 true，成功导出后置 false。
    // 默认 true=从未导出过的项目首次导出照收。用标记而非内容哈希：导出是每次点击的必经路径，
    // 哈希要把整本正文读出来算，与「导出路径不碰 result 列」的既有教训冲突。
    exportDirty: boolean("export_dirty").notNull().default(true),
    // 内容最后变更时间：导出收尾据此判断「本次 run 期间内容有没有被改过」，改过就不清脏——
    // 否则长导出期间的编辑会被收尾抹平，交付文件不含该改动、下次真含改动的导出却免费。
    contentChangedAt: timestamp("content_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({ userIdx: index("bid_projects_user_idx").on(t.userId) }),
)

// 每步一行账：run_id 关联 agent run，result 存该步结构化结果（bidding 业务以此表为准；
// spec108 的 agent_runs 保留给非 bidding 的通用 run 记账）。
export const projectSteps = pgTable(
  "project_steps",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => bidProjects.id, { onDelete: "cascade" }),
    step: text("step").notNull(), // read/outline/content/review/present/export
    runId: text("run_id"), // 关联 agent run（按步一个）
    result: jsonb("result"), // 该步结构化结果（ReadResult/Outline/...，snake_case 原样）
    costPoints: integer("cost_points").notNull().default(0), // 计费 stub 记账
    status: text("status").notNull().default("pending"), // pending/running/done/failed
    createdAt: createdAt(),
    // 结束时刻（2026-08-17）：收尾是原地 UPDATE 同一行，没有这一列就只有起步时刻，
    // 「这一步实际跑了多久」无从统计——进度条的预估总时间就是拿它的历史中位数算的。
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({ projIdx: index("project_steps_proj_idx").on(t.projectId) }),
)

// 分类纠偏样本（spec334）：**判定值非空**且用户确认值与之不同时记一条，是判定质量迭代的唯一数据来源。
// 判定值为空（多包件/判据不足/调用失败）时的用户选择**不记**——那是覆盖率问题不是准确率问题，
// 记进来会让「判错方向」的统计里混满「我们压根没判」的样本，直接失去指导意义。
export const bidCategoryCorrections = pgTable(
  "bid_category_corrections",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => bidProjects.id, { onDelete: "cascade" }),
    detected: jsonb("detected").$type<BidCategoryValue[]>().notNull(),
    confirmed: jsonb("confirmed").$type<BidCategoryValue[]>().notNull(),
    confidence: text("confidence"),
    createdAt: createdAt(),
  },
  (t) => ({ createdIdx: index("bid_category_corrections_created_idx").on(t.createdAt) }),
)
