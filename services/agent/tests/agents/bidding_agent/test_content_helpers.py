"""正文步的纯辅助函数（引擎无关）：篇幅预算/遥测/提纲展平/心跳文案/落笔纪律。

原 test_content_node.py 里引擎无关的那部分平移至此（#85 删除 deepagent 旧引擎时拆分）；
deepagent 机制类测试（虚拟 FS 收稿/补写轮/派工并发计数）随旧引擎一并删除。
"""
import asyncio

from agent.runtime.registry import RunContext


def test_budget_map_scoring_weighted():
    """spec330 方案3：按招标评分分值加权——高分方案章拿大头，「投标报价」类评分排除（报价章只拿基线），
    无评分章拿基线。评分点经 chapter_id（或 clause_ids 回退）映射到章。"""
    from agent.agents.bidding_agent.nodes.content import _chapter_budget_map
    outline = {"chapters": [
        {"id": "t1", "title": "项目理解", "group": "tech", "items": [{"clause_ids": ["c1"]}]},
        {"id": "t2", "title": "技术方案", "group": "tech", "items": [{"clause_ids": ["c2"]}]},
        {"id": "b1", "title": "投标报价", "group": "business", "items": [{"clause_ids": ["c3"]}]},
    ]}
    scoring = [
        {"id": "s1", "category": "技术方案", "name": "方案", "score": 60, "chapter_id": "t2"},
        {"id": "s2", "category": "技术方案", "name": "理解", "score": 10, "clause_ids": ["c1"]},  # 无 chapter_id → clause 回退到 t1
        {"id": "s3", "category": "投标报价", "name": "报价", "score": 30, "chapter_id": "b1"},   # 报价类排除
    ]
    budgets, work = _chapter_budget_map({"target_chars": 100000}, outline, scoring)
    assert budgets["t2"] > budgets["t1"] > budgets["b1"]        # 分越高字越多
    # 总量≈工作目标 100000（校准 1.0 后工作目标就是用户目标；独立字面量锚定——用实现公式
    # 回算会让系数改错也全绿。1.4 是旧引擎旧提示词的超写校准，2026-08-09 实测超写已不存在，
    # ÷1.4 变成纯打折：用户选 5.1 万字只拿到 48%）
    assert work == 100000
    assert abs(sum(budgets.values()) - 100000) < 100000 * 0.05


def test_budget_map_group_weighted_fallback_no_scoring():
    """无可用评分信号 → 回退组级加权：技术标组 ~80% / 商务标组 ~20%，组内按子项权重分。"""
    from agent.agents.bidding_agent.nodes.content import _chapter_budget_map, _TECH_SHARE
    outline = {"chapters": [
        {"id": "t1", "title": "项目理解", "group": "tech", "items": [{}, {}, {}]},   # tech 权重 4
        {"id": "t2", "title": "实施方案", "group": "tech", "items": [{}] * 7},        # tech 权重 8
        {"id": "b1", "title": "报价说明", "group": "business", "items": []},          # biz 权重 1
        {"id": "b2", "title": "投标函",   "group": "business", "items": [{}]},        # biz 权重 2
    ]}
    budgets, work = _chapter_budget_map({"target_chars": 130000}, outline)
    assert work == 130000  # 校准 1.0：工作目标=用户目标;独立字面量锚定校准方向与幅度
    tech_sum, biz_sum = budgets["t1"] + budgets["t2"], budgets["b1"] + budgets["b2"]
    # 组级：技术标 ~80% / 商务标 ~20%（百字取整有小误差）
    assert abs(tech_sum - work * _TECH_SHARE) < work * 0.03
    assert abs(biz_sum - work * (1 - _TECH_SHARE)) < work * 0.03
    # 商务标整组也拿不到技术标任一大章那么多（防回退到平均摊）
    assert biz_sum < budgets["t2"]
    # 组内仍按子项权重：t2>t1、b2>b1
    assert budgets["t2"] > budgets["t1"] and budgets["b2"] > budgets["b1"]
    assert abs(sum(budgets.values()) - work) < work * 0.05
    # 未配置/坏值 → 空表
    assert _chapter_budget_map({}, outline) == ({}, 0)
    assert _chapter_budget_map({"target_chars": 0}, outline) == ({}, 0)
    assert _chapter_budget_map({"target_chars": "1万"}, outline) == ({}, 0)


