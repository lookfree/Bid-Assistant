"""分类知识注入（spec334 机制 / spec335 内容）。

本模块只提供**结构与注入函数**；两张表的内容由 spec335 按条验证后增补。
**表为空时两个函数返回空串**，全链路逐字节等同于未启用分类——管线因此可以独立上线、独立验收。

取主类别还是主次都取，规则只有一条：**产出「写什么」的取主类别，产出「查什么」的主次都取。**
写作侧两套并行会让标书结构和口径打架；检查侧多查一条只是多看一眼，漏一条是废标。
"""
from __future__ import annotations

CATEGORY_LABEL = {"goods": "货物", "services": "服务", "engineering": "工程"}

# 用途：chapters=必备章节（提纲） / planning=章节层面要点（正文规划轮） /
#       writing=落笔要点（正文子写手） / review=必查项（审查） / checklist=投递前核对项
PURPOSE_TITLE = {
    "chapters": "通行必备章节",
    "planning": "写作要点",
    "writing": "落笔要点",
    "review": "必查项",
    "checklist": "投递前核对项",
}

# 只有「查什么」的用途取主次两类；「写什么」的只取主类别
_BOTH_CATEGORIES = ("review", "checklist")

# 知识条目：{category, purpose, status, text}
#   status: "verified" 已核到现行法规原文或我们自己的真实标书 / "unverified" 仅行业通行做法
#   text:   **只写要求本身**，不写两份文案——措辞由下面的模板按 status 套，存两份会写漂
CATEGORY_KNOWLEDGE: list[dict] = [
    # ── 货物标 ───────────────────────────────────────────────────────────
    {"category": "goods", "purpose": "chapters", "status": "unverified",
     "text": "技术参数响应表与商务条款偏离表**分列两张**，不要合成一张"},
    {"category": "goods", "purpose": "chapters", "status": "unverified",
     "text": "报价明细表须含产地、品牌两列，并附报价说明（价格类型到岸价/出厂价、含税与税率、"
             "运输费含不含、安装调试费含不含）——这几项不写清，评标时按最不利解释"},
    {"category": "goods", "purpose": "chapters", "status": "unverified",
     "text": "设独立章节：货物清单与技术说明、交货及安装方案、质量保证与质保方案、"
             "项目实施方案、同类项目业绩"},
    {"category": "goods", "purpose": "planning", "status": "unverified",
     "text": "交货方案写到 交货周期/地点/方式/运输保护措施；安装调试写到 安装前准备/流程与时间/"
             "调试验收标准/安装人员资质；到货验收给出标准与流程"},
    {"category": "goods", "purpose": "planning", "status": "unverified",
     "text": "售后服务给三段时间（响应 X 小时、到场 X 小时、解决 X 小时），另附定期巡检、"
             "易损件备件清单、培训方案；实施进度按 合同签订→生产备货→运输交货→安装调试→"
             "验收交付→质保服务 六阶段给时间表"},
    {"category": "goods", "purpose": "writing", "status": "unverified",
     "text": "技术参数**逐条**对照招标原文响应，不得自行概括或省略条目；"
             "售后服务条款逐字对标招标文件，不套模板"},
    {"category": "goods", "purpose": "review", "status": "unverified",
     "text": "中小企业声明函须填列**所有主材/设备制造商**，不是只填投标人自己"},
    {"category": "goods", "purpose": "review", "status": "unverified",
     "text": "质保期不低于招标要求、交货期不迟于招标要求"},
    {"category": "goods", "purpose": "review", "status": "unverified",
     "text": "技术参数逐条响应且无负偏离；报价表的产地/品牌与技术响应表一致"},
    {"category": "goods", "purpose": "checklist", "status": "unverified",
     "text": "中小企业声明函已填列所有制造商（货物标特有，与服务标填法相反）"},
    {"category": "goods", "purpose": "checklist", "status": "unverified",
     "text": "质保期、交货期、技术参数响应均已对标招标文件且无负偏离"},

    # ── 服务标 ───────────────────────────────────────────────────────────
    {"category": "services", "purpose": "chapters", "status": "unverified",
     "text": "按十章骨架成文：项目背景及需求分析（含重点难点及对策）／整体服务设想／"
             "组织机构及人员配备（含人员招聘·培训·考核·替换）／**核心服务方案**／项目管理制度／"
             "服务质量保障措施／应急预案／档案管理方案／服务承诺及投诉处理／同类项目业绩"},
    {"category": "services", "purpose": "chapters", "status": "unverified",
     "text": "**违约责任承诺**须单独成节——多数服务标评标细则把它列为必备，遗漏即该项 0 分，"
             "而它既不在技术方案也不在商务条款里，最容易整章漏掉"},
    {"category": "services", "purpose": "planning", "status": "unverified",
     "text": "十章骨架里只有「核心服务方案」一章因项目而异，其余九章是稳定骨架："
             "按评分办法表的得分点反推该章要写什么，评分项没覆盖到的骨架章节保底保留、简写即可"},
    {"category": "services", "purpose": "writing", "status": "unverified",
     "text": "人员配置写到岗位、人数、资质与排班，与招标要求的编制表逐项对应；"
             "服务响应与考核写成可考核的数字指标，不写「及时响应」这类无法验收的表述"},
    {"category": "services", "purpose": "review", "status": "unverified",
     "text": "人员配置覆盖招标要求的全部岗位与人数"},
    {"category": "services", "purpose": "review", "status": "unverified",
     "text": "服务响应时间对标招标 SLA；关键岗位证书在有效期内"},
    {"category": "services", "purpose": "review", "status": "unverified",
     "text": "中小企业声明函按**是否允许分包**决定填法：不允许分包=只填投标人自己一家；"
             "允许分包=须填全所有分包方。先在招标文件里确认这一条"},
    {"category": "services", "purpose": "review", "status": "unverified",
     "text": "警惕定人定薪陷阱：招标文件若同时锁定「人员不少于 X 人」「月薪不低于 Y 元」"
             "「管理费比例固定」，属变相最低限价——价格分实质失效、利润被锁死，提示用户评估是否值得投"},
    {"category": "services", "purpose": "checklist", "status": "unverified",
     "text": "人员配置表已覆盖招标全部岗位与人数，关键岗位证书均在有效期内"},
    {"category": "services", "purpose": "checklist", "status": "unverified",
     "text": "已确认招标文件是否允许分包，并据此填写中小企业声明函"},

    # ── 工程标 ───────────────────────────────────────────────────────────
    {"category": "engineering", "purpose": "chapters", "status": "unverified",
     "text": "**施工组织设计必须含四大块**：施工方案、进度计划、质量保证、安全文明施工，缺一不可"},
    {"category": "engineering", "purpose": "chapters", "status": "unverified",
     "text": "设独立章节：工程概况及施工特点难点分析／施工进度计划及保证措施／主要施工方案／"
             "质量保证体系及措施／安全文明施工措施／劳动力及物资计划／分包计划（如有）／"
             "竣工验收及回访保修／应急抢险预案／对招标文件的响应及偏离表／同类工程业绩"},
    {"category": "engineering", "purpose": "chapters", "status": "unverified",
     "text": "商务部分含工程量清单报价表、材料价差表、主要材料表"},
    {"category": "engineering", "purpose": "planning", "status": "unverified",
     "text": "「主要施工方案」一章按本工程实际包含的分部分项逐项成节；"
             "**分项清单以招标文件的工程量清单为准**——市政、道路桥梁、装饰装修各有各的分项，"
             "不可照搬房建那一套（房建常见为 测量/土方/基础/主体结构/装饰装修/水电安装/"
             "脚手架/模板/钢筋/混凝土）"},
    {"category": "engineering", "purpose": "writing", "status": "unverified",
     "text": "每个分项施工方案须含三件套：施工工艺流程、质量控制要点、安全注意事项"},
    {"category": "engineering", "purpose": "writing", "status": "unverified",
     "text": "质量保证写到质量目标（一次性验收合格率、工程质量等级）、三检制度、隐蔽工程验收、"
             "质量通病防治；安全文明施工写到安全生产目标、安全管理体系、分项安全措施"
             "（高处作业/用电/机械/消防/基坑支护/脚手架）、文明施工（围挡/扬尘/噪声/污水/现场卫生）；"
             "劳动力计划按工种给人数与进退场时间"},
    {"category": "engineering", "purpose": "review", "status": "unverified",
     "text": "安全生产许可证在有效期内"},
    {"category": "engineering", "purpose": "review", "status": "unverified",
     "text": "项目经理建造师等级/专业与招标要求匹配，且无在建项目冲突"},
    {"category": "engineering", "purpose": "review", "status": "unverified",
     "text": "工程量清单覆盖全部分部分项，无漏项、无不平衡报价"},
    {"category": "engineering", "purpose": "review", "status": "unverified",
     "text": "施工组织设计四大块齐全；安全文明施工措施完整"},
    {"category": "engineering", "purpose": "checklist", "status": "unverified",
     "text": "安全生产许可证与项目经理建造师证书均在有效期内且专业等级匹配"},
    {"category": "engineering", "purpose": "checklist", "status": "unverified",
     "text": "工程量清单逐项核对无漏项，施工组织设计四大块齐全"},
]

