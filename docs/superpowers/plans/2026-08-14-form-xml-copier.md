# 表单章复印机实施计划

> 对应设计：`docs/superpowers/specs/2026-08-14-form-xml-copier-design.md`
> 执行方式：按任务顺序 TDD（先失败测试后实现），每任务一提交。

**Goal:** 纯格式表单章导出与招标 docx 逐字节同源；空位由代码按资料库/项目信息填写。

**全局约束**

- 函数 ≤80 行、文件 ≤800 行；关键方法中文注释记案由。
- 任何一步失败回退现有 HTML 渲染路线，导出步失败面不得扩大。
- 填空绝不虚构：匹配不上留白；模板固定字符一个不改。
- 验收=云上江西+潍坊两份真实标书回放。

---

### Task 1：解析层「行 → body 节点序号」映射

**Files:** `services/agent/src/agent/parsing/parsers.py`、`parsing/types.py`、
`tests/parsing/test_parsers.py`

- [ ] Block 增加 `src: int`（来源 body 子节点序号；表格行共号），`_docx_lines_in_order` 填充
- [ ] clauses 派生时把 src 带出（`split_docx_blocks` 透传，clause dict 增 `src` 键）
- [ ] 测试：段落/表格行/识别文字合成块（synthetic 块 src 取插入锚点）的 src 断言
- [ ] 全量解析测试不回归；提交

### Task 2：form_locate 输出节点区间

**Files:** `nodes/form_locate.py`、`tests/.../test_form_locate.py`

- [ ] `find_form_segment`/`slice_single_form` 在既有返回上补「起止 clause 的 src 区间」
      （新入口或扩展返回，旧调用方零改动）
- [ ] 测试：云上真实 fixture 上断言各表单的节点区间单调且互不重叠
- [ ] 提交

### Task 3：XML 抽取 + 深拷贝搬运

**Files:** 新 `services/agent/src/agent/render/form_copier.py`（或 bidding_agent/render 下）、
新测试 `test_form_copier.py`

- [ ] `extract_form_xml(tender_docx: bytes, span: tuple[int,int]) -> list[element]`
- [ ] `graft_into(doc, elements, at_chapter)`：deepcopy 插入；含 numPr/blip → 抛 `CopierUnsupported`
- [ ] 测试：真实形态模板（表格+下划线+居中）搬运后逐字节文本一致、表格结构保留；
      含编号列表 → 抛回退信号
- [ ] 提交

### Task 4：代码填空引擎

**Files:** `form_copier.py` 续、测试续

- [ ] `fill_blanks(elements, fields: list[tuple[str,str]], meta: dict) -> int`：
      段落型（标签：＋下划线 run）与表格型（标签格右侧空格）两类；返回命中数
- [ ] 标签识别复用保真闸的宽度归一；写入保留 run 格式；括注不替换
- [ ] 测试：企业信息七字段真实形态逐一命中；无匹配留白；模板字符零改动断言
- [ ] 提交

### Task 5：导出步接线 + 回退 + 观测

**Files:** `render/docx.py`（或导出编排处）、`nodes/…`、App `apps/api/src/routes/projects.ts`
（form_pristine 下发）、双端测试

- [ ] App：导出触发时比较各章 HTML 与 content 结果，`form_pristine: [chapterId]` 进 run_input
- [ ] agent：pristine 表单章走复印机（取 tender key→下载→定位→搬运→填空）；
      异常回退 HTML 并记 `form_copier_fallback{chapter,reason}`；成功记 `form_copier_ok{chapter,filled}`
- [ ] 非 docx 招标文件直接走现有路线
- [ ] 测试：pristine/手改/非 docx/含 numPr 四条路径
- [ ] 提交

### Task 6：真实回放验收 + 发版

- [ ] 云上江西回放：导出 docx 表单章与招标原文对照（表格/下划线/居中/填值）
- [ ] 潍坊回放：PDF 模板自然回退路径不回归
- [ ] 全量测试绿 → 提交 → 发 230 → 独立核验 + 用户实测
