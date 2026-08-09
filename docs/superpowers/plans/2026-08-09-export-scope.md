# 导出分册(技术标/商务标/全量)+ 导出预告 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导出时三选一(技术标册/商务标册/全量),分册按投标惯例调整构成与标题;弹窗预告将自动附加的内容;积分零改动(脏标记天然只扣一次)。

**Architecture:** 渲染层(`render_docx`)加 `scope` 参数管标题后缀与组尾巴;导出节点按 scope 过滤章节、控制 credentials 取舍、写**带 scope 后缀的产物键**(与全量键并存于 artifacts 合并通道);App API 透传 `export_scope` 并新增只读预告接口;前端弹窗三选一 + 预告区 + 按产物键出下载按钮。计费路径一行不动。

**Tech Stack:** python-docx + pypdfium2(agent,均已有);Hono + Drizzle(App API);React(web)。测试:`uv run pytest` / `bun test`(api 全量需 `--env-file=../../.env.bidsaas.local`)。

**Spec:** `docs/superpowers/specs/2026-08-08-export-scope-design.md`(分册规则表与预告区定义以 spec 为准)

## Global Constraints

- `export_scope` 字面量:`"full" | "tech" | "business"`,缺省 `full`,老调用方行为逐字节不变
- 标题后缀字面量:`·技术标部分` / `·商务标部分`(封面与页脚);单册章标题**无**`（技术标）/（商务标）`组尾巴;全量保持现状
- 分册规则:资质附录只进 full/business(技术册由 App **不下发** credentials 实现);签章页与 AI 提示页三种 scope 恒定保留
- 产物键:`docx_tech`/`pdf_tech`/`pdf_pages_tech`、`docx_biz`/`pdf_biz`/`pdf_pages_biz`;全量键名不变;**pdf 转换失败时显式置 None 只清本册的 pdf/pdf_pages 键**(merge reducer 只增不删的既有铁律)
- 章节分组口径:`group === "tech"` 为技术册,**其余(含未标组)一律商务册**(与预算 `_group_weighted_budgets` 同口径)
- 计费红线:不新增任何计费分支;`shouldChargeExport`/`exportDirty`/`preDeduct` 相关代码一行不改
- 提交规范:Conventional Commits、英文、作者 `lookfree <etwuman@126.com>`、不含任何 Claude 字样;函数 ≤80 行;关键注释中文

---