# 行业资质补丁：{keywords, item, level, status}
#   命中 keywords 中任一词 ⇒ 追加一条 item。只做资质与陷阱，不做内容指导：
#   资质缺失是废标，且是模型从招标文件正文里推不出来的行业常识。
INDUSTRY_PATCHES: list[dict] = [
    # 已废止条目**不进表**：物业服务企业资质 2017 年起分两次取消核定、2018 年国务院令第 698 号
    # 修改《物业管理条例》删去资质要求。写进去的后果是审查报告报一条假风险，用户信了会去补一个
    # 根本不存在的证——资质是最容易被政策取消的一类知识，偏偏又被定为「高」级别。
    {"keywords": ["劳务派遣", "人力资源", "劳务外包"], "level": "高", "status": "unverified",
     "item": "涉及劳务派遣/人力资源服务的，须提供劳务派遣经营许可证与人力资源服务许可证"},
    {"keywords": ["保安", "安保"], "level": "高", "status": "unverified",
     "item": "涉及保安服务的，须提供保安服务许可证"},
    {"keywords": ["档案整理", "档案数字化", "档案管理"], "level": "高", "status": "unverified",
     "item": "涉及档案整理/数字化的，若项目涉密须提供国家秘密载体印制资质证书"},
    {"keywords": ["土壤调查", "测绘", "土地整治", "土地复垦"], "level": "高", "status": "unverified",
     "item": "涉及测绘/土壤调查的，须提供相应等级测绘资质证书"},
    {"keywords": ["专职消防队", "消防值守", "消防员"], "level": "高", "status": "unverified",
     "item": "涉及消防服务的，关键岗位人员须持消防员职业资格证或消防设施操作员证"},
    {"keywords": ["食堂", "餐饮", "团餐", "配餐"], "level": "高", "status": "unverified",
     "item": "涉及食堂/餐饮服务的，须提供食品经营许可证与从业人员健康证"},
    {"keywords": ["检测", "检验"], "level": "高", "status": "unverified",
     "item": "涉及检测/检验服务的，须提供 CMA 或 CNAS 资质"},
    {"keywords": ["运维", "系统集成", "信息化"], "level": "中", "status": "unverified",
     "item": "涉及 IT 运维/系统集成的，视招标要求提供 ITSS 等运维服务资质"},
    {"keywords": ["保洁", "清洁", "环卫"], "level": "中", "status": "unverified",
     "item": "涉及保洁/清洁服务的，视招标要求提供相关清洁服务资质"},
]

