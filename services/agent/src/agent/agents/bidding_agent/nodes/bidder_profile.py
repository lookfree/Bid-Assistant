"""投标人身份信息：从资料库里营业执照的 OCR 文字抠出来，供表单章填空。

表单章（响应函/授权书/报价表…）的空位大多要填同一组东西：单位名称、统一社会信用代码、
法定代表人、住所。系统里没有「企业基本信息」这种结构化字段（资料库只有资质/业绩/人员/
财务/常用文本/母版六类），但**营业执照的图片是有的，而且已经 OCR 过**（library-ocr.ts
把识别文字写回附件的 ocrText，content 步经 run_input.credentials 下发）。

安全口径——填错单位名称比留空更糟：
  · 必须先认出这确实是一张营业执照（有 18 位统一社会信用代码），否则一个字都不给；
  · 只抠有明确字段名锚定的值，绝不从上下文猜；
  · 抠不到就不写那一行，让模板的空位留着，由用户在编辑器里补。
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# 统一社会信用代码：18 位大写字母数字。它是营业执照的判别特征，也是要填进表单的值本身。
_CREDIT_CODE = re.compile(r"(?<![0-9A-Z])([0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10})(?![0-9A-Z])")
# 字段名与值之间常被 OCR 塞进空格（「名　称」「法定代表人：」），故标签内部允许空白
_FIELDS: dict[str, re.Pattern[str]] = {
    "name": re.compile(r"名\s*称[\s:：]*([^\s:：]{4,40})"),
    "legal_person": re.compile(r"法\s*定\s*代\s*表\s*人[\s:：]*([^\s:：]{2,12})"),
    "address": re.compile(r"(?:住\s*所|地\s*址)[\s:：]*([^\s:：]{6,60})"),
    "capital": re.compile(r"注\s*册\s*资\s*本[\s:：]*([^\s:：]{2,30})"),
}
_LABELS = {"name": "单位名称", "credit_code": "统一社会信用代码",
           "legal_person": "法定代表人", "address": "住所", "capital": "注册资本"}


def _license_text(credentials: list) -> str:
    """资料库条目里营业执照那张图的 OCR 文字。认不出来返回空串。"""
    for entry in credentials or []:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "")
        for img in entry.get("images") or []:
            text = str((img or {}).get("ocrText") or "")
            # 标题写着营业执照，或识别文字里出现「营业执照」字样——两者有一即可，
            # 但最终仍以下面的信用代码为准（认错了不给值，不是给错值）。
            if "营业执照" in title or "营业执照" in text:
                return text
    return ""


def from_credentials(credentials: list) -> dict[str, str]:
    """营业执照 OCR → {字段: 值}。不是营业执照 / 没有信用代码 → 空 dict。"""
    text = _license_text(credentials)
    code = _CREDIT_CODE.search(text)
    if not code:
        return {}          # 没有信用代码就不认这是执照：宁可不填，也不能把识别噪音填进投标函
    out: dict[str, str] = {"credit_code": code.group(1)}
    for key, pattern in _FIELDS.items():
        found = pattern.search(text)
        if found:
            out[key] = found.group(1).strip()
    logger.info("投标人信息取自营业执照 OCR：%s", "、".join(sorted(out)))
    return out


def profile_block(profile: dict[str, str]) -> str:
    """{字段: 值} → 表单章简报里的【投标人信息】段。空 profile 返回空串（简报逐字节不变）。"""
    lines = [f"- {_LABELS[k]}：{v}" for k, v in profile.items() if k in _LABELS and v]
    if not lines:
        return ""
    return ("【投标人信息】（取自资料库营业执照的识别结果，填写表单空位时**照此填写**，"
            "不得改写模板的固定文字；此处没有的字段，把模板原有的空位留着不要编）：\n"
            + "\n".join(lines))
