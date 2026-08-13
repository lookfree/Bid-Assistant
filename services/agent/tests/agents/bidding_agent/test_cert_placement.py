"""证照定向插章 post-pass（2026-08-09 资料库定向注入设计,计划③,Task 4）：招标要求命中
证照词表 × 章定位（clause_ids 交集）× 资料库库存三重命中——库有则见下图插占位图,库无则
待补充,定位不到则不动;缓存交互（post-pass 在缓存之外单独跑,fresh/cached 章一律现算）与
sys-creds 排除是本文件的审查专项。
"""
import asyncio

from langchain_core.messages import AIMessage

from agent.agents.bidding_agent.nodes.cert_placement import CERT_KEYWORDS, place_certificates
from agent.agents.bidding_agent.nodes.credentials_chapter import SYS_CREDS_ID


def _chapter(cid: str, title: str, clause_ids: list[str]) -> dict:
    return {"id": cid, "no": "一", "title": title, "group": "business",
            "items": [{"id": f"{cid}-i1", "label": "资质要求", "clause_ids": clause_ids}]}


def _read_with(item_title: str, clause_ids: list[str], key: str = "qualification") -> dict:
    return {"categories": [{"key": key, "title": "资格", "items": [
        {"title": item_title, "value": "", "star": True, "clause_ids": clause_ids}]}]}


