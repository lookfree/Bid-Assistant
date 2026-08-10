from __future__ import annotations
from dataclasses import dataclass, field


class UnsupportedDocument(Exception):
    pass


# 我们**自己**加进文档文本里的注记的统一前缀（识别文字的来源标注、图片占位、截断提示……）。
# 统一长这个样子，是为了让两件事同时成立：
#   · 模型一眼看出「这是系统加的说明，不是投标文件里的字」（审查提示词按这个前缀讲规则）；
#   · 下游能确定性地认出模型把它当成了文件内容（见 render/sanitize.mentions_system_note）。
# 2026-08-11 生产实测（康恒环境）：注记写成 `[内嵌图片·识别]` 这种像编辑残留的形状，
# 审查模型据此报出「投标文件多处出现章节编号(如 sec-xxx)和内嵌图片标记，未作清理，影响文件
# 整洁性和专业性」——用户的 .docx 里根本没有这些东西，既冤枉用户，也把内部实现漏了出去。
SYSTEM_NOTE_PREFIX = "【系统注记"


@dataclass
class ParsedDoc:
    text: str
    kind: str                                  # docx/pdf/xlsx
    pages: int | None = None
    # 提不出可见文字的页数（扫描图片页）。PDF 才有意义，其余格式恒为 0。
    # 2026-08-09 生产实测：366 页的投标文件有 139 页是扫描件（身份证、授权书、盖章报价表），
    # 这些页的内容对模型完全不可见；审查据此把「文本里找不到」诚实报成「无法核验」，
    # 而不是断言「缺少」——那一批假阳性高风险的根因就在这里。
    image_pages: int = 0
    # 正文里内嵌的图片张数（docx 才有意义，其余格式恒为 0）。docx 里贴的证照/盖章扫描图在解析
    # 结果里一个字都不留——与扫描 PDF 同病：模型把**实际存在**的材料判成「缺少」，只是 docx 连
    # 「有多少页看不见」都没有。**只数正文（body）**：页眉页脚的公司 logo 不在其中，
    # 否则每份 docx 都会挂上一条「有图看不见」的注记。
    embedded_images: int = 0
    # 逐页文本（PDF 才有，其余格式为空）。text 是它按页拼起来的结果，之所以另存一份：
    # 扫描页 OCR 要知道**哪一页**看不见、并把识别文字插回**那一页原来的位置**（见 parsing/ocr.py）。
    page_texts: list[str] = field(default_factory=list)
    # 逐页「这页看不见吗」的判定（PDF 才有，其余格式为空）。**必须在解析时定下来**：混合页的判据
    # 要看页里有没有贴图，而那只有解析时手里的 pypdf 页对象答得出，page_texts 事后再问已经问不到了。
    # 空列表 = 没有这份信息（非 PDF / 旧构造点）→ 下游退回纯字数判据（见 scanned_page_indices）。
    image_page_flags: list[bool] = field(default_factory=list)
    tables: list[list[list[str]]] = field(default_factory=list)
    clauses: list[dict] = field(default_factory=list)  # [{id: "${secId}-cN", text}] 稳定条款 id，供读标/提纲定位
    # 章节标题 [{sec: "sec-N", title, level}]：与 clauses **并列**而不混入其中——标题一旦成为条款就会
    # 挤掉条款序号，既改了 clause_id 口径（定位/引用全线受影响），也让模型把标题当条款读。
    # level：1=第N章/节/篇/部分，2=「一、」式顶层编号。仅供左栏按层级渲染，读标提示词不消费。
    headings: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
