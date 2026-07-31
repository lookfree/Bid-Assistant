from __future__ import annotations

from pptx.dml.color import RGBColor

# 述标模板样式表：模板不只是换配色，**版式结构本身要不同**——此前 blue/tech/gov 只差三个颜色，
# 用户选来选去每页长得一模一样，等于没得选。
#
# 三套按述标场景取型（通用商务版式惯例，非任何第三方模板的复制）：
#   blue 商务提案 —— 最通用的商业投标：左侧竖色条起标题，浅底卡片，克制。
#   gov  党政庄重 —— 政府/军队/事业单位采购：顶部通栏色带 + 居中标题，描边卡片，仪式感。
#   tech 技术数据 —— IT/信息化/系统集成：深色底浅色字，细线标题，图表在深底上更醒目。
#
# 结构开关的取值都收在这里，渲染层只认这几个枚举，加新模板不必改渲染代码：
#   surface: light | dark      整页底色与文字色系
#   header:  sidebar | band | rule    正文页标题行的处理
#   card:    tint | outline           要点卡片的处理

_WHITE = RGBColor(255, 255, 255)


def _tokens(primary: RGBColor, accent: RGBColor, tint: RGBColor, *,
            surface: str, header: str, card: str, bg: RGBColor | None = None,
            text: RGBColor | None = None, muted: RGBColor | None = None) -> dict:
    """一套模板的完整 token。深色底必须显式给 bg/text/muted——浅底那套颜色放深底上会糊成一片。"""
    light = surface == "light"
    return {
        "primary": primary, "accent": accent, "tint": tint,
        "surface": surface, "header": header, "card": card,
        "bg": bg or (_WHITE if light else RGBColor(15, 23, 42)),
        "text": text or (RGBColor(31, 41, 55) if light else RGBColor(226, 232, 240)),
        "muted": muted or (RGBColor(107, 114, 128) if light else RGBColor(148, 163, 184)),
        "white": _WHITE,
    }


TEMPLATE_TOKENS: dict[str, dict] = {
    # 商务提案：稳重克制，左侧竖条是最不容易出错的标题处理
    "blue": _tokens(RGBColor(31, 78, 155), RGBColor(59, 130, 246), RGBColor(234, 241, 251),
                    surface="light", header="sidebar", card="tint"),
    # 技术数据：深底让图表和数字更跳；卡片走描边，深底上大面积浅色块会太抢
    "tech": _tokens(RGBColor(45, 212, 191), RGBColor(20, 184, 166), RGBColor(30, 41, 59),
                    surface="dark", header="rule", card="outline",
                    bg=RGBColor(15, 23, 42)),
    # 党政庄重：顶部通栏色带 + 居中标题，是这类场合的通行做法
    "gov": _tokens(RGBColor(153, 27, 27), RGBColor(190, 44, 44), RGBColor(252, 235, 235),
                   surface="light", header="band", card="outline"),
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