class TestPlaceCertificates:
    def test_located_chapter_with_library_stock_appends_see_image_with_ocr_alt(self):
        """①要求"提供营业执照"定位到资格章 + 库有"营业执照"条目 → 该章尾出现见下图 +
        占位图(alt 带 ocr 摘要,截 120 字并转义),其他章不动。"""
        out = {"t1": "<h3>正文</h3>", "t2": "<h3>别的章</h3>"}
        # ocr 前段含需转义字符,后段用不重复的填充字符验证 120 字截断（TAILMARK 必须被切掉）。
        ocr_text = "<script>bad</script>" + "A" * 99 + "TAILMARK"
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"]),
                                     _chapter("t2", "技术方案", ["sec-2-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [
                    {"fileId": "f1", "key": "lib/f1.png", "name": "n", "ocrText": ocr_text}]}]},
        }
        result = place_certificates(out, state)
        assert "【营业执照】见下图：" in result["t1"]
        assert 'data-file-id="f1"' in result["t1"] and 'data-object-key="lib/f1.png"' in result["t1"]
        assert "&lt;script&gt;bad&lt;/script&gt;" in result["t1"], "ocr 摘要未转义"
        assert "<script>bad</script>" not in result["t1"], "原始未转义标签泄漏进 HTML"
        assert "A" * 99 in result["t1"]
        assert "TAILMARK" not in result["t1"], "ocr 摘要没有按 120 字截断"
        assert result["t2"] == out["t2"], "无关章不该被动"

    def test_missing_from_library_appends_placeholder_note(self):
        """②库无匹配条目 → 章尾追加"（待补充：营业执照）"，不出现见下图字样。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": []},
        }
        result = place_certificates(out, state)
        assert "（待补充：营业执照）" in result["t1"]
        assert "见下图" not in result["t1"]

    def test_no_clause_intersection_leaves_chapter_untouched(self):
        """③要求条目 clause_ids 与本章子项 clause_ids 无交集 → 定位不到,章原样不动。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-9-c9"]),   # 与本章无交集
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result = place_certificates(out, state)
        assert result["t1"] == out["t1"]

    def test_no_keyword_hit_leaves_chapter_untouched(self):
        """词表不命中（要求条目标题不含任何证照词）→ 即便 clause 相交也不动,附录/程序性章节
        天然兜底,不会被误插一句无中生有的证照提示。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供项目实施方案", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result = place_certificates(out, state)
        assert result["t1"] == out["t1"]

    def test_sys_creds_chapter_is_never_touched(self):
        """⑤sys-creds 章不被 post-pass 触碰——双信号防御：即使满足三重命中条件也绝不追加
        （纵深兜底同 content_pipeline 净化系统章的手法：system 标记 与 id==SYS_CREDS_ID 各自
        独立生效，即便某一路信号丢了另一路仍能挡住）。"""
        out = {SYS_CREDS_ID: "<h3>附录</h3>"}
        state = {
            "outline": {"chapters": [
                {**_chapter(SYS_CREDS_ID, "资格证明文件", ["sec-1-c1"]), "system": True}]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result = place_certificates(out, state)
        assert result[SYS_CREDS_ID] == out[SYS_CREDS_ID]

        # 纵深兜底：system 键缺省（坏数据/漏透传），仅凭 id 命中 SYS_CREDS_ID 仍要挡住。
        state_no_flag = {
            "outline": {"chapters": [_chapter(SYS_CREDS_ID, "资格证明文件", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result2 = place_certificates(out, state_no_flag)
        assert result2[SYS_CREDS_ID] == out[SYS_CREDS_ID]

    def test_same_chapter_two_requirements_same_keyword_insert_once(self):
        """⑥同章两条要求都命中同一个证照词 → 只插一次,不重复见下图两遍。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1", "sec-1-c2"])]},
            "read": {"categories": [{"key": "qualification", "title": "资格", "items": [
                {"title": "提供营业执照复印件", "value": "", "star": True, "clause_ids": ["sec-1-c1"]},
                {"title": "加盖公章的营业执照", "value": "", "star": False, "clause_ids": ["sec-1-c2"]},
            ]}]},
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        assert result["t1"].count("【营业执照】见下图：") == 1

    def test_heading_anchor_places_image_right_below_the_section_title(self):
        """⑦锚点定向（2026-08-12 云上江西反馈）：章里有「一、营业执照副本扫描件」小节，
        执照图必须插在**那个小节标题正下方**，而不是章尾、更不是只进附录。
        不需要条款交集——章的小节标题本身就是最强的定位信号。"""
        out = {"b3": "<h3>一、营业执照副本扫描件</h3>\n<p>本项提供有效的企业法人营业执照。</p>\n<h3>二、财务状况</h3>"}
        state = {
            "outline": {"chapters": [_chapter("b3", "资格文件", [])]},
            "read": {},
            "run_input": {"credentials": [
                {"title": "上海安几科技有限公司营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        html = result["b3"]
        assert 'data-file-id="f1"' in html
        pos_img = html.index('data-file-id="f1"')
        assert html.index("</h3>") < pos_img < html.index("<h3>二、财务状况</h3>"), \
            "图没有落在营业执照小节标题与下一小节之间"

    def test_attachment_line_with_evidence_word_anchors_the_id_card(self):
        """⑧授权书表单的「附：全权代表人和法定代表人身份证原件扫描件（正、反面）」这一行
        就是要身份证的地方——图插在这行下面。普通散文提到「身份证」（无证据词）不算锚。"""
        out = {"b2": ("<h3>法定代表人授权书</h3>"
                      "<p>授权代表凭身份证办理相关手续。</p>"
                      "<p>附：全权代表人和法定代表人身份证原件扫描件（正、反面）</p>"
                      "<p>说明：法定代表人参加采购，不用提供授权书</p>")}
        state = {
            "outline": {"chapters": [_chapter("b2", "法定代表人证明与授权书", [])]},
            "read": {},
            "run_input": {"credentials": [
                {"title": "法人身份证", "images": [{"fileId": "id1", "key": "k", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        html = result["b2"]
        pos_img = html.index('data-file-id="id1"')
        assert html.index("附：全权代表人") < pos_img, "图没有跟在「附：…扫描件」行后面"
        assert pos_img < html.index("说明：法定代表人"), "图插错了位置"
        # 无证据词的散文提及不是锚：图不该出现在那一段之后、「附」行之前
        assert not (html.index("凭身份证办理") < pos_img < html.index("附：全权代表人"))

    def test_anchor_places_each_entry_only_once_globally(self):
        """⑨两个章都有营业执照小节 → 只进提纲序靠前的那章一次。到处重复插图
        既撑大文件（单张执照几 MB），评委翻到哪都是同一张执照也很难看。"""
        out = {"b3": "<h3>一、营业执照副本扫描件</h3><p>x</p>",
               "b7": "<h3>一、营业执照副本扫描件</h3><p>y</p>"}
        state = {
            "outline": {"chapters": [_chapter("b3", "资格文件", []), _chapter("b7", "附件", [])]},
            "read": {},
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        assert 'data-file-id="f1"' in result["b3"]
        assert 'data-file-id="f1"' not in result["b7"]

    def test_anchored_entry_is_not_appended_again_by_clause_intersection(self):
        """⑩同一份材料被锚点就位后，条款交集通路不得再在章尾追加一份。"""
        out = {"t1": "<h3>一、营业执照副本扫描件</h3><p>x</p>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格文件", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        assert result["t1"].count('data-file-id="f1"') == 1

    def test_table_cell_mention_is_never_an_anchor(self):
        """⑪表格里的「提供营业执照扫描件」不是挂图的地方：插进 <td> 的占位图渲染层会
        整个丢掉（_emit_table 只取文字），而 html 里已出现 data-file-id 又会让附录把这条
        滤掉——材料在正文和附录**两头消失**，比不插还糟。"""
        out = {"b1": ('<p>报价要求如下。</p>'
                      '<table><tr><td><p>3</p></td><td><p>提供营业执照扫描件</p></td></tr></table>')}
        state = {
            "outline": {"chapters": [_chapter("b1", "报价一览表", [])]},
            "read": {},
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        assert 'data-file-id="f1"' not in result["b1"], "图被插进了表格，渲染时会整个丢掉"

    # 2026-08-13 云上江西实测原文：库无信用中国截图，模型在「六、信用中国截图」下编了
    # 整段描述、甚至替投标人作保证。材料小节测试都用这个真实形状。
    _CREDIT_SECTION = (
        "<h3>六、信用中国截图</h3>"
        "<p>本项提供投标截止时间前从“信用中国”网站（www.creditchina.gov.cn）查询的信用记录截图。截图内容包括：</p>"
        "<ul><li>未被列入“失信被执行人”名单；</li><li>未被列入“经营异常名录”。</li></ul>"
        "<p>经查，我方不存在被暂停或取消投标资格、责令停业、破产等情形。</p>"
        "<p>(附：信用中国查询截图)</p>"
        "<h3>七、单位负责人无关联关系声明</h3>"
        "<p>我方声明：参与本次响应的供应商单位负责人与我方单位负责人不是同一人。</p>")

    def test_missing_material_section_becomes_a_placeholder_line(self):
        """⑫材料小节（信用中国截图）库无货 → 正文换成一行待补充，模型编的描述与
        「经查，我方不存在…」这类替用户作的保证**整节删掉**（2026-08-13 用户口径：
        多余内容，宁可空着待补充）。相邻小节一个字不动。"""
        out = {"b3": self._CREDIT_SECTION}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": []}}
        result = place_certificates(out, state)
        html = result["b3"]
        assert "<h3>六、信用中国截图</h3>" in html, "小节标题必须保留"
        assert "（待补充：信用中国截图）" in html
        assert "我方不存在被暂停" not in html, "替用户作的保证没删干净"
        assert "creditchina" not in html
        assert "单位负责人与我方单位负责人不是同一人" in html, "相邻小节被误伤"

    def test_material_section_with_stock_becomes_image_only(self):
        """⑬库有信用中国截图 → 图就是全部内容：锚点插图保留，模型编的描述性正文照删
        （2026-08-13 用户口径：贴了照片就够了，不需要补充文本内容）。"""
        out = {"b3": self._CREDIT_SECTION}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": [
                     {"title": "信用中国查询截图", "images": [{"fileId": "cx1", "key": "k", "name": "n"}]}]}}
        result = place_certificates(out, state)
        html = result["b3"]
        assert 'data-file-id="cx1"' in html
        assert "见下图" in html
        assert "本项提供投标截止时间前" not in html, "有货时模型编的正文也要删——图就是全部"
        assert "我方不存在被暂停" not in html

    def test_material_section_with_a_real_image_keeps_the_image(self):
        """⑭节里已有 <img>（用户手插过）→ 图保留、不打待补充；相邻小节一个字不动。"""
        out = {"b3": ('<h3>六、信用中国截图</h3><p><img src="data:image/png;base64,x" /></p>'
                      "<h3>七、其他</h3><p>y</p>")}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": []}}
        html = place_certificates(out, state)["b3"]
        assert '<img src="data:image/png;base64,x" />' in html
        assert "待补充" not in html
        assert "<h3>七、其他</h3><p>y</p>" in html

    def test_material_replacement_never_touches_protected_form_chapters(self):
        """⑮表单模板章（raw 保真过闸）受保护：里面的「资格文件清单」是招标原文逐字
        保真的，清掉等于破坏保真——protected 集合由流水线按 templates.raw 传入。"""
        out = {"b6": self._CREDIT_SECTION}
        state = {"outline": {"chapters": [_chapter("b6", "承诺函与声明", [])]},
                 "read": {}, "run_input": {"credentials": []}}
        result = place_certificates(out, state, protected=frozenset({"b6"}))
        assert result["b6"] == out["b6"]

    def test_groupless_material_heading_is_left_alone(self):
        """⑯词表不认识的材料（「某某认证材料复印件」）判不了库存 → 不乱删，维持原状。"""
        out = {"b3": "<h3>三、某某认证材料复印件</h3><p>说明文字。</p>"}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": []}}
        assert place_certificates(out, state)["b3"] == out["b3"]

    def test_replaced_section_suppresses_the_chapter_tail_duplicate(self):
        """⑰小节里已留待补充，条款交集通路不得在章尾再来一条同名待补充。"""
        out = {"b3": self._CREDIT_SECTION}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", ["sec-1-c1"])]},
                 "read": _read_with("提供信用中国截图证明材料", ["sec-1-c1"]),
                 "run_input": {"credentials": []}}
        result = place_certificates(out, state)
        assert result["b3"].count("（待补充：信用中国截图）") == 1

    # ---- 2026-08-13 评审 CONFIRMED 项的钉子测试（夹具照抄评审复现） ----

    def test_h2_after_material_section_bounds_the_cut(self):
        """⑱材料小节后面跟 <h2>（渲染层明确防御过的模型跑偏产物）→ 切割端点停在 h2，
        h2 与其后正文一个字不丢。只认 h3-h6 当边界时这里会整段静默删光（评审复现）。"""
        out = {"b3": ("<h3>六、信用中国截图</h3><p>本项提供信用记录截图说明。</p>"
                      "<h2>第二部分 商务文件</h2><p>重要正文</p>")}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": []}}
        html = place_certificates(out, state)["b3"]
        assert "（待补充：信用中国截图）" in html
        assert "<h2>第二部分 商务文件</h2>" in html and "重要正文" in html, "h2 之后被整段删光"

    def test_nested_table_anchor_is_still_excluded(self):
        """⑲嵌套表格：外层表格后半段的「提供营业执照扫描件」仍在表内，不得当锚——
        插进 <td> 的图渲染层丢弃、附录又按 data-file-id 滤掉，材料两头消失（评审复现）。"""
        out = {"b1": ("<table><tr><td><table><tr><td>内层</td></tr></table></td>"
                      "<td><p>提供营业执照扫描件</p></td></tr></table>")}
        state = {"outline": {"chapters": [_chapter("b1", "报价一览表", [])]},
                 "read": {}, "run_input": {"credentials": [
                     {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]}}
        assert 'data-file-id="f1"' not in place_certificates(out, state)["b1"]

    def test_title_only_entry_without_images_counts_as_missing(self):
        """⑳条目建了、扫描件没传 → 依然算没货：正文清成待补充，而不是「以为有货」把
        模型编的保证原样交付、图又一张都插不出（评审复现：两头都不管）。"""
        out = {"b3": self._CREDIT_SECTION}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": [
                     {"title": "信用中国查询截图", "images": []}]}}
        html = place_certificates(out, state)["b3"]
        assert "（待补充：信用中国截图）" in html
        assert "我方不存在被暂停" not in html

    def test_nested_material_sections_get_one_clean_cut(self):
        """㉑材料小节嵌套（h3 财务报表复印件下挂 h4 资产负债表复印件）→ 只在父级切一刀，
        一行待补充；不得出现无头孤行或被吞掉一半的子标题（评审复现）。"""
        out = {"b3": ("<h3>三、财务报表复印件</h3><p>父级说明。</p>"
                      "<h4>1. 资产负债表复印件</h4><p>子级说明一。</p>"
                      "<h4>2. 利润表复印件</h4><p>子级说明二。</p>"
                      "<h3>四、其他</h3><p>保留内容</p>")}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": []}}
        html = place_certificates(out, state)["b3"]
        assert html.count("（待补充：") == 1, "嵌套材料小节切出了多刀"
        assert "（待补充：财务报表复印件）" in html
        assert "<h3>四、其他</h3>" in html and "保留内容" in html
        assert "子级说明一" not in html, "父级清除范围没盖住子级"

    def test_tail_block_never_says_see_image_for_an_imageless_entry(self):
        """㉒章尾通路同样只认带图条目：无图条目打「见下图」底下却没图=幻影库存（扫同类）。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
                 "read": _read_with("提供营业执照", ["sec-1-c1"]),
                 "run_input": {"credentials": [{"title": "营业执照", "images": []}]}}
        html = place_certificates(out, state)["t1"]
        assert "见下图" not in html
        assert "（待补充：营业执照）" in html

    def test_form_chapter_named_after_the_keyword_gets_no_placeholder(self):
        """㉓「法定代表人授权书」章命中「授权书」词、库无授权书条目 → **不**留
        「（待补充：授权书）」——这一章本身就是授权书，留痕等于说"这一章还没写"，
        审查会照抄出一条高风险（2026-08-13 云上江西实测+审查双双反馈）。
        材料章（「营业执照副本扫描件」非表单章）缺货仍要提醒，不受影响。"""
        out = {"f2": "<h3>法定代表人授权书</h3><p>（供应商全称）法定代表人授权（全权代表姓名）。</p>"}
        state = {"outline": {"chapters": [_chapter("f2", "法定代表人授权书", ["sec-1-c1"])]},
                 "read": _read_with("提供法定代表人授权书", ["sec-1-c1"]),
                 "run_input": {"credentials": []}}
        html = place_certificates(out, state)["f2"]
        assert "（待补充：授权书）" not in html
        # 同章命中的**别组**材料（身份证明）不受抑制——授权书章要附身份证
        state2 = {"outline": {"chapters": [_chapter("f2", "法定代表人授权书", ["sec-1-c1"])]},
                  "read": _read_with("提供法定代表人身份证原件扫描件", ["sec-1-c1"]),
                  "run_input": {"credentials": []}}
        html2 = place_certificates(out, state2)["f2"]
        assert "（待补充：法定代表人身份证明）" in html2

    # ---- 2026-08-13 第二轮评审 CONFIRMED 项（章即文书抑制收窄） ----

    def test_material_chapter_named_after_its_proof_keeps_the_reminder(self):
        """㉔「社保证明」章（构词法命中表单尾字，但它是要**附**的材料不是要写的文书）
        缺货必须照常提醒——抑制打到它头上，编造的正文就无声交付了（评审复现）。"""
        out = {"b8": "<h3>社保证明</h3><p>我方按规定缴纳社会保险。</p>"}
        state = {"outline": {"chapters": [_chapter("b8", "社保证明", ["sec-1-c1"])]},
                 "read": _read_with("提供近三个月社保缴纳证明", ["sec-1-c1"]),
                 "run_input": {"credentials": []}}
        assert "（待补充：社保证明）" in place_certificates(out, state)["b8"]

    def test_manufacturer_authorization_is_not_swallowed_by_the_letter_chapter(self):
        """㉕授权书章里缺**厂家授权**（另一份真实材料，已拆独立组）→ 照常留待补充；
        同组互吞时它会被「章即授权书」一并吞掉（评审复现）。"""
        out = {"f2": "<h3>法定代表人授权书</h3><p>授权正文。</p>"}
        state = {"outline": {"chapters": [_chapter("f2", "法定代表人授权书", ["sec-1-c1"])]},
                 "read": _read_with("提供制造商（厂家授权）原件", ["sec-1-c1"]),
                 "run_input": {"credentials": []}}
        assert "（待补充：厂家授权）" in place_certificates(out, state)["f2"]

    def test_stocked_own_group_scan_still_lands_in_its_chapter(self):
        """㉖库里有签好的授权书扫描件、章内无锚点 → 章尾照常见下图插图；
        抑制只吞「待补充」，不吞有货——签好的授权书正是评委要在这一章看到的（评审复现）。"""
        out = {"f2": "<h3>法定代表人授权书</h3><p>授权正文。</p>"}
        state = {"outline": {"chapters": [_chapter("f2", "法定代表人授权书", ["sec-1-c1"])]},
                 "read": _read_with("提供法定代表人授权书", ["sec-1-c1"]),
                 "run_input": {"credentials": [
                     {"title": "已签署授权委托书", "images": [{"fileId": "s1", "key": "k", "name": "n"}]}]}}
        html = place_certificates(out, state)["f2"]
        assert 'data-file-id="s1"' in html and "见下图" in html

    def test_stocked_material_section_is_image_only_even_without_material_words(self):
        """㉗2026-08-13 用户实测原样：「一、营业执照及主体资格证明文件」（标题不带
        截图/扫描件字样）下执照图已就位，模型又补了整段声明+材料清单表格——
        贴了照片就够了，文本一律删；「见下图」引导行保留。"""
        out = {"b6": ("<h3>一、营业执照及主体资格证明文件</h3>"
                      "<p>我方（供应商名称：（待补充：供应商全称））郑重声明并承诺：具备法定主体资格。</p>"
                      "<table><tr><td>序号</td><td>证明文件名称</td></tr>"
                      "<tr><td>1</td><td>企业法人营业执照（副本）</td></tr></table>"
                      "<p>我方确认：响应文件中所有涉及供应商名称的表述均与营业执照登记名称完全一致。</p>"
                      "<h3>二、其他说明</h3><p>保留内容</p>")}
        state = {"outline": {"chapters": [_chapter("b6", "资格文件", [])]},
                 "read": {}, "run_input": {"credentials": [
                     {"title": "上海安几科技有限公司营业执照",
                      "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]}}
        html = place_certificates(out, state)["b6"]
        assert 'data-file-id="f1"' in html and "见下图" in html
        assert "郑重声明并承诺" not in html, "图下面模型编的声明没删干净"
        assert "证明文件名称" not in html, "模型编的材料清单表格没删"
        assert "完全一致" not in html
        assert "<h3>二、其他说明</h3><p>保留内容</p>" in html, "相邻小节被误伤"

    def test_material_placed_elsewhere_leaves_a_pointer_not_a_placeholder(self):
        """㉘该组材料已在别章就位（全局只放第一处）→ 本节留一行去向说明，
        既不重复插图撑大文件，也不误导成「待补充」。"""
        out = {"b3": "<h3>一、营业执照副本扫描件</h3><p>说明文字。</p>",
               "b7": "<h3>一、营业执照存档件</h3><p>另一处的说明。</p>"}
        state = {"outline": {"chapters": [_chapter("b3", "资格文件", []), _chapter("b7", "附件", [])]},
                 "read": {}, "run_input": {"credentials": [
                     {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]}}
        result = place_certificates(out, state)
        assert 'data-file-id="f1"' in result["b3"]
        assert 'data-file-id="f1"' not in result["b7"]
        assert "已插入本文件前文对应章节" in result["b7"]
        assert "待补充" not in result["b7"]

    def test_word_list_matches_global_constraints_literal(self):
        """词表字面量必须与 web 侧 lib/cert-keywords.ts 逐字同形（双端同表约定的锚点）。
        2026-08-11 扩入财务与资格类材料——康恒那单实测报「近三年经审计的资产负债表未提供」，
        而文件就在资料库「财务材料」分类里，此前词表只覆盖资质类，插不进去。"""
        assert CERT_KEYWORDS == ("营业执照", "资质证书", "授权书", "厂家授权", "法定代表人身份证明",
                                 "检测证书", "许可证",
                                 "审计报告", "资产负债表", "利润表", "财务报表", "纳税证明",
                                 "社保证明", "银行资信证明", "开户许可证", "信用中国截图")

    def test_the_two_sides_may_use_different_wording_for_the_same_material(self):
        """归组的意义所在：招标要求写「法定代表人身份证明」、用户把条目命名成「法人身份证」，
        平表时代这两边对不上、材料躺在库里插不进标书（2026-08-11 用户实测踩到两次）。"""
        out = {"t1": "<h3>资格证明</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格证明文件", ["sec-4-c1"])]},
                 "read": _read_with("提供法定代表人身份证明及授权代表身份证", ["sec-4-c1"]),
                 "run_input": {"credentials": [
                     {"title": "法人身份证", "images": [
                         {"fileId": "f7", "key": "k7", "name": "id.png"}]}]}}
        result = place_certificates(out, state)
        assert "【法定代表人身份证明】见下图：" in result["t1"], "同义写法没匹配上"
        assert 'data-file-id="f7"' in result["t1"]

    def test_a_requirement_worded_loosely_still_finds_its_group(self):
        """招标那侧也常用简写：「提供公司执照复印件」应当归到营业执照组。"""
        out = {"t1": "<h3>资格证明</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格证明文件", ["sec-4-c1"])]},
                 "read": _read_with("提供公司执照复印件并加盖公章", ["sec-4-c1"]),
                 "run_input": {"credentials": [
                     {"title": "营业执照副本", "images": [
                         {"fileId": "f6", "key": "k6", "name": "lic.png"}]}]}}
        result = place_certificates(out, state)
        assert "【营业执照】见下图：" in result["t1"]

    def test_financial_requirement_inserts_the_financial_document(self):
        """招标要求「近三年经审计的资产负债表」→ 资料库里那条（财务分类的条目同样进 credentials）
        被插到定位到的章里。此前这类要求一个词都不命中，材料躺在库里也进不了标书。"""
        out = {"t1": "<h3>资格证明</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格证明文件", ["sec-4-c1"])]},
                 "read": _read_with("近三年经审计的资产负债表、损益表", ["sec-4-c1"]),
                 "run_input": {"credentials": [
                     {"title": "2025年度资产负债表", "images": [
                         {"fileId": "f9", "key": "k9", "name": "bs.png", "ocrText": "资产总计"}]}]}}
        result = place_certificates(out, state)
        assert "【资产负债表】见下图：" in result["t1"]
        assert 'data-file-id="f9"' in result["t1"]

    def test_a_more_specific_keyword_wins_over_the_one_it_contains(self):
        """词表存在包含关系（「开户许可证」⊃「许可证」）：两个都命中就会为同一份材料插两遍图。
        只留更具体的那个。"""
        out = {"t1": "<h3>资格证明</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格证明文件", ["sec-4-c1"])]},
                 "read": _read_with("基本账户开户许可证", ["sec-4-c1"]),
                 "run_input": {"credentials": [
                     {"title": "开户许可证", "images": [
                         {"fileId": "f8", "key": "k8", "name": "acc.png"}]}]}}
        result = place_certificates(out, state)
        assert result["t1"].count("见下图：") == 1, "包含关系的两个词各插了一次"
        assert "【开户许可证】见下图：" in result["t1"]

    def test_pure_function_does_not_mutate_input(self):
        """纯函数：返回新 dict,不改动入参 out（缓存回写路径依赖这一点不被污染）。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        place_certificates(out, state)
        assert out["t1"] == "<h3>正文</h3>", "入参被就地改动了"


# ---- ④ 缓存命中章同样获得插图：post-pass 在缓存读写之外,fresh/cached 章一律现算 ----

class _FakeRedis:
    def __init__(self):
        self.kv: dict = {}

    def get(self, k):
        return self.kv.get(k)

    def set(self, k, v, ex=None):
        self.kv[k] = v

    def xadd(self, key, fields, maxlen=None, approximate=True):
        pass


class _FakeChat:
    def __init__(self):
        self.calls = 0

    async def ainvoke(self, msgs, config=None):
        self.calls += 1
        return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")


def _cert_state() -> dict:
    return {
        "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
        "read": _read_with("提供营业执照", ["sec-1-c1"]),
        "run_input": {"credentials": [
            {"title": "营业执照", "images": [{"fileId": "f1", "key": "lib/f1.png", "name": "n"}]}]},
    }


def _ctx(redis):
    from types import SimpleNamespace
    return SimpleNamespace(thread_id="proj-t", run_id="r1", redis=redis, gateway=object(),
                           recorder=None, user_id=None, agent_type="bidding_agent")


def test_cached_chapter_still_gets_cert_placement_on_second_run(monkeypatch):
    """④两次 run：第一次现写、第二次断点命中（calls==0）——两次 out 都必须带插图,证明
    post-pass 不依赖缓存路径,库存变化能在缓存命中场景下同样立即生效。"""
    from agent.agents.bidding_agent.nodes import content_pipeline as mod
    from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline

    redis = _FakeRedis()
    state = _cert_state()

    chat1 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat1)
    out1 = asyncio.run(run_content_pipeline(_ctx(redis), state))
    assert chat1.calls == 1
    assert "【营业执照】见下图：" in out1["t1"]

    chat2 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat2)
    out2 = asyncio.run(run_content_pipeline(_ctx(redis), state))
    assert chat2.calls == 0, "断点没命中——不是本测试要验证的对象"
    assert "【营业执照】见下图：" in out2["t1"], "缓存命中章没有拿到证照插图"


def test_library_stock_change_is_reflected_without_touching_cache(monkeypatch):
    """库存变化即时生效：第二次 run 前删光资料库证照，chapter 缓存原封不动命中，但插图
    结果必须从"见下图"变成"待补充"——证明 post-pass 产物真的没有写进章节缓存。"""
    from agent.agents.bidding_agent.nodes import content_pipeline as mod
    from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline

    redis = _FakeRedis()
    state = _cert_state()
    chat1 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat1)
    out1 = asyncio.run(run_content_pipeline(_ctx(redis), state))
    assert "【营业执照】见下图：" in out1["t1"]

    depleted = _cert_state()
    depleted["run_input"]["credentials"] = []       # 资料库证照被删光
    chat2 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat2)
    out2 = asyncio.run(run_content_pipeline(_ctx(redis), depleted))
    assert chat2.calls == 0, "简报没变，仍应缓存命中"
    assert "（待补充：营业执照）" in out2["t1"]
    assert "见下图" not in out2["t1"]