def test_budget_map_single_group_gets_full_budget():
    """只有技术标(或只有商务标)时，该组独占全部预算——独立审查等单组场景不被砍到 80%。"""
    from agent.agents.bidding_agent.nodes.content import _chapter_budget_map
    outline = {"chapters": [
        {"id": "t1", "title": "方案", "group": "tech", "items": [{}, {}]},
        {"id": "t2", "title": "实施", "group": "tech", "items": [{}] * 5},
    ]}
    budgets, _ = _chapter_budget_map({"target_chars": 100000}, outline)
    assert abs(sum(budgets.values()) - 100000) < 100000 * 0.05  # 单组独占全部(校准后口径,字面量锚定)


def test_budget_map_calibration_configurable():
    """超写校准系数可经 run_input.overshoot_calibration 运营下发覆盖;非法值回落默认并夹域。"""
    from agent.agents.bidding_agent.nodes.content import _chapter_budget_map
    outline = {"chapters": [{"id": "t1", "title": "方案", "group": "tech", "items": [{}, {}]}]}
    assert _chapter_budget_map({"target_chars": 100000, "overshoot_calibration": 2.0}, outline)[1] == 50000
    assert _chapter_budget_map({"target_chars": 100000, "overshoot_calibration": "坏值"}, outline)[1] == 100000  # 非法 → 默认 1.0
    assert _chapter_budget_map({"target_chars": 100000, "overshoot_calibration": 99}, outline)[1] == 33300      # 越界 → 夹到 3.0


def test_length_telemetry_recorded(caplog):
    """篇幅遥测（评审 F2 兜底）：产出可见字数 vs 工作/用户目标落 observability 事件
    （生产 root logger=WARNING,logger.info 看不见——遥测必须落库;日志仅本地开发兜底）;
    落库经 to_thread 下线程（log_event 同步 PG 写+advisory 锁,直调会卡事件循环——与 executor/export 同款）;
    口径与前端 countChars 一致（去标签/实体/空白）;未配置目标静默;落库失败不阻断。"""
    from agent.agents.bidding_agent.nodes.content import _log_length_telemetry, _visible_len
    assert _visible_len("<h3>1.1 标题</h3><p>正文&nbsp;两段  x</p>") == len("1.1标题正文两段x")
    chapters = {"t1": "<p>" + "字" * 60000 + "</p>", "b1": "<p>" + "字" * 11400 + "</p>"}

    class _Recorder:
        events = []

        def log_event(self, run_id, agent_type, event_type, **kw):
            self.events.append((run_id, event_type, kw.get("data")))

    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="t")
    ctx.recorder = _Recorder()
    asyncio.run(_log_length_telemetry(ctx, {"target_chars": 100000}, chapters))
    assert len(ctx.recorder.events) == 1
    run_id, event_type, data = ctx.recorder.events[0]
    # target=100000 work=100000(校准 1.0) produced=71400 → produced/work=0.714
    assert (run_id, event_type) == ("r1", "length_telemetry")
    assert data == {"target": 100000, "work": 100000, "produced": 71400,
                    "produced_over_work": 0.714, "produced_over_target": 0.714}
    asyncio.run(_log_length_telemetry(ctx, {}, chapters))  # 未配置目标 → 静默
    assert len(ctx.recorder.events) == 1

    class _Boom:
        def log_event(self, *a, **kw):
            raise RuntimeError("db down")

    ctx.recorder = _Boom()
    with caplog.at_level("WARNING", logger="agent.agents.bidding_agent.nodes.content"):
        asyncio.run(_log_length_telemetry(ctx, {"target_chars": 100000}, chapters))  # 落库炸 → 只 warning,不抛
    assert any("length telemetry event write failed" in r.getMessage() for r in caplog.records)


