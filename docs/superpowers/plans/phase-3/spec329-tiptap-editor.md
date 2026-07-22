# spec329 · 正文编辑器重构（TipTap）实现计划

**Goal:** 把标书生成页的自研 contenteditable 编辑器换成 **TipTap（MIT,ProseMirror 内核）**,一次性解决：
表格编辑升级（**合并/拆分单元格、拖拽列宽、表头行**）、字号/加粗等作用于选区的稳定性、
选区/焦点顽疾（2026-07-22 一天修了三个「插到顶部」bug 的根因——裸 contenteditable + 已废弃的
execCommand + React 重建 DOM 摧毁选区）、内建撤销重做。

## 设计约束（不变量）

- **存储格式不变**：章节正文仍是 HTML（`<h1-h4>/<p>/<ul>/<table>/<img data-url>`）。TipTap `getHTML()` 落库、
  `setContent()` 装载——与 agent 生成、DB 存储、docx 导出、字数统计全链路直接兼容,**零后端改动**。
- 计费/保存语义不变：失焦自动保存(getHTML 与上次一致则跳过);AI 改写替换正文;改写覆盖前入章节快照栈
  （「回退」兜底,TipTap history 在章节切换时重置,跨保存回退仍靠快照）。
- 插入位置语义升级：TipTap 在失焦时仍保留文档内选区状态——资料库/图片/表格插入天然落在光标处,
  删除 use-editor-insert 的 capture/restore 补丁。
- 公网带宽差：新增依赖只进构建产物(~130KB gz 级),不引运行时外部资源。

## Tasks

- [ ] T1 依赖 + RichEditor 组件：`@tiptap/react` v3 + StarterKit + Table(含 resizable)+ Image + TextStyle
      + 自定义 FontSize 扩展;受控装载(章节切换 setContent)、onBlur 回调吐 HTML;编辑器表格样式(网格线/拖宽手柄)。
- [ ] T2 工具栏重写：映射 TipTap 命令(加粗/斜体/小标题/列表/撤销/字号/插图/插表格/从资料库插入/全屏);
      光标在表格内浮出表格条(加删行列/合并拆分单元格/表头行切换);删除 mousedown-preventDefault 族补丁。
- [ ] T3 page.tsx 接线：替换 contenteditable div;资料库/图片插入走 `insertContent`;AI 改写 `setContent`
      + 快照回退;保存/撤销/全屏/字数统计/体检导出全链路回归;清掉 exec/execCommand/use-editor-insert 死代码。
- [ ] T4 验证与部署：web typecheck+全部测试绿;mbp 构建(确认 npm 依赖可拉)→230 发布;
      手工验证清单(表格合并拆分/拖宽/字号/插入位置/撤销/AI改写/导出 docx 表格保真)。
- [ ] T5 勾账本文件;docs 镜像 mbp。

## 验收

- 表格:可视化合并/拆分单元格、拖拽列宽、加删行列、表头行;导出 docx 表格结构保真(渲染器既有 table 路径)。
- 插入(资料库/图片/表格)永远落在光标处;字号只作用于选中文字;撤销重做原生顺滑。
- 章节切换/AI 改写/失焦保存/全屏/字数统计与今天行为一致;后端与导出链零改动。
