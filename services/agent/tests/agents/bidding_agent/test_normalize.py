"""章节正文与提纲对齐归一化（230 生产实测：正文内嵌生成时的旧章标题/旧层级编号，
用户改提纲/重排编号后导出文档里"又变回第一章"）。样本取自生产库真实形态。"""
from agent.agents.bidding_agent.render.sanitize import chapter_ordinal, normalize_chapter_html


def test_ordinal_parses_common_no_forms():
    assert chapter_ordinal("第一章") == 1
    assert chapter_ordinal("第七章") == 7
    assert chapter_ordinal("第十章") == 10
    assert chapter_ordinal("第十二章") == 12
    assert chapter_ordinal("第二十一章") == 21
    assert chapter_ordinal("第7章") == 7
    assert chapter_ordinal("7") == 7
    assert chapter_ordinal("七、") == 7
    assert chapter_ordinal("附录A") is None
    assert chapter_ordinal("") is None


def test_drop_leading_h1_chapter_heading_and_renumber():
    # 生产形态（b1）：<h1>第一章 标题</h1> + N.M 层级编号；章被连续重排为第七章后，
    # 旧章标题必须剥掉（章标题由提纲统一渲染）、小节编号首段跟随新章号。
    body = ("<h1>第一章 变更申请基本信息</h1><h2>1.1 项目名称与申请单号</h2>"
            "<h3>1.1.1 项目名称</h3><p>正文</p>")
    out = normalize_chapter_html(body, "第七章", "变更申请基本信息")
    assert "<h1>" not in out
    assert "<h2>7.1 项目名称与申请单号</h2>" in out
    assert "<h3>7.1.1 项目名称</h3>" in out
    assert "<p>正文</p>" in out


def test_drop_stale_title_heading_by_structure():
    # 生产形态（76b8e7c4 b2）：用户改了章标题，正文首元素还是旧标题「2 变更实施计划」——
    # 与当前标题不匹配，但裸编号 + 下级标题紧随 = 章级标题，照样剥。
    body = "<h2>2 变更实施计划</h2><h3>2.1 变更目标</h3><p>x</p>"
    out = normalize_chapter_html(body, "第二章", "人员配置与职责声明")
    assert "变更实施计划" not in out
    assert "<h3>2.1 变更目标</h3>" in out  # 章号未变，编号不动


def test_drop_chinese_numbered_duplicate_title():
    # 生产形态（b4）：「四、风险管理与应急预案承诺」含当前章标题 → 剥
    body = "<h1>四、风险管理与应急预案承诺</h1><h2>4.1 概述</h2>"
    out = normalize_chapter_html(body, "第四章", "风险管理与应急预案承诺")
    assert "<h1>" not in out
    assert "<h2>4.1 概述</h2>" in out


def test_first_h3_subheading_kept_and_renumbered():
    # 生产形态（b7）：正文直接以 <h3>7.1 …</h3> 开头——子项标题不是章标题，保留；编号跟随章号
    body = "<h3>7.1 生产组织供应能力分析表</h3><table><tr><td>x</td></tr></table>"
    out = normalize_chapter_html(body, "第九章", "生产组织供应能力分析表")
    assert "<h3>9.1 生产组织供应能力分析表</h3>" in out
    assert "<table>" in out


def test_same_level_section_headings_kept():
    # 「一、概述」后跟同级 h2 → 不是章级容器标题，宁留勿删
    body = "<h2>一、概述</h2><p>a</p><h2>二、实施</h2><p>b</p>"
    out = normalize_chapter_html(body, "第三章", "施工方案")
    assert out == body


def test_unparseable_no_keeps_numbering_but_drops_duplicate():
    # 自定义章号（附录A）解析不出数字 → 编号不动；含当前标题的首标题照样剥
    body = "<h2>第一章 资质文件</h2><h3>1.1 营业执照</h3>"
    out = normalize_chapter_html(body, "附录A", "资质文件")
    assert "第一章 资质文件" not in out
    assert "<h3>1.1 营业执照</h3>" in out


def test_plain_heading_first_element_kept():
    # 无编号、不含章标题的首 h2（如「概述」）是合法小节，保留
    body = "<h2>概述</h2><p>正文</p>"
    assert normalize_chapter_html(body, "第一章", "整体服务方案") == body


def test_idempotent_and_empty():
    body = "<h1>第一章 整体服务方案</h1><h2>1.1 方案</h2><p>x</p>"
    once = normalize_chapter_html(body, "第六章", "整体服务方案")
    assert normalize_chapter_html(once, "第六章", "整体服务方案") == once
    assert normalize_chapter_html("", "第一章", "x") == ""
    assert normalize_chapter_html("<p>只有段落</p>", "第一章", "x") == "<p>只有段落</p>"


def test_inline_tag_wrapped_numbering_renumbered():
    # 编号被行内标签包住（<strong>1.1 …</strong>）也要跟随
    body = "<h3><strong>1.1 服务承诺</strong></h3>"
    out = normalize_chapter_html(body, "第八章", "服务承诺与保障")
    assert "<strong>8.1 服务承诺</strong>" in out


# ---- 审查修正回归（评审 F1/F2/F4：剥除/改编号启发式的误伤模式） ----

def test_multi_section_body_untouched():
    # F1+F4：裸编号多小节体（1 概述 / 2 实施 各带子节）——首节不是章标题不得剥；
    # 层级编号首段不唯一（1.x 与 2.x 混排），统一改章号必重号，整章不动。
    body = ("<h2>1 概述</h2><h3>1.1 背景</h3><p>x</p>"
            "<h2>2 实施</h2><h3>2.1 步骤</h3>")
    assert normalize_chapter_html(body, "第三章", "施工方案") == body


def test_item_heading_containing_title_kept():
    # F2：子项标题含章标题词（售后服务→7.1 售后服务体系）是常态——N.M 开头绝不剥；
    # "包含"判定已改为"去编号前缀后相等"。
    body = "<h2>7.1 售后服务体系</h2><p>x</p>"
    out = normalize_chapter_html(body, "第七章", "售后服务")
    assert "售后服务体系" in out
    body2 = "<h2>售后服务方案</h2><p>x</p>"
    assert normalize_chapter_html(body2, "第七章", "售后服务") == body2


def test_adjacent_item_headings_not_progressively_eaten():
    # F3：相邻子项标题不能一遍吃一个（旧实现两遍把两个 h2 全吃光）
    body = "<h2>7.1 售后服务体系</h2><h2>7.2 售后服务流程</h2><p>x</p>"
    once = normalize_chapter_html(body, "第七章", "售后服务")
    assert once == body
    assert normalize_chapter_html(once, "第七章", "售后服务") == once


def test_mixed_first_segments_not_renumbered():
    # F4：层级编号首段不唯一 → 不改（盲改会造出 7.1/7.1 重号）
    body = "<h2>1.1 a</h2><h2>2.1 b</h2>"
    assert normalize_chapter_html(body, "第七章", "某章") == body


def test_bare_numbered_sibling_blocks_renumber():
    # F4：存在裸编号小节（"2 实施"不会被改写）时子级也不动，避免父子编号打架
    body = "<h3>2.1 步骤</h3><p>x</p><h2>2 实施</h2>"
    assert normalize_chapter_html(body, "第三章", "施工方案") == body