### Task 1: render_docx 的 scope 参数

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/render/docx.py`(`render_docx` 签名与封面/页脚/章标题三处)
- Test: `services/agent/tests/agents/bidding_agent/test_docx_render.py`(追加,样板抄同文件既有断言手法——该文件已有解包 docx 断言文本的帮助函数,先读再写)

**Interfaces:**
- Produces: `render_docx(outline, chapters, *, meta=None, package=None, credentials=None, fmt=None, scope: str = "full") -> bytes`。scope 影响:①封面项目名与页脚文档名追加 `·技术标部分`/`·商务标部分`;②章标题不再带 `（技术标）/（商务标）`尾巴;③其余(签章页/AI 页/credentials 渲染逻辑)不变——**章节过滤与 credentials 取舍是调用方(Task 2)的职责,渲染器只管当下拿到的数据**
- Consumes: 现状 `render_docx`(docx.py:329 起)——封面 `_style_cover(doc, meta, package)`、页脚 `_add_page_number_footer(doc, meta.get("name", "投标文件"))`、章标题 `doc.add_heading(f"{ch.get('no','')} {ch.get('title','')}（{group}）", level=1)`

- [ ] **Step 1: 写失败测试**(追加到 test_docx_render.py,断言用该文件既有的 docx 文本解包帮助函数;下面以 `_doc_text(data)` 指代——按文件真实名字替换)

```python
def test_scope_tech_adds_volume_suffix_and_drops_group_tags():
    """分册(spec 2026-08-08-export-scope):技术册封面/页脚带「·技术标部分」,
    章标题不再带「（技术标）」尾巴——整册同组,逐章带尾巴是噪音。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "技术方案", "group": "tech"}]}
    data = render_docx(outline, {"t1": "<p>正文</p>"},
                       meta={"name": "XX项目投标文件"}, scope="tech")
    text = _doc_text(data)
    assert "XX项目投标文件·技术标部分" in text
    assert "（技术标）" not in text
    assert "投标人承诺与签章" in text          # 签章页每册都要(已拍板:独立提交物)


def test_scope_business_suffix_and_signature_kept():
    outline = {"chapters": [{"id": "b1", "no": "第一章", "title": "报价说明", "group": "business"}]}
    data = render_docx(outline, {"b1": "<p>正文</p>"},
                       meta={"name": "XX项目投标文件"}, scope="business")
    text = _doc_text(data)
    assert "·商务标部分" in text and "（商务标）" not in text
    assert "投标人承诺与签章" in text


def test_scope_full_output_is_byte_identical_to_today():
    """缺省/显式 full 与改动前逐字节一致——老调用方零感知(Global Constraints)。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "技术方案", "group": "tech"}]}
    chapters = {"t1": "<p>正文</p>"}
    meta = {"name": "XX项目投标文件"}
    assert render_docx(outline, chapters, meta=meta) == render_docx(outline, chapters, meta=meta, scope="full")
    text = _doc_text(render_docx(outline, chapters, meta=meta, scope="full"))
    assert "（技术标）" in text and "·技术标部分" not in text
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_docx_render.py -q -k scope`
Expected: FAIL,`TypeError: render_docx() got an unexpected keyword argument 'scope'`

- [ ] **Step 3: 实现**——`render_docx` 加 `scope: str = "full"` 形参;函数体开头算一次:

```python
    # 分册(spec 2026-08-08-export-scope):后缀进封面与页脚,组尾巴单册不带(整册同组是噪音)
    _SCOPE_SUFFIX = {"tech": "·技术标部分", "business": "·商务标部分"}
    suffix = _SCOPE_SUFFIX.get(scope, "")
    if suffix:
        meta = {**meta, "name": f"{meta.get('name', '投标文件')}{suffix}"}
```

章标题行改为:

```python
        tag = f"（{group}）" if scope == "full" else ""
        doc.add_heading(f"{ch.get('no', '')} {ch.get('title', '')}{tag}", level=1)
```

(`_style_cover`/`_add_page_number_footer` 都消费 `meta["name"]`,后缀在 meta 上改一次两处同时生效——若 `_style_cover` 有独立取名逻辑,先读函数确认后按同口径落点)

- [ ] **Step 4: 跑测试确认通过 + 渲染相关全量**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_docx_render.py tests/agents/bidding_agent/test_export_node.py -q`
Expected: 全绿(既有测试不许因加参而红)

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/render/docx.py services/agent/tests/agents/bidding_agent/test_docx_render.py
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(agent): render_docx scope volumes with title suffix and clean headings"
```

---

### Task 2: 导出节点按 scope 过滤与分键产物

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/export.py`(export_node 内)
- Test: `services/agent/tests/agents/bidding_agent/test_export_node.py`(追加;样板抄同文件既有 export_node 测试的 ctx/storage mock 手法,先读再写)

**Interfaces:**
- Consumes: Task 1 的 `render_docx(..., scope=...)`;现状 export_node(export.py:70 起):`run_input`、`artifacts = {"docx": key}`、pdf 失败显式 `artifacts["pdf"] = None; artifacts["pdf_pages"] = None`
- Produces: `run_input.export_scope` 消费;scope != full 时——①章节过滤 `[c for c in chapters_list if (c.get("group") == "tech") == (scope == "tech")]`;②产物键带后缀 `_tech`/`_biz`(docx/pdf/pdf_pages 三键;pptx 不分册,仅 full 语义保留现状);③过滤后为空抛 `RuntimeError("该册没有章节，无法导出")`(前端本已置灰,这里是防御)

- [ ] **Step 1: 写失败测试**(追加到 test_export_node.py;按同文件既有 mock 形态构造 state/ctx)

