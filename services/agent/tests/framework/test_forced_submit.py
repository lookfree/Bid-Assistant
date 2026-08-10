import json
import uuid

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from pydantic import BaseModel

from agent.framework.create_agent import run_submit_agent
from agent.runtime.registry import RunContext


class Toy(BaseModel):
    x: int


class ToyS(BaseModel):
    s: str


def _as_chunk(msg: AIMessage) -> AIMessageChunk:
    """把脚本里的 AIMessage 转成等价的流式 chunk（_forced_submit 已改走 astream）：
    合法 tool_calls→args 序列化为 JSON（可解析→tool_calls）；invalid→原样 bad JSON 串（解析失败→invalid_tool_calls）；
    finish_reason 等 response_metadata 原样带上（截断路径靠它判定）。"""
    kw: dict = {"content": msg.content or ""}
    if getattr(msg, "response_metadata", None):
        kw["response_metadata"] = msg.response_metadata
    raw = (msg.additional_kwargs or {}).get("_raw_args")
    if raw is not None:   # args 原文由用例给定（截断形态：原文没写完，见 _truncated_stream_call）
        kw["tool_call_chunks"] = [{"name": msg.additional_kwargs["_raw_tool"], "args": raw,
                                   "id": "ct", "index": 0}]
        return AIMessageChunk(**kw)
    tcc = [{"name": tc["name"], "args": json.dumps(tc["args"]), "id": tc.get("id"), "index": 0}
           for tc in (msg.tool_calls or [])]
    tcc += [{"name": ic.get("name"), "args": ic.get("args"), "id": ic.get("id"), "index": 0}
            for ic in (getattr(msg, "invalid_tool_calls", None) or [])]
    if tcc:
        kw["tool_call_chunks"] = tcc
    return AIMessageChunk(**kw)


class _ScriptedChat:
    """按脚本逐轮返回 AIMessage 的 fake chat：验证 _forced_submit 的重试/放弃路径。
    replies 用尽后重复最后一条（防止实现 bug 导致超轮调用时立刻 IndexError 掩盖真实断言）。"""

    def __init__(self, replies: list[AIMessage]):
        self.replies = replies
        self.n = 0

    def bind_tools(self, tools, **kw):          # 兼容 tool_choice 强制路径
        return self

    async def astream(self, messages, **kw):    # _forced_submit 走流式：每轮吐一个等价 chunk
        i = min(self.n, len(self.replies) - 1)
        self.n += 1
        yield _as_chunk(self.replies[i])


class _ScriptedGateway:
    """每次 get_chat 返回同一个可计数 chat 实例，保证跨轮次的编排/计数不丢失。"""

    def __init__(self, chat):
        self.chat = chat

    def get_chat(self, **kw):
        return self.chat


def _ctx(gateway):
    return RunContext(run_id=str(uuid.uuid4()), agent_type="t", thread_id=str(uuid.uuid4()), gateway=gateway)


def _valid_call(x: int = 1, call_id: str = "c2") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {"x": x}, "id": call_id}])


def _invalid_call(call_id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[],
                      invalid_tool_calls=[{"name": "submit_x", "args": "{bad json",
                                           "error": "Extra data", "id": call_id}])


def _bad_type_call(call_id: str = "c3") -> AIMessage:
    """合法 JSON 但 Pydantic 校验失败（x 须 int，给字符串）→ 触发 submit.ainvoke 抛错的 rejected 路径。"""
    return AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {"x": "abc"}, "id": call_id}])


class _RecSpy:
    """捕获 log_event 调用（无 DB）：验证提交内容(data=纯字符串)/元数据(event_meta)是否落 agent_event_log。"""

    def __init__(self):
        self.events: list[dict] = []

    def log_event(self, run_id, agent_type, event_type, node=None, level="info",
                  data=None, event_meta=None, thread_id=None, role=None):
        self.events.append({"event_type": event_type, "node": node, "level": level, "role": role,
                            "data": data, "event_meta": event_meta or {}})


def _ctx_rec(gateway):
    rec = _RecSpy()
    ctx = RunContext(run_id=str(uuid.uuid4()), agent_type="t", thread_id=str(uuid.uuid4()),
                     gateway=gateway, recorder=rec)
    return ctx, rec


