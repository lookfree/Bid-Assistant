# 资料库 PDF 一键转页图 · 设计

2026-08-08 · 状态:已评审通过,待实施

## 背景与目标

资质证书类材料常以 PDF 形态存在(如《网络安全专用产品安全检测证书.pdf》:2 页、每页一张整页扫描图、无文本层)。而标书编辑器"从资料库插入"只认 `.png/.jpg` 附件——PDF 附件插进正文只剩一行文件名,用户以为证照进了标书,审查照样报缺件(2026-08-06 反馈的复发形态)。

**目标**:资料库里的证书类小 PDF 可一键转成页图附件,此后插入正文与普通图片零差别(压缩内嵌/OCR 识别/alt 全复用现有链路)。**转不转由用户点按钮决定**——插入条目会内嵌其全部图片附件,自动转会让"只想存档 PDF"的用户在插入时被灌进页图(评审时用户指出)。

**非目标**(用户拍板):
- 不做选页界面——只服务 ≤5 页的证书类小 PDF,全页转;超页数的 PDF 明示"暂不支持"
- 不做批量补转/后台任务——转换永远由用户在条目编辑器里逐个点按钮触发
  (按钮对存量 PDF 附件同样出现——这是实现的自然结果,不是额外范围)
- 不做插入时现场转换——公网带宽 21–75KB/s,插入时等转换体验差且功能不可发现

## 交互(前端,附件行按钮,不弹窗不打断)

1. 条目编辑器里,`.pdf` 附件行展示按钮「转为图片」与提示文案
   「PDF 需转为图片后才能作为插图进入标书正文」;已转出页图的 PDF 不再显示按钮
2. 点击 → 按钮变"转换中…" → 调转换接口
3. 成功:每页作为**普通图片附件**追加进附件列表,命名 `<原名去.pdf>-第N页.png`,并带 `sourceFileId` 指向原 PDF;原 PDF 附件保留(供下载原件)
4. 失败**明示**(显式动作不静默):按错误码给短提示——"页数超过 5 页,暂不支持转换" /
   "该 PDF 已加密或无法解析" / "转换服务暂不可用,稍后再试";PDF 原样保留
5. 用户不想要某页 → 删除那个附件(现有能力),无需新交互

## 数据流

```
web ──POST /files/:fileId/pdf-pages──▶ App API
      鉴权 + 归属校验 + 文件名 .pdf 校验 + 大小 ≤20MB
                    │ 中转(沿用 agent-client 的内部调用模式)
                    ▼
      agent POST /tools/pdf-pages {key}
      · storage_read.read_bytes(key) 取 PDF
      · pypdfium2 渲染(复用述标预览 render_deck_previews 的 pdf→png 循环,
        抽出独立函数 render_pdf_pages(pdf_bytes, max_pages))
      · 页数 >5 → 报 too_many_pages;加密/解析失败 → 报 unrenderable
      · 逐页渲染(宽 1600px,PNG)写回 MinIO derived/<uuid>/page-N.png
                    │ 返回 {pages: [{key, width, height}]}
      App API 为每页建文件记录(与上传 complete 同一张表/归属)
                    │
      返回 {pages: [{fileId, name}]} → 前端追加附件
```

## 接口契约

**App API `POST /files/:fileId/pdf-pages`**(需登录)
- 校验:文件归属当前用户;文件名 `.pdf` 结尾;大小 ≤20MB
- 成功 `200 {pages: [{fileId, name}]}`(按页序)
- 失败:`400 not_pdf` / `413 too_large` / `422 too_many_pages` / `422 unrenderable` / `502 agent_unavailable`
- 前端按错误码给对应短提示(显式动作不静默);PDF 原样保留

**Agent `POST /tools/pdf-pages`**(内部)
- 入参 `{key: string}`(MinIO 对象键)
- 成功 `200 {pages: [{key, width, height}]}`;业务失败 `422 {error: "too_many_pages" | "unrenderable"}`(App 侧原码透传给前端)
- 常量:页数上限 5;渲染宽 1600px(证书文字对 OCR 可读);超时由调用方控制(App 侧 30s)

## 数据形状

- `LibraryAttachment` 类型拓宽:`{fileId, name, sourceFileId?}`——attachments 是 jsonb,免迁移
- 页图附件 `sourceFileId` = 原 PDF 的 fileId
- **插入层唯一新规则**:某 PDF 附件若存在兄弟附件 `sourceFileId` 指向它,`libraryItemHtml` 的"附件:"行不再列它的文件名——防审查把一份证书数成两份;页图本身命中现有 `isImageAttachment`(`.png`)走既有内嵌链路,零改动

## 边界与失败处理

| 情形 | 行为 |
|---|---|
| 页数 >5 | 提示"页数超过 5 页,暂不支持转换",PDF 保留 |
| 加密 / 损坏 / 渲染失败 | 提示"该 PDF 已加密或无法解析",PDF 保留 |
| agent 不可达 / 超时 30s | 提示"转换服务暂不可用,稍后再试",PDF 保留 |
| 转换中用户关闭弹层 | 转换结果作废不追加(前端组件卸载即弃) |
| 大小 >20MB | 提示"文件过大,暂不支持转换"(证书类不会这么大;防手册拖垮 agent) |
| 已转出页图的 PDF | 不再显示「转为图片」按钮(防重复转出重复页图) |

计费:本功能免费,不产生任何积分变动(资金边界不涉及)。

## 测试

- **App API**:归属校验(他人文件 404);非 PDF 400;agent 报错逐类映射;成功路径建文件记录且归属正确
- **Agent**:≤5 页正常渲染(字节非空、尺寸合理);6 页报 too_many_pages;加密 PDF 报 unrenderable;derived key 形状
- **Web**:`libraryItemHtml` 已转出页图的 PDF 不再列文件名(单测);未转出的 PDF 照旧列出(回归);已转出页图的 PDF 不再显示转换按钮(单测)

## 实施位置

- `services/agent`:`render/preview.py` 抽 `render_pdf_pages` + 新路由 `routes/pdf_pages.py`(挂 main_api,参照 routes/chapters.py)
- `apps/api`:`routes/files.ts` 加端点(参照 /files/ocr 的中转与鉴权形态)
- `apps/web`:`item-editor.tsx` 附件行按钮+提示+错误短提示;`lib/library.ts` 类型拓宽;`use-editor-insert.ts` 插入层跳过规则