```python
async def test_scope_tech_filters_chapters_and_writes_suffixed_keys(...):
    """技术册:只渲 group=tech 章;产物键 docx_tech/pdf_tech/pdf_pages_tech,
    与全量键并存(artifacts merge reducer);render_docx 收到 scope='tech'。"""
    # state.outline 两章(t1 tech / b1 business),run_input={"export_scope": "tech"}
    # 断言:render_docx 被调时 outline 只含 t1 且 scope=="tech";
    #      返回 artifacts 的键集合 == {"docx_tech", "pdf_tech", "pdf_pages_tech"}(pdf mock 成功时)
    #      或 pdf mock 失败时 {"docx_tech", "pdf_tech": None, "pdf_pages_tech": None} 显式置空**本册键**


async def test_scope_business_takes_untagged_chapters(...):
    """未标组章节归商务册(与预算口径一致)。run_input export_scope='business',
    outline 含 group='tech' 与无 group 字段各一章 → 渲染只收无组那章;键带 _biz。"""


async def test_scope_default_full_unchanged(...):
    """缺省无 export_scope:行为与今天逐字节一致——键集合 {"docx","pdf","pdf_pages"},
    render_docx 收到 scope='full'、章节未过滤。既有全量测试同时守护此项。"""


async def test_scope_with_no_matching_chapters_raises(...):
    """全部章节同组时另一册为空 → RuntimeError(防御;前端本已置灰不该到这)。"""
```

(四个测试的 mock/断言写全——上面注释是行为规格,不是允许留空的占位;render_docx 用 monkeypatch 捕参,storage/upload 用同文件既有假件)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_export_node.py -q -k scope`
Expected: FAIL(export_node 尚不认识 export_scope)

- [ ] **Step 3: 实现**(export_node 内,渲染调用前后)

```python
        scope = run_input.get("export_scope") or "full"
        outline = state.get("outline") or {}
        if scope in ("tech", "business"):
            # 分组口径与预算一致:tech 组进技术册,其余(含未标组)归商务册
            wanted = [c for c in outline.get("chapters", [])
                      if (c.get("group") == "tech") == (scope == "tech")]
            if not wanted:
                raise RuntimeError("该册没有章节，无法导出")
            outline = {**outline, "chapters": wanted}
        sfx = {"tech": "_tech", "business": "_biz"}.get(scope, "")
```

渲染调用改传过滤后的 `outline` 与 `scope=scope`;三个产物键统一 `f"docx{sfx}"`/`f"pdf{sfx}"`/`f"pdf_pages{sfx}"`(含失败置 None 分支——**None 只落本册键**);上传的文件名同步 `f"bid{sfx}.docx"` 等,避免不同册覆盖同一 MinIO 对象名;pptx 分支不动。

- [ ] **Step 4: 跑测试确认通过 + agent 全量**

Run: `cd services/agent && uv run pytest tests -q`
Expected: 全绿(基线 786 上下)

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/nodes/export.py services/agent/tests/agents/bidding_agent/test_export_node.py
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(agent): scoped export filters chapters and writes per-volume artifacts"
```

---

### Task 3: App API 透传 scope + 预告接口

**Files:**
- Modify: `apps/api/src/routes/projects.ts`(export 步 input 组装处——搜 `exportCredentials(` 的调用点,scope 透传与 credentials 取舍都在那一处;步启动请求体 zod schema 加 `export_scope`)
- Modify: `apps/api/src/routes/projects.ts`(新增 `GET /:id/export-preview`)
- Test: `apps/api/test/export-scope.test.ts`(新建;建项目/步启动的样板抄 apps/api/test 里既有 projects 相关测试,先读再写)

**Interfaces:**
- Consumes: 现状 `credentialsRunInput(userId)`(services/credentials.ts,返回 `CredentialInput[] | undefined`);export 步 input 组装;`ownProject` 类归属校验(照同文件其他 GET 路由)
- Produces: ①步启动 body 可带 `export_scope`(zod `z.enum(["full","tech","business"]).optional()`),落 `input.export_scope`;**scope==="tech" 时不调用/不下发 credentials**;②`GET /projects/:id/export-preview` → `200 {credentials: [{title: string, imageCount: number}]}`(无资质条目回 `{credentials: []}`;归属校验他人项目 404)

