from __future__ import annotations

import colorsys

from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

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
#   sweep:   有符号角度（度）               图表色阶从主色出发的色相扫掠方向与幅度

_WHITE = RGBColor(255, 255, 255)
_BLACK = RGBColor(0, 0, 0)


def blend_toward(base: RGBColor, target: RGBColor, ratio: float) -> RGBColor:
    """按比例把 base 色向 target 混合（无法用 pptx 做透明度，用混色近似"80% 透明白"视觉效果）。"""
    return RGBColor(*(round(b * (1 - ratio) + t * ratio) for b, t in zip(base, target)))


def _tokens(primary: RGBColor, accent: RGBColor, tint: RGBColor, *,
            surface: str, header: str, card: str, cover: str, sweep: float = -96.0,
            bg: RGBColor | None = None,
            text: RGBColor | None = None, muted: RGBColor | None = None) -> dict:
    """一套模板的完整 token。深色底必须显式给 bg/text/muted——浅底那套颜色放深底上会糊成一片。"""
    light = surface == "light"
    return {
        "primary": primary, "accent": accent, "tint": tint,
        "surface": surface, "header": header, "card": card, "cover": cover, "sweep": sweep,
        "bg": bg or (_WHITE if light else RGBColor(15, 23, 42)),
        "text": text or (RGBColor(31, 41, 55) if light else RGBColor(226, 232, 240)),
        "muted": muted or (RGBColor(107, 114, 128) if light else RGBColor(148, 163, 184)),
        "white": _WHITE,
    }


TEMPLATE_TOKENS: dict[str, dict] = {
    # 商务提案：深海军蓝比原来的中蓝耐看，强调色压到 #2563EB 后小字标签在浅底上也够对比度。
    # sweep 取负（向青绿一侧）：蓝→青→teal 是最常见的商务图表色阶，不会跑到紫红去。
    "blue": _tokens(RGBColor(0x14, 0x39, 0x6B), RGBColor(0x25, 0x63, 0xEB), RGBColor(0xEE, 0xF3, 0xFA),
                    surface="light", header="overline", card="numbered", cover="fullbleed",
                    sweep=-96.0),
    # 技术方案：深底让图表和数字更跳；要点不填底色，深底上大面积浅色块会太抢。
    # sweep 取正（青绿→蓝→靛）：深色底上这一段最亮也最冷静，往黄绿走会变成荧光色。
    "tech": _tokens(RGBColor(0x2D, 0xD4, 0xBF), RGBColor(0x14, 0xB8, 0xA6), RGBColor(0x1E, 0x29, 0x3B),
                    surface="dark", header="numeral", card="hairline", cover="split",
                    sweep=96.0, bg=RGBColor(15, 23, 42)),
    # 党政庄重：深红 + 烫金。金色压到 #8A6A16 才能在浅底上当正文小字用（更亮的金只能当装饰线）。
    # sweep 取正（红→橙→金）：正好走向本模板的烫金强调色，色阶与主色是同一套语言。
    "gov": _tokens(RGBColor(0x8E, 0x1B, 0x1B), RGBColor(0x8A, 0x6A, 0x16), RGBColor(0xFB, 0xF1, 0xE7),
                   surface="light", header="corner", card="elevated", cover="banner",
                   sweep=96.0),
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


# ---- 设计常量：字号层级 ----

# 字号（pt）。层级靠**字号 × 字重 × 色阶**三档同时拉开——只调字号拉不开层级，
# 三者都平就是"排得整齐但不讲究"。标题≈正文的两倍且加粗；注释比正文小一档且走弱化色，
# 明显退到后面。每个角色一个名字：画法函数里不再出现字面量字号，同一角色在三套模板里一样大。
TYPE = {
    "cover_title": 46,   # 封面主标题：整份 deck 最大的一块字
    "cover_meta": 13,    # 封面投标人/时长信息
    "eyebrow": 12,       # 小标签：封面 overline、正文页 running head、侧栏栏目名
    "section_num": 96,   # 分隔页大号序号
    "section_title": 38,
    "section_lead": 14,
    "page_title": 30,    # 正文页标题
    "lead": 17,          # 要点正文（≤3 条的大卡，字要跟着卡一起放大）
    "body": 15,          # 要点正文（常规；条目再多也不降到这以下，投影上要看得清）
    "note": 12,          # 注释层：数字卡说明、评分点角标——比正文小一档且一律走弱化色
    "stat_value": 34,
    "caption": 10,       # 页码 / AI 提示这类页面附属信息
    "chart_text": 11,    # 坐标轴 / 图例 / 数据标签
}

# 行距（倍数）。字越大行越紧、字越小行越松，否则大标题会松散、小字会挤成一坨。
LEAD = {"title": 0.94, "body": 1.3, "note": 1.34}

# 卡片/圆角/线宽的统一规格。**圆角必须给绝对半径**：pptx 的圆角矩形默认按短边的 16.7% 取圆角，
# 于是 0.5in 高的角标圆角 0.08in、3in 高的数字卡圆角 0.5in——同一页上几种圆角，
# 一眼就是"默认值堆出来的"而不是设计过的。
CARD = {
    "radius": Inches(0.09),
    "gap": Inches(0.18),      # 卡与卡的纵向间距
    "col_gap": Inches(0.3),   # 双栏之间的槽宽
    "pad_x": Inches(0.26),    # 卡内左右留白
    "hairline": Pt(0.75),     # 描边 / 发丝线
    "rule": Pt(2.5),          # 强调短线
}


# ---- 图表色阶 ----

def _rel_luminance(rgb: RGBColor) -> float:
    """WCAG 相对亮度。"""
    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])


