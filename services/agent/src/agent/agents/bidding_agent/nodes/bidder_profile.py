"""投标人信息：取自资料库「常用文本」里标题写着企业信息那类条目，供表单章填空。

表单章（响应函/授权书/报价表…）的空位大多要填同一组东西：单位名称、统一社会信用代码、
法定代表人、住所、开户行。这些**由用户自己在资料库录入**，不从营业执照图片的 OCR 结果里抠
——OCR 认错一个字，投标函上的单位名称就是错的，而这种错要到评标现场才发现。

字段不做归一：用户在条目里写什么标签，就原样发什么。系统去猜「单位名称 / 公司名称 /
投标人名称」哪个才算数，只会在猜错时悄悄填错值；原样透传则是所见即所得。
"""

from __future__ import annotations

import re

# 「标签：值」——常用文本的 body 里用户多半就是这么写的。冒号半/全角都认。
# 值**不设长度上限**，超长在下面统一截断：写成 (\S.{0,60})$ 的话，一条长注册地址会整行匹配失败、
# 字段被静默丢掉，而结构化 fields 那条路是截断的——同一份数据两条路给出不同结果。
_LINE = re.compile(r"^\s*([^：:]{2,12})\s*[：:]\s*(\S.*)$")
_MAX_LINES = 30          # 一份企业信息不该有几十条；超出多半是把方案正文塞进来了
_MAX_VALUE = 60


def _pairs_of(item: dict) -> list[tuple[str, str]]:
    """单个条目 → [(标签, 值)]。优先结构化 fields，其次按行解析 body。"""
    out: list[tuple[str, str]] = []
    for field in item.get("fields") or []:
        # 非 dict 元素（历史数据/直连库写入，PUT 的 zod 是唯一守卫）不能炸掉整步：
        # _shared_blocks 在 gather 之前跑，且没有 _chapter_brief 那种「只废本章」的隔离。
        if not isinstance(field, dict):
            continue
        label = str(field.get("label") or "").strip()
        value = str(field.get("value") or "").strip()
        if label and value:
            out.append((label, value[:_MAX_VALUE]))
    for line in str(item.get("body") or "").splitlines():
        found = _LINE.match(line)
        if found:
            out.append((found.group(1).strip(), found.group(2).strip()[:_MAX_VALUE]))
    return out


def bidder_fields(company_items: list) -> list[tuple[str, str]]:
    """常用文本·企业信息条目 → [(标签, 值)]，同名标签保留先出现的那个。"""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for item in company_items or []:
        if not isinstance(item, dict):
            continue
        for label, value in _pairs_of(item):
            if label in seen:
                continue
            seen.add(label)
            out.append((label, value))
            if len(out) >= _MAX_LINES:
                return out
    return out


def profile_block(company_items: list) -> str:
    """→ 表单章简报里的【投标人信息】段。无条目返回空串（简报逐字节不变）。"""
    fields = bidder_fields(company_items)
    if not fields:
        return ""
    return ("【投标人信息】（取自资料库·常用文本的企业信息，填写表单空位时**照此填写**，"
            "不得改写模板的固定文字；这里没有的字段，把模板原有的空位留着不要编）：\n"
            + "\n".join(f"- {label}：{value}" for label, value in fields))


# 被授权人识别关键词：人员条目的标题/meta/tags 命中即认（2026-08-14 用户实测：胡月在库,
# 标注「被授权人」,授权书的「全权代表姓名」空位却没得填——企业信息里没有人名字段）。
_REP_HINTS = ("被授权人", "全权代表", "委托代理", "授权代表")


def authorized_rep_fields(personnel_items: list) -> list[tuple[str, str]]:
    """人员条目 → 授权书空位可填的字段对。只取第一个命中被授权人关键词的条目,
    人名即条目标题;查不到给空——绝不拿随便一个人名凑数。"""
    for item in personnel_items or []:
        if not isinstance(item, dict):
            continue
        hint = f'{item.get("title") or ""} {item.get("meta") or ""} {item.get("tags") or ""}'
        name = str(item.get("title") or "").strip()
        if name and any(k in hint for k in _REP_HINTS):
            return [("全权代表姓名", name), ("全权代表", name),
                    ("委托代理人", name), ("被授权人", name), ("授权代表姓名", name)]
    return []