- [ ] **Step 1: 写失败测试**(export-scope.test.ts;三段各自写全)

```typescript
// ① scope 透传:mock createRun 捕获 input,断言 export_scope==="tech" 且 input 无 credentials 键
// ② scope 缺省/full:input 无 export_scope 或为 "full",credentials 照旧下发(有资质条目时)
// ③ export-preview:资质条目 2 项(各 1 图)→ {credentials:[{title,imageCount:1}×2]};他人项目 404
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test ./test/export-scope.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——input 组装处(exportCredentials 调用点)改为:

```typescript
    ...(step === "export"
      ? {
          ...(body.export_scope && body.export_scope !== "full" ? { export_scope: body.export_scope } : {}),
          // 技术册不带资质附录(spec 分册规则:暗标风险)——数据层取舍,渲染层无需感知
          ...(body.export_scope === "tech" ? {} : await exportCredentials(userId)),
        }
      : {}),
```

预告接口(与同文件其他 GET 同款归属校验后):

```typescript
  r.get("/:id/export-preview", async (c) => {
    const p = await ownProject(c.req.param("id"), c.get("user").id)   // 按同文件真实归属函数名
    if (!p) return c.json({ error: "not_found" }, 404)
    const credentials = (await credentialsRunInput(c.get("user").id)) ?? []
    return c.json({ credentials: credentials.map((x) => ({ title: x.title, imageCount: x.images.length })) })
  })
```

- [ ] **Step 4: 跑测试确认通过 + 相关文件回归**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test ./test/export-scope.test.ts && bun run typecheck`
Expected: 全绿、类型干净(全量回归留给终审前统一跑,积分污染基线口径见记忆)

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/projects.ts apps/api/test/export-scope.test.ts
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(api): thread export scope and add export preview endpoint"
```

---

### Task 4: 前端三选一 + 预告区 + 分册下载

**Files:**
- Modify: `apps/web/app/(tool)/content/use-export.ts`(scope 状态与请求体)
- Modify: `apps/web/app/(tool)/content/page.tsx`(导出弹窗:三选一、预告区、置灰;下载区按产物键出按钮)
- Create: `apps/web/lib/export-scope.ts`(纯函数:置灰判定与产物键映射——可单测)
- Test: `apps/web/test/export-scope.test.ts`(新建)

**Interfaces:**
- Consumes: Task 3 的 `GET /projects/:id/export-preview`;`artifactDownload`(lib/project.ts:458,先读签名照用);页面已加载的 outline 章节数据(chapter-nav 在用的那份,含 group)
- Produces(export-scope.ts,纯函数):

```typescript
export type ExportScope = "full" | "tech" | "business"

/** 各 scope 是否可选:tech 册要有 tech 章,business 册要有非 tech 章(未标组归商务,与后端同口径)。 */
export function scopeAvailability(chapters: { group?: string }[]): Record<ExportScope, boolean> {
  const tech = chapters.some((c) => c.group === "tech")
  const biz = chapters.some((c) => c.group !== "tech")
  return { full: chapters.length > 0, tech, business: biz }
}

/** scope → 产物键(docx/pdf/pdf_pages),与 agent 侧键后缀一致。 */
export function artifactKeys(scope: ExportScope): { docx: string; pdf: string; pdfPages: string } {
  const sfx = scope === "tech" ? "_tech" : scope === "business" ? "_biz" : ""
  return { docx: `docx${sfx}`, pdf: `pdf${sfx}`, pdfPages: `pdf_pages${sfx}` }
}
```

- [ ] **Step 1: 写失败测试**

```typescript
// apps/web/test/export-scope.test.ts
import { describe, expect, test } from "bun:test"
import { artifactKeys, scopeAvailability } from "../lib/export-scope"

describe("scopeAvailability", () => {
  test("未标组章节归商务册(与后端/预算同口径)", () => {
    expect(scopeAvailability([{ group: "tech" }, {}])).toEqual({ full: true, tech: true, business: true })
  })
  test("全 tech 时商务册置灰", () => {
    expect(scopeAvailability([{ group: "tech" }])).toEqual({ full: true, tech: true, business: false })
  })
  test("空提纲全部置灰", () => {
    expect(scopeAvailability([])).toEqual({ full: false, tech: false, business: false })
  })
})