def test_group_weighted_budgets_count_children():
    """三级提纲预算贯通：children（小节）计入章规模权重——小节多的章拿到更多字数预算。"""
    from agent.agents.bidding_agent.nodes.content import _group_weighted_budgets
    chapters = [
        {"id": "t1", "group": "tech", "items": [
            {"id": "a", "children": [{"id": "a1"}, {"id": "a2"}, {"id": "a3"}]},
            {"id": "b", "children": []},
        ]},  # 计数 2+3=5
        {"id": "t2", "group": "tech", "items": [{"id": "c"}, {"id": "d"}]},  # 计数 2
    ]
    budgets = _group_weighted_budgets(chapters, 90000)
    assert budgets["t1"] > budgets["t2"]  # 含小节的章权重更大
    assert abs(budgets["t1"] / budgets["t2"] - 6 / 3) < 0.35  # 权重比 ≈ (5+1)/(2+1)


def test_iter_items_flattens_children_and_clamps_garbage():
    """三级提纲统一展平口径（评审二轮）：RAG query/模板定位/评分回退/预算计数共用 _iter_items;
    脏 children（数字/字符串/混杂,API 对 items 内部零校验）钳制跳过,绝不炸付费步。"""
    from agent.agents.bidding_agent.nodes.content import _iter_items, _item_count, _outline_queries
    items = [
        {"id": "a", "label": "1.1 总体", "children": [{"id": "a1", "label": "1.1.1 架构", "clause_ids": ["sec-2-c1"]}]},
        {"id": "b", "label": "1.2 实施", "children": 5},          # 垃圾:数字
        {"id": "c", "label": "1.3 保障", "children": ["裸字符串", {"id": "c1", "label": "1.3.1 值守"}]},
        "非字典项",                                                  # 垃圾:裸字符串
    ]
    flat = _iter_items(items)
    assert [it["id"] for it in flat] == ["a", "a1", "b", "c", "c1"]
    assert _item_count(items) == 5
    assert _item_count(None) == 0 and _item_count(5) == 0
    # RAG query 含小节 label（最具体的检索词）
    q = _outline_queries({"chapters": [{"title": "技术方案", "items": items}]})
    assert "1.1.1 架构" in q[0] and "1.3.1 值守" in q[0]


def test_iter_items_recurses_to_the_deepest_outline_level():
    """五级提纲：四、五级子项同样带 clause_ids（模板定位/评分回退要用），只展两层等于把它们丢了；
    规模计数也会少算，反而给拆得最细的章最小的字数预算。自引用脏数据不得把递归拖死。"""
    from agent.agents.bidding_agent.nodes.content import _iter_items, _item_count
    items = [{"id": "l2", "label": "一、总体", "children": [
        {"id": "l3", "label": "1. 架构", "children": [
            {"id": "l4", "label": "（1）人员配置", "clause_ids": ["sec-9-c3"], "children": [
                {"id": "l5", "label": "① 值班安排", "clause_ids": ["sec-9-c4"]},
            ]},
        ]},
    ]}]
    flat = _iter_items(items)
    assert [it["id"] for it in flat] == ["l2", "l3", "l4", "l5"]
    assert [c for it in flat for c in it.get("clause_ids", [])] == ["sec-9-c3", "sec-9-c4"]
    assert _item_count(items) == 4

    loop: dict = {"id": "x", "label": "自引用"}
    loop["children"] = [loop]  # 脏数据（API 对 items 内部零校验）：深度封顶兜住，不递归到栈溢出
    assert len(_iter_items([loop])) <= 10