def contrast_ratio(a: RGBColor, b: RGBColor) -> float:
    la, lb = _rel_luminance(a), _rel_luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def fit_contrast(rgb: RGBColor, against: RGBColor, target: float = 4.5) -> RGBColor:
    """把 rgb 朝远离 against 的方向逐步压深/提亮，直到对比度达标（最多 24 步，每步 6%）。
    饼图专用：数值标签压在扇区上，而整张图只能有一种标签字色（见 _paint_pie 的说明），
    所以每一块扇区都得自己保证"这一种字色压在我身上读得出来"。"""
    toward = _BLACK if _rel_luminance(against) > 0.4 else _WHITE
    out = rgb
    for _ in range(24):
        if contrast_ratio(out, against) >= target:
            break
        out = blend_toward(out, toward, 0.06)
    return out


# (色相档, 色带)：相邻两项的色相与色带同时不同——饼图里挨着的两块必须一眼可分，
# 只按色相递增排列的话相邻两块只差一档色相，扇区一挨着就分不开。
_PALETTE_STEPS = ((1, 0), (2, 1), (3, 0), (4, 1), (2, 0), (4, 0), (1, 1), (3, 1))
_PALETTE_HUES = 4              # 色相档数：sweep 被均分成这么多档
# 两条色带 (饱和度, 浅底模板明度, 深底模板明度)。第二条不只是"降饱和"，还整体**往安全的一侧
# 让开一档明度**：浅底模板的扇区压白字，越深越安全；深底模板压深字，越浅越安全。
# 只降饱和是不够的——两条带都会被下面的对比度夹逼压到同一个明度上，8 类里就会出现两块几乎同色。
_PALETTE_BANDS = ((0.95, 0.34, 0.62), (0.55, 0.22, 0.78))


def _ramp_color(tokens: dict, step: int, band: int) -> RGBColor:
    """色阶里的一格：色相从**强调色**出发沿 sweep 偏移 step/4 档，饱和度与明度取一条色带。
    从强调色出发（而不是主色）是为了不撞上前两格：主色与强调色是色阶的头两格，
    从它们之后再起步，最近的一格也差着四分之一个 sweep，8 格里没有两格会挨在一起。"""
    r, g, b = (c / 255 for c in tokens["accent"])
    h, _, s = colorsys.rgb_to_hls(r, g, b)
    hue = (h + tokens.get("sweep", -96.0) / 360.0 * step / _PALETTE_HUES) % 1.0
    sat_ratio, light_on_light, light_on_dark = _PALETTE_BANDS[band]
    sat = min(0.95, max(0.28, s * sat_ratio))
    light = light_on_dark if is_dark(tokens) else light_on_light
    return RGBColor(*(round(c * 255) for c in colorsys.hls_to_rgb(hue, light, sat)))


def chart_palette(tokens: dict, n: int, *, label_rgb: RGBColor | None = None) -> list[RGBColor]:
    """n 个系列/扇区的配色：前两格直接用模板主色与强调色（图表和封面、标题条同一套视觉语言），
    其余沿 _PALETTE_STEPS 从强调色扫掠出来——8 类之内不重复取色，也不会有两格挨得分不开。
    label_rgb 给定时（饼图：标签压在扇区上），每一格都压到与标签色 ≥4.5:1 再返回。"""
    out = [tokens["primary"], tokens["accent"]]
    for i in range(max(0, n - 2)):
        step, band = _PALETTE_STEPS[i % len(_PALETTE_STEPS)]
        out.append(_ramp_color(tokens, step, band))
    if label_rgb is not None:
        out = [fit_contrast(c, label_rgb) for c in out]
    return out[:n]