# 提纲注入的附加口径：类型清单只补漏，绝不越过招标文件
_CHAPTERS_NOTE = ("**招标文件构成清单已列出的以清单为准**；清单未提及、且提纲确实缺失的才补为独立章节。")

# 审查/审核表注入的附加口径：不写死这句，模型会把行业经验当成本次招标的明文要求，
# 刷出一堆招标文件根本没要求的「废标风险」——用户信错一次就再也不信体检报告了。
_REVIEW_NOTE = ("**以下是行业经验必查项，不是本次招标的明文要求**："
                "能对上招标条款的按高风险报，对不上的按中风险提醒。")


def _line(entry: dict) -> str:
    """按验证状态套措辞。未经核实的条目**不得以「必须」的口吻出现**——写手对「必须」是无条件
    服从的，一条错的必备章节会让每一本标书都多出一章不该有的内容，而用户看不出那是我们编的
    还是招标文件要求的。"""
    text = entry["text"]
    if entry.get("status") == "verified":
        return f"- 必须：{text}"
    return f"- 通常：{text}（请核对本次招标文件是否有此要求）"


def category_scope(categories: list[str] | None, purpose: str) -> str:
    """分类知识块。categories 为有效值（有序，首元素为主类别）；空或无匹配条目 ⇒ 返回空串。"""
    cats = [c for c in (categories or []) if c in CATEGORY_LABEL]
    if not cats:
        return ""
    take = cats if purpose in _BOTH_CATEGORIES else cats[:1]
    blocks: list[str] = []
    for cat in take:
        rows = [_line(e) for e in CATEGORY_KNOWLEDGE
                if e.get("category") == cat and e.get("purpose") == purpose]
        if not rows:
            continue
        note = _CHAPTERS_NOTE if purpose == "chapters" else (_REVIEW_NOTE if purpose in _BOTH_CATEGORIES else "")
        head = f"\n【{CATEGORY_LABEL[cat]}标 · {PURPOSE_TITLE.get(purpose, purpose)}】"
        blocks.append("\n".join([head + (f" {note}" if note else "")] + rows))
    return "\n".join(blocks)


def industry_patches(text: str) -> str:
    """行业资质补丁：在项目文本里做**字面**匹配（资质是精确术语，正是关键词擅长的场景）。
    未命中 ⇒ 空串。命中多条时按表内顺序输出，同一条只出一次。"""
    if not text:
        return ""
    rows = [f"- （{p.get('level', '中')}）{p['item']}"
            for p in INDUSTRY_PATCHES if any(k in text for k in p.get("keywords", []))]
    if not rows:
        return ""
    return "\n".join([f"\n【行业资质必查项】{_REVIEW_NOTE}"] + rows)