async def test_submit_logs_input_and_output_on_success():
    """成功提交：agent_event_log 记 event_type=submit 两条——role 列=human(data=模型输入串) 与
    role 列=ai(data=提交内容串)；outcome/tool 在 event_meta，内容在 data，供排查直读。"""
    chat = _ScriptedChat([_valid_call(x=7)])
    ctx, rec = _ctx_rec(_ScriptedGateway(chat))
    await run_submit_agent(ctx, "SYS-PROMPT", "USER-MSG", "submit_x", Toy, "读标·基础轮")
    submits = [e for e in rec.events if e["event_type"] == "submit"]
    inp = next(e for e in submits if e["role"] == "human")
    assert inp["node"] == "读标·基础轮" and inp["event_meta"]["outcome"] == "input"
    assert "SYS-PROMPT" in inp["data"] and "USER-MSG" in inp["data"]   # data 即输入纯字符串
    ok = next(e for e in submits if e["role"] == "ai" and e["event_meta"]["outcome"] == "ok")
    assert "7" in ok["data"]                                            # data 即提交内容纯字符串


async def test_submit_logs_rejection_with_reason_and_content():
    """校验失败 3 次：每次记 event_type=submit(role 列=ai, outcome=rejected, data=提交内容串,
    event_meta.reason=校验原因, level=warning)；最终抛未提交。"""
    chat = _ScriptedChat([_bad_type_call(), _bad_type_call(), _bad_type_call()])
    ctx, rec = _ctx_rec(_ScriptedGateway(chat))
    with pytest.raises(RuntimeError):
        await run_submit_agent(ctx, "SYS", "USR", "submit_x", Toy, "读标·基础轮")
    rej = [e for e in rec.events if e["event_type"] == "submit" and e["event_meta"]["outcome"] == "rejected"]
    assert len(rej) == 3
    assert rej[0]["role"] == "ai" and "reason" in rej[0]["event_meta"]
    assert rej[0]["level"] == "warning" and "abc" in rej[0]["data"]


def _unescaped_quote_call(call_id: str = "cq") -> AIMessage:
    """真实读标格式/红线轮失效形态：中文串值内嵌未转义英文双引号 → langchain 落 invalid_tool_calls。"""
    q = chr(34)
    bad = '{"s": "未注明' + q + '开标时间以前不得开封' + q + '后果自负"}'
    return AIMessage(content="", tool_calls=[],
                     invalid_tool_calls=[{"name": "submit_s", "args": bad, "error": None, "id": call_id}])


async def test_invalid_json_unescaped_quotes_repaired_and_accepted():
    """回归（真实读标格式/红线轮实测：模型照抄招标原文短语用英文双引号，未转义→非法 JSON、连挂 3 轮）：
    json_repair 容错修复(重新转义)后校验通过——首轮即成、不进重试、内容不丢，并记 outcome=repaired 供排查。"""
    chat = _ScriptedChat([_unescaped_quote_call()])
    ctx, rec = _ctx_rec(_ScriptedGateway(chat))
    result = await run_submit_agent(ctx, "sys", "user", "submit_s", ToyS, "读标·格式构成轮")
    assert isinstance(result, ToyS) and "开标时间以前不得开封" in result.s   # 内容保留
    assert chat.n == 1                                                    # 首轮修复即过，无重试
    ai_outcomes = [e["event_meta"].get("outcome") for e in rec.events
                   if e["event_type"] == "submit" and e["role"] == "ai"]
    assert ai_outcomes == ["repaired"]