def test_heartbeat_label_does_not_pretend_writing_is_sequential():
    """心跳文案：横幅每 5s 动一次——章生成是长调用，定格会被读成"卡住"（实测反馈）。

    但**不能假装是一章接一章写的**：正文多路并行。旧文案"第 9/20 章成稿中（本章已 15 分）"
    两个数都是错的——序号其实是"已完成+1"，计时其实是"距上一章写完多久"。
    """
    from agent.agents.bidding_agent.nodes.content import _heartbeat_label

    label = _heartbeat_label(8, 20, 905, in_flight=6)
    assert "6 章同时撰写中" in label and "15 分 05 秒" in label
    assert "第 9/20 章" not in label, "又把并行写成了串行的章序"
    assert "本章已" not in label, "那个计时不是本章耗时，是距上一章完成的时长"
    # 计时口径必须自我说明：满载时它是"距上一章收稿"——不注明会被读成"这批卡了 37 分"
    # （评审 2026-08-08,当晚用户问的正是这个）
    assert "距上一章收稿" in label
    # 计数交给前端拼：心跳再带一遍会显示成"已完成 3/20 章，正文·已完成 3/20 章"（用户截图）
    assert "已完成" not in label

    # in_flight 归零 ≠ 没在干活——间隙要说清，不然会被读成"没在并行"（用户看着横幅问了两回）。
    # 但**不得再叙述已删除的规划者**（"规划章节与分派写手"已失实,评审 2026-08-08）
    gap = _heartbeat_label(8, 20, 65)
    assert "1 分 05 秒" in gap and "第 9" not in gap and "已收稿 8 章" in gap
    planning = _heartbeat_label(0, 20, 30)
    assert "简报" in planning and "分派写手" not in planning


def test_draft_prompt_carries_length_discipline():
    """字数纪律必须写进落笔层提示词（实测：一章写爆 32768 上限被截断，返工后只剩几百字残稿）。
    流水线引擎的落笔提示词就是 CHAPTER_DRAFT_PROMPT——它丢了「宁短勿爆」，写爆就会复发。

    但纪律是**双边**的（2026-08-09 实测）：这份 system 提示词原来写着「宁可略欠」，
    与简报里的下限自相矛盾，写手照它减产（produced/work=0.675，用户选 5.1 万字只拿到 48%）。
    上限（宁短勿爆，防截断）与下限（不得低于 90%）必须同时在场。"""
    from agent.agents.bidding_agent.prompts.content import CHAPTER_DRAFT_PROMPT

    assert "宁短勿爆" in CHAPTER_DRAFT_PROMPT
    assert "不得低于目标的 90%" in CHAPTER_DRAFT_PROMPT, "只有上限没有下限——写手照旧欠三成"
    assert "宁可略欠" not in CHAPTER_DRAFT_PROMPT, "减产许可还在 system 里，简报的下限被它顶掉"


def test_deviation_block_caps_size_but_never_drops_stars():
    """偏离表条目段有字符预算（大标书几百条会把偏离章那次调用顶穿上下文）——
    预算不够时砍普通条目并如实注明,★/▲ 绝不砍（评审 2026-08-08）。"""
    from agent.agents.bidding_agent.nodes.content import _DEVIATION_BLOCK_CHARS, _deviation_items_block

    read = {"categories": [{"key": "technical", "title": "技术", "items":
                            [{"title": f"★关键要求{i}", "value": "必须满足" * 10, "star": True} for i in range(40)] +
                            [{"title": f"普通要求{i}", "value": "满足即可" * 10, "star": False} for i in range(800)]}]}
    block = _deviation_items_block(read)
    assert len(block) < _DEVIATION_BLOCK_CHARS * 1.2, "条目段没有预算,超大标书必顶穿上下文"
    assert all(f"★关键要求{i}" in block for i in range(40)), "★ 条目被预算截掉了"
    assert "已省略" in block, "截断必须如实注明,不能静默"
