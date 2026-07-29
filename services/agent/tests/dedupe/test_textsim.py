"""spec315b 文本维纯函数：shingle/Jaccard/句对匹配/基线扣除（hermetic，无 IO）。"""
from agent.dedupe.textsim import (jaccard, longest_common_fragment, match_sentences,
                                  shingles, split_sentences, strip_baseline)

# 两段「大部分相同」的中文文本（B 对 A 前两句只改个别字，第三句各不相同）
_A = ["本项目采用微服务架构设计，保障系统高可用与弹性扩展能力",
      "我方承诺在合同签订后三十个日历天内完成全部系统部署与上线工作",
      "项目经理具备十年以上同类系统集成项目管理经验"]
_B = ["本项目采用微服务架构设计，确保系统高可用与弹性扩展能力",
      "我方承诺在合同签订后三十个日历天内完成全部系统部署与上线任务",
      "售后服务团队提供七乘二十四小时热线响应服务"]
_C = ["食堂每日供应三餐并保证食材新鲜卫生",
      "运动会将于下周五在市体育中心如期举行",
      "图书馆开放时间调整为早八点至晚十点"]


def test_shingles_basic():
    assert shingles("abcde", 3) == {"abc", "bcd", "cde"}
    assert shingles("ab", 3) == {"ab"}          # 短于 k 整句作一个 shingle
    assert shingles("", 3) == set()


def test_jaccard_bounds():
    a, b = shingles("投标文件编制说明", 3), shingles("投标文件编制说明", 3)
    assert jaccard(a, b) == 1.0
    assert jaccard(a, shingles("完全无关的另一句话", 3)) == 0.0
    assert jaccard(set(), a) == 0.0


def test_split_sentences_filters_noise():
    clauses = [{"id": "sec-1-c1", "text": "第一句完整的陈述内容。1.2\n第二句同样完整的内容！"}]
    sents = split_sentences(clauses, min_len=6)
    assert sents == ["第一句完整的陈述内容", "第二句同样完整的内容"]   # 短编号 1.2 被滤掉


def test_match_sentences_high_for_mostly_same():
    """大部分相同的两段 → 高分且有命中句对；无关两段 → 低分无命中。"""
    score, pairs = match_sentences(_A, _B, k=5, threshold=0.5)
    assert score >= 50
    assert len(pairs) == 2                       # 前两句命中，第三句各自无关
    assert pairs[0][2] >= pairs[1][2]            # 按相似度降序
    low, none_pairs = match_sentences(_A, _C, k=5, threshold=0.5)
    assert low < 10 and none_pairs == []


def test_match_sentences_identical_scores_100():
    score, _ = match_sentences(_A, list(_A), k=5, threshold=0.5)
    assert round(score) == 100


def test_longest_common_fragment():
    frag = longest_common_fragment(_A[0], _B[0])
    assert "本项目采用微服务架构设计" in frag


def test_strip_baseline_removes_tender_alike():
    """与招标文件高度相似的句被剔除（法定引用不算抄），其余保留。"""
    tender = ["本项目采用微服务架构设计，保障系统高可用与弹性扩展能力概述"]
    kept, removed = strip_baseline(list(_A), tender, k=5, threshold=0.6)
    assert removed == 1
    assert _A[0] not in kept and _A[1] in kept and _A[2] in kept


def test_same_content_across_docx_and_pdf_scores_high():
    """生产实测（用户反馈「两份实际是同一份文件内容，查重显示 0」）：同一份内容一份 docx 一份 PDF，
    pypdf 提取时每个视觉行都成一条 clause，旧实现把换行当句号切 → docx 的整句去对 PDF 的碎片，
    Jaccard 恒低于阈值，得分 12%（真实 PDF 行更长时直接 0）。粘回硬换行后应判为高度相同。"""
    from agent.dedupe.textsim import match_sentences, split_sentences

    para = ("我方承诺严格按照招标文件要求提供全部服务并保证质量满足国家标准。"
            "项目实施期间我方将安排专职项目经理驻场负责日常协调与进度管理。"
            "售后服务响应时间不超过两小时并提供七乘二十四小时值班电话。")
    docx = split_sentences([{"text": para}], 6)                                    # docx：整段一条
    pdf = split_sentences([{"text": para[i:i + 16]} for i in range(0, len(para), 16)], 6, merge_wraps=True)  # PDF：逐视觉行
    assert docx == pdf                                                             # 归一化后两侧句子一致
    score, pairs = match_sentences(docx, pdf, 5, 0.50)
    assert score > 95 and len(pairs) == 3


def test_merge_hard_wraps_keeps_table_rows_and_finished_lines_apart():
    """只粘「被换行截断」的行。已断句的行、表格行各自独立——pypdf 输出**没有制表符**，
    表格靠多个空格对齐，按 \\t 判表格等于没判：评审实测同一张报价表的相似度从 1.00 掉到 0.06。"""
    from agent.dedupe.textsim import _merge_hard_wraps

    assert _merge_hard_wraps([{"text": "我方承诺按期交付。"}, {"text": "项目经理驻场。"}]) == [
        "我方承诺按期交付。", "项目经理驻场。",
    ]
    # pypdf 形态的表格行（空格对齐）
    assert _merge_hard_wraps([{"text": "1  服务器  10台  国产"}, {"text": "2  交换机  4台  国产"}]) == [
        "1  服务器  10台  国产", "2  交换机  4台  国产",
    ]
    assert _merge_hard_wraps([{"text": "本项目服务期为"}, {"text": "三年整。"}]) == ["本项目服务期为三年整。"]
    # 逗号不是行尾终止符（_SENT_SPLIT 不在此断句）：中文避头尾最爱把「，」推到行尾，
    # 把它当行尾这个修复在最常见的形态下就完全失效
    assert _merge_hard_wraps([{"text": "我方承诺按期交付，"}, {"text": "并保证质量。"}]) == ["我方承诺按期交付，并保证质量。"]
    # 页码/页眉噪声先丢再粘，否则被焊进正文句首
    assert _merge_hard_wraps([{"text": "1"}, {"text": "我方承诺按期交付。"}]) == ["我方承诺按期交付。"]
