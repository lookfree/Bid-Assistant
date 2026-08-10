from __future__ import annotations

from pptx.dml.color import RGBColor

# 述标模板样式表：模板不只是换配色，**版式结构本身要不同**——三套此前只差三个颜色，
# 用户选来选去每页长得一模一样，等于没得选。
#
# 三套按述标场景取型（通用商务版式惯例，全部为我们自己的设计）：
#   blue 商务提案 —— 最通用的商业投标：标题带细线小标签（overline），要点卡带大号序号，
#                    封面满幅深蓝——信息密度高、层级清楚，像一本企业实力手册。
#   tech 技术方案 —— IT/信息化/系统集成：深色底浅色字，大号章节数字起标题，要点只用细线分隔、
#                    不填底色，封面左右分栏，大量留白——克制到只剩栅格，图表在深底上最醒目。
#   gov  党政庄重 —— 政府/军队/事业单位采购：角标式标题，要点卡带轻阴影，封面通栏横幅，
#                    深红配烫金——庄重、有仪式感。
#
# 结构开关的取值都收在这里，渲染层只认这几个枚举（未知取值回退各自默认值），加新模板不必改渲染代码：
#   surface: light | dark               整页底色与文字色系
#   header:  overline | numeral | corner   正文页标题行的处理
#   card:    numbered | hairline | elevated  要点卡片的处理
#   cover:   fullbleed | split | banner      封面的骨架

_WHITE = RGBColor(255, 255, 255)


def _tokens(primary: RGBColor, accent: RGBColor, tint: RGBColor, *,
            surface: str, header: str, card: str, cover: str, bg: RGBColor | None = None,
            text: RGBColor | None = None, muted: RGBColor | None = None) -> dict:
    """一套模板的完整 token。深色底必须显式给 bg/text/muted——浅底那套颜色放深底上会糊成一片。"""
    light = surface == "light"
    return {
        "primary": primary, "accent": accent, "tint": tint,
        "surface": surface, "header": header, "card": card, "cover": cover,
        "bg": bg or (_WHITE if light else RGBColor(15, 23, 42)),
        "text": text or (RGBColor(31, 41, 55) if light else RGBColor(226, 232, 240)),
        "muted": muted or (RGBColor(107, 114, 128) if light else RGBColor(148, 163, 184)),
        "white": _WHITE,
    }


TEMPLATE_TOKENS: dict[str, dict] = {
    # 商务提案：深海军蓝比原来的中蓝耐看，强调色压到 #2563EB 后小字标签在浅底上也够对比度
    "blue": _tokens(RGBColor(0x14, 0x39, 0x6B), RGBColor(0x25, 0x63, 0xEB), RGBColor(0xEE, 0xF3, 0xFA),
                    surface="light", header="overline", card="numbered", cover="fullbleed"),
    # 技术方案：深底让图表和数字更跳；要点不填底色，深底上大面积浅色块会太抢
    "tech": _tokens(RGBColor(0x2D, 0xD4, 0xBF), RGBColor(0x14, 0xB8, 0xA6), RGBColor(0x1E, 0x29, 0x3B),
                    surface="dark", header="numeral", card="hairline", cover="split",
                    bg=RGBColor(15, 23, 42)),
    # 党政庄重：深红 + 烫金。金色压到 #8A6A16 才能在浅底上当正文小字用（更亮的金只能当装饰线）
    "gov": _tokens(RGBColor(0x8E, 0x1B, 0x1B), RGBColor(0x8A, 0x6A, 0x16), RGBColor(0xFB, 0xF1, 0xE7),
                   surface="light", header="corner", card="elevated", cover="banner"),
}

DEFAULT_TEMPLATE = "blue"


def tokens_for(template: str | None, deck_template: str) -> dict:
    """模板名 → 完整 token；非法模板名回退 deck.template，再回退 blue。"""
    key = template if template in TEMPLATE_TOKENS else deck_template
    return TEMPLATE_TOKENS.get(key, TEMPLATE_TOKENS[DEFAULT_TEMPLATE])


def is_dark(tokens: dict) -> bool:
    return tokens.get("surface") == "dark"


def on_primary(tokens: dict) -> RGBColor:
    """铺在主色块上的文字色。深色模板的 primary 本身是亮色（青绿），白字会糊，用深底色反白。"""
    return tokens["bg"] if is_dark(tokens) else tokens["white"]