describe("artifactKeys", () => {
  test("全量键名不变(兼容),分册带后缀", () => {
    expect(artifactKeys("full")).toEqual({ docx: "docx", pdf: "pdf", pdfPages: "pdf_pages" })
    expect(artifactKeys("tech").docx).toBe("docx_tech")
    expect(artifactKeys("business").pdf).toBe("pdf_biz")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test ./test/export-scope.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现纯函数模块**(上面 Interfaces 里的代码原样落 `lib/export-scope.ts`,文件头加中文注释注明 spec 出处),跑 Step 1 测试至绿

- [ ] **Step 4: 弹窗与下载接线**(use-export.ts + page.tsx;JSX 无组件测试设施,靠 typecheck+build 守护)

- use-export.ts:加 `const [exportScope, setExportScope] = useState<ExportScope>("full")`;导出请求体在现有 format 参数旁带 `export_scope: exportScope`;暴露 `exportScope/setExportScope`
- 弹窗(page.tsx `exportOpen &&` 区):
  - 三选一(radio/分段控件,风格抄弹窗内现有 word/pdf 选择器):全量标书/技术标册/商务标册;用 `scopeAvailability(章节数据)` 置灰不可选项,置灰项 title 提示"本项目无技术标章节"/"本项目无商务标章节"
  - **预告区**:挂载弹窗时 fetch `export-preview`(失败静默,预告区只少资质那一行,不挡导出);渲染——

```tsx
  {/* 导出预告(spec 方案A):导出会自动附加的内容,所见即所得的告知面 */}
  <div className="mt-3 rounded-md bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
    <p>导出将自动附加:封面、目录、投标人承诺与签章页、AI 生成说明页</p>
    {exportScope !== "tech" && preview?.credentials?.length ? (
      <p className="mt-1">
        资质证照附录 {preview.credentials.length} 项:
        {preview.credentials.map((x) => x.imageCount > 1 ? `${x.title}×${x.imageCount}` : x.title).join("、")}
      </p>
    ) : null}
    {exportScope === "tech" && <p className="mt-1">技术标册不附资质证照(暗标惯例)</p>}
  </div>
```

  - 下载:导出成功后按 `artifactKeys(exportScope)` 的键取产物调用 `artifactDownload`;下载区遍历已存在的产物键(全量/技术/商务)逐个出按钮,标签"下载 Word(技术标册)"等;现有 `pdfUnavailable` 判定改为按本次 scope 的 pdf 键判定
- [ ] **Step 5: 全量测试 + 类型 + 构建**

Run: `cd apps/web && bun test test/ && bun run typecheck && bun run build 2>&1 | tail -3`
Expected: 全绿、编译过

- [ ] **Step 6: 提交**

```bash
git add apps/web/lib/export-scope.ts "apps/web/app/(tool)/content/use-export.ts" "apps/web/app/(tool)/content/page.tsx" apps/web/test/export-scope.test.ts
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(web): scoped export picker with auto-appended sections preview"
```

---

### Task 5: 发版 230 + 实机验收(与 PDF 转页图功能同批;**发版时机等用户明示**)

**Files:** 无代码;操作任务。

- [ ] **Step 1: 空档发版**(铁律:在途任务非空不发;web 有改动须走 mbp amd64 构建送镜像,api/agent 230 原生构建)

- [ ] **Step 2: 实机验收清单**

1. 有技术+商务两组章节的项目:导出弹窗三选一可用,预告区列出恒定项;选商务册时资质附录行出现(资料库有资质条目时)
2. 依次导技术册、商务册:**第一次扣 20 分,第二次免费**(积分明细核对——脏标记口径)
3. 技术册文件:封面"·技术标部分"、无商务章、章标题无"(技术标)"尾巴、无资质附录、**有**签章页与 AI 页
4. 商务册文件:对应反向断言,资质附录在(资料库有资质条目时)
5. 全量导出与改动前一致(标题无后缀、组尾巴在、附录在)
6. 下载区三册按钮并存;全 tech 项目的商务册选项置灰