async def test_invalid_tool_call_retries_and_succeeds():
    """第 1 轮 invalid_tool_calls，第 2 轮合法调用 → 应成功，且 ainvoke 被调 2 次（证明重试而非放弃）。"""
    chat = _ScriptedChat([_invalid_call(), _valid_call(x=1)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert isinstance(result, Toy) and result.x == 1
    assert chat.n == 2


async def test_invalid_tool_call_exhausts_retries_and_raises():
    """连续 3 轮都是 invalid_tool_calls → 用尽预算后抛 RuntimeError（未提交结构化结果），ainvoke 被调 3 次。"""
    chat = _ScriptedChat([_invalid_call(), _invalid_call(), _invalid_call()])
    ctx = _ctx(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert chat.n == 3


async def test_pydantic_validation_failure_still_retries():
    """回归：第 1 轮合法 tool_calls 但缺字段过不了 schema，第 2 轮合法通过 → 成功，调 2 次。"""
    bad_args_call = AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {}, "id": "c1"}])
    chat = _ScriptedChat([bad_args_call, _valid_call(x=2)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert isinstance(result, Toy) and result.x == 2
    assert chat.n == 2


async def test_no_tool_call_at_all_gives_up_immediately():
    """回归：模型完全没产出提交调用（纯文本）→ 立即放弃，抛 RuntimeError（未提交结构化结果），只调 1 次。"""
    chat = _ScriptedChat([AIMessage(content="我拒绝回答")])
    ctx = _ctx(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert chat.n == 1


async def test_truncated_output_retries_with_compression_hint():
    """回归（南瑞 4 文件标实测）：输出撞 max_tokens（finish_reason=length）且 tool_calls/
    invalid_tool_calls 双空——此前被当"没提交"一次放弃；应喂回压缩指令重试。"""
    truncated = AIMessage(content="……（被截断的长输出", response_metadata={"finish_reason": "length"})
    chat = _ScriptedChat([truncated, _valid_call(x=7)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert isinstance(result, Toy) and result.x == 7
    assert chat.n == 2


async def test_truncated_output_exhausts_attempts_then_raises():
    """连续截断用尽预算 → 仍抛"未提交"（不无限重试）。"""
    truncated = AIMessage(content="x", response_metadata={"finish_reason": "length"})
    chat = _ScriptedChat([truncated, truncated, truncated])
    ctx = _ctx(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert chat.n == 3


async def test_length_truncation_beats_salvaged_tool_call():
    """流式回归（关键）：截断的 tool-call args 会被 langchain parse_partial_json 补成"看似合法"的
    dict，于是 tool_calls 非空且恰好过 schema。必须凭 finish_reason=length 先走压缩重试，
    绝不能把残缺结果当成功交付（否则大标书读标会静默丢条款）。"""
    salvaged = AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {"x": 1}, "id": "c1"}],
                         response_metadata={"finish_reason": "length"})
    chat = _ScriptedChat([salvaged, _valid_call(x=2)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert result.x == 2      # 来自压缩重试，而非被接受的截断结果（x==1）
    assert chat.n == 2


# 2026-08-11 生产实测（康恒环境审查报告）：一条发现的标题是
# 「类似项目案例合同中的项目名称与投标产品名称不一致（如合同写的是」——句子断在半截、
# 括号没闭合，正是模型要写引号里的项目名时撞上长度上限、被 parse_partial_json 收了尾；
# 截断点之后的发现整批丢失，而用户拿到的是一份看起来正常的报告。
_CUT_TITLE = "类似项目案例合同中的项目名称与投标产品名称不一致（如合同写的是"


def _truncated_stream_call(tool: str = "submit_s") -> AIMessage:
    """输出被长度上限截断、而**服务商没回 finish_reason** 的提交：args 原文没写完。
    流式下 langchain 用 parse_partial_json 把它补成"看似合法"的 dict，于是照样落进 tool_calls。"""
    return AIMessage(content="", tool_calls=[],
                     additional_kwargs={"_raw_tool": tool, "_raw_args": '{"s": "' + _CUT_TITLE})


async def test_truncated_args_without_finish_reason_are_not_delivered():
    """回归（本次生产缺陷）：服务商不回 finish_reason 时，唯一的挡板失效——截断的提交被当成
    正常提交交付，用户拿到半截标题的风险条。判据改成看 args 原文能否 json.loads 之后：
    这一轮必须走压缩重试，绝不把半截结果交出去。

    反向变异：把 _incomplete_args 从判定里拿掉，本用例会拿到 ToyS(s=半截标题) 而不是抛错。"""
    chat = _ScriptedChat([_truncated_stream_call()] * 3)
    ctx, rec = _ctx_rec(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_s", ToyS, "审查")

    assert chat.n == 3        # 三轮都判成截断并重试，而不是首轮就"成功"
    outcomes = [e["event_meta"].get("outcome") for e in rec.events
                if e["event_type"] == "submit" and e["role"] == "ai"]
    assert outcomes == ["truncated"] * 3


async def test_truncated_first_round_then_a_complete_one_is_accepted():
    """压缩重试真能救回来：第二轮写完了就照常交付，内容是完整那一份。"""
    full = _CUT_TITLE + "“XX市智慧园区平台”）"
    chat = _ScriptedChat([_truncated_stream_call(),
                          AIMessage(content="", tool_calls=[{"name": "submit_s",
                                                             "args": {"s": full}, "id": "c2"}])])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_s", ToyS, "审查")

    assert result.s == full and chat.n == 2


async def test_a_complete_submission_is_never_mistaken_for_truncated():
    """误伤检验：写完的提交（args 原文是合法 JSON）首轮即过，不进重试。"""
    chat = _ScriptedChat([_valid_call(x=3)])
    ctx = _ctx(_ScriptedGateway(chat))

    assert (await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")).x == 3
    assert chat.n == 1


@pytest.mark.parametrize("raw,want", [
    ('{"s": "第一行\n第二行"}', "第一行\n第二行"),        # 裸换行：模型写长中文字段的高频形态
    ('{"s": "列一\t列二"}', "列一\t列二"),                # 裸制表符：表格类结论
])
async def test_a_complete_submission_with_bare_control_chars_is_not_truncated(raw, want):
    """回归（复审 C2）：判据必须与**落 tool_calls 的那个解析器**同口径。

    langchain 用 parse_partial_json(..., strict=False)；我们若用 strict=True，串值里的裸换行/
    裸制表符——完全正常的**写完的**输出——会被判成截断，压缩重试三轮后整步失败 + 全额退款，
    用户什么都拿不到。影响面是所有走 _forced_submit 的步（读标每个分段轮、提纲、审查、述标、
    classify、checklist）。
    反向变异：把 json.loads 的 strict=False 去掉，本用例抛 RuntimeError。"""
    chat = _ScriptedChat([AIMessage(content="", tool_calls=[],
                                    additional_kwargs={"_raw_tool": "submit_s", "_raw_args": raw})])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_s", ToyS, "审查")

    assert result.s == want and chat.n == 1      # 首轮即交付，一轮都没白烧


@pytest.mark.parametrize("raw", [
    '{"s": "写到一半',                    # 串未闭合
    '{"items": ["甲", "乙"',              # 数组未闭合
    '{"s": "写完了"',                     # 对象未闭合
])
async def test_all_three_shapes_of_real_truncation_are_still_caught(raw):
    """放宽到 strict=False 之后，真截断的三种形态一条都不能漏。"""
    chat = _ScriptedChat([AIMessage(content="", tool_calls=[],
                                    additional_kwargs={"_raw_tool": "submit_s", "_raw_args": raw})] * 3)
    ctx, rec = _ctx_rec(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_s", ToyS, "审查")

    assert [e["event_meta"].get("outcome") for e in rec.events
            if e["event_type"] == "submit" and e["role"] == "ai"] == ["truncated"] * 3


def test_non_string_args_never_break_the_step():
    """健壮性（复审 m8）：某适配器把 args 放成 dict 时，判据只该"判不了"（回 False），
    绝不能抛 AttributeError / TypeError 打断整步。

    直接问 _incomplete_args：langchain 的 AIMessageChunk 自己就拒收非 str 的 args
    （ToolCallChunk 契约是 str | None），所以这条路今天不可达，构造不出真消息——
    但守卫要在契约被别的适配器打破时兜住，用鸭子类型的假消息锁住它。"""
    from agent.framework.create_agent import _incomplete_args

    class _Msg:
        tool_calls = [{"name": "submit_s", "args": {"s": "已写完"}}]
        tool_call_chunks = [{"name": "submit_s", "args": {"s": "已写完"}, "id": "ct", "index": 0}]

    assert _incomplete_args(_Msg(), "submit_s") is False
