# spec103 · 模型网关（Model Gateway） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一接入 DeepSeek / 通义千问(Qwen) / 智谱(GLM) 三家国产大模型（均走 OpenAI 兼容端点），提供可按配置切换、带故障转移的 `ModelGateway`；每次调用自动提取用量（input/output/cached/reasoning token + 延迟）并经 spec102 `Recorder.record_usage` 落库。

**Architecture:** 三家都用 langchain `ChatOpenAI` + 各自 `base_url`，得到统一 ChatModel 接口与统一用量结构。`ModelGateway.invoke()` 按"首选 → 配置的回退链"逐个尝试，异常即降级到下一家；成功后抽取用量埋点。Key 从 env 读，缺失则该家不可用。

**Tech Stack:** langchain-openai、langchain-core、pytest。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 三家 OpenAI 兼容：DeepSeek `api.deepseek.com/v1`、通义 `dashscope.aliyuncs.com/compatible-mode/v1`、智谱 `open.bigmodel.cn/api/paas/v4`。
- 模型 Key 只从 env 读（`.env.bidsaas.local`，凭据就绪时填；当前可能缺失）。
- **不碰钱**：只记 token/延迟，定价/扣费在 App（§3.2）。
- 用量经 `Recorder.record_usage`（spec102）；`cached` 为 input 子集、`reasoning` 单列。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
services/agent/
├── pyproject.toml                       # 改：+ langchain-openai
├── src/agent/
│   ├── config.py                        # 改：+ 三家 Key / 默认 provider·model / 回退链
│   └── models/
│       ├── __init__.py
│       ├── providers.py                 # 新：三家 base_url + 默认模型 + Key 映射
│       ├── usage.py                     # 新：从 AIMessage 抽取 input/output/cached/reasoning
│       └── gateway.py                   # 新：ModelGateway(get_chat / invoke + 故障转移 + 埋点)
└── tests/
    ├── test_model_usage.py              # 新：用量抽取（无网络）
    └── test_model_gateway.py            # 新：get_chat 配置 + 故障转移（fakes，无网络）
```

---

## Interfaces（本 spec 对外产出，供 spec106 依赖）

- Produces：
  - `PROVIDERS: dict[str, {base_url, default_model}]`（deepseek/qwen/glm）。
  - `extract_usage(msg) -> {input, output, cached, reasoning, total, finish_reason}`。
  - `ModelGateway(settings)`：
    - `get_chat(provider=None, model=None, **kw) -> ChatOpenAI`（provider=None 回退 `model_default_provider`）
    - `invoke(messages, provider=None, model=None, *, recorder=None, run_id=None, agent_type=None, node=None, thread_id=None) -> AIMessage`（首选→回退链，自动埋点）

---

## Task 1: 依赖 + 配置 + provider 注册表

**Files:**
- Modify: `services/agent/pyproject.toml`、`src/agent/config.py`
- Create: `src/agent/models/__init__.py`、`models/providers.py`

- [ ] **Step 1: 开分支 + 装依赖**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec103-model-gateway
cd services/agent && uv add langchain-openai langchain-core && mkdir -p src/agent/models
```

- [ ] **Step 2: 在 `src/agent/config.py` 的 `Settings` 追加字段**

```python
    # 模型 Key（OpenAI 兼容）
    deepseek_api_key: str | None = None
    dashscope_api_key: str | None = None     # 通义千问（DashScope）
    zhipu_api_key: str | None = None          # 智谱 GLM
    # 默认与回退
    model_default_provider: str = "deepseek"
    model_default_model: str | None = None    # None 则用 provider 默认模型
    model_fallbacks: str = ""                  # "qwen:qwen-plus,glm:glm-4-flash"
```

- [ ] **Step 3: 写 `src/agent/models/providers.py`**

```python
PROVIDERS: dict[str, dict] = {
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "default_model": "deepseek-chat"},
    "qwen":     {"base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "default_model": "qwen-plus"},
    "glm":      {"base_url": "https://open.bigmodel.cn/api/paas/v4", "default_model": "glm-4-flash"},
}

# provider -> Settings 上的 Key 字段名
KEY_FIELD: dict[str, str] = {
    "deepseek": "deepseek_api_key",
    "qwen": "dashscope_api_key",
    "glm": "zhipu_api_key",
}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `cd services/agent && uv sync && uv run python -c "from agent.models.providers import PROVIDERS; print(list(PROVIDERS))"`
Expected: 打印 `['deepseek', 'qwen', 'glm']`。

```bash
git add services/agent/pyproject.toml services/agent/src/agent/config.py services/agent/src/agent/models
git commit -m "feat(spec103): 模型 provider 注册表 + 配置(三家 Key/默认/回退)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 用量抽取 + 单测（无网络）

**Files:**
- Create: `src/agent/models/usage.py`、`tests/test_model_usage.py`

- [ ] **Step 1: 写失败测试 `tests/test_model_usage.py`**

```python
from types import SimpleNamespace
from agent.models.usage import extract_usage


def test_extract_usage_from_usage_metadata():
    msg = SimpleNamespace(
        usage_metadata={
            "input_tokens": 1200,
            "output_tokens": 300,
            "total_tokens": 1500,
            "input_token_details": {"cache_read": 800},
            "output_token_details": {"reasoning": 150},
        },
        response_metadata={"finish_reason": "stop"},
    )
    u = extract_usage(msg)
    assert u == {"input": 1200, "output": 300, "cached": 800, "reasoning": 150, "total": 1500, "finish_reason": "stop"}


def test_extract_usage_defaults_when_missing():
    msg = SimpleNamespace(usage_metadata=None, response_metadata={})
    u = extract_usage(msg)
    assert u["input"] == 0 and u["output"] == 0 and u["cached"] == 0 and u["reasoning"] == 0 and u["total"] == 0
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/agent && uv run pytest tests/test_model_usage.py -q`
Expected: FAIL（`extract_usage` 不存在）。

- [ ] **Step 3: 写 `src/agent/models/usage.py`**

```python
from typing import Any


def extract_usage(msg: Any) -> dict[str, Any]:
    """从 langchain AIMessage 抽取统一用量。
    usage_metadata: {input_tokens, output_tokens, total_tokens,
                     input_token_details:{cache_read}, output_token_details:{reasoning}}"""
    um = getattr(msg, "usage_metadata", None) or {}
    input_ = int(um.get("input_tokens", 0) or 0)
    output = int(um.get("output_tokens", 0) or 0)
    total = int(um.get("total_tokens", input_ + output) or (input_ + output))
    cached = int((um.get("input_token_details") or {}).get("cache_read", 0) or 0)
    reasoning = int((um.get("output_token_details") or {}).get("reasoning", 0) or 0)
    finish_reason = (getattr(msg, "response_metadata", None) or {}).get("finish_reason")
    return {
        "input": input_, "output": output, "cached": cached,
        "reasoning": reasoning, "total": total, "finish_reason": finish_reason,
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd services/agent && uv run pytest tests/test_model_usage.py -q`
Expected: 2 passed。

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/models/usage.py services/agent/tests/test_model_usage.py
git commit -m "feat(spec103): 用量抽取(input/output/cached/reasoning) + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: ModelGateway（切换 + 故障转移 + 埋点）+ 测试

**Files:**
- Create: `src/agent/models/gateway.py`、`tests/test_model_gateway.py`

- [ ] **Step 1: 写失败测试 `tests/test_model_gateway.py`（用 fakes，无网络）**

```python
from types import SimpleNamespace
import pytest
from agent.config import Settings
from agent.models.gateway import ModelGateway


def _settings(**over):
    base = dict(database_url="postgresql://x:y@h:5432/d", deepseek_api_key="k1", dashscope_api_key="k2",
                model_default_provider="deepseek", model_fallbacks="qwen:qwen-plus")
    base.update(over)
    return Settings(**base)


def _fake_msg(inp, out):
    return SimpleNamespace(
        usage_metadata={"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out},
        response_metadata={"finish_reason": "stop"},
    )


class _Rec:  # 捕获埋点调用（无 DB）
    def __init__(self): self.usages = []; self.events = []
    def record_usage(self, *a, **k): self.usages.append(k or a)
    def log_event(self, *a, **k): self.events.append(k or a)


def test_get_chat_uses_provider_base_url():
    gw = ModelGateway(_settings())
    chat = gw.get_chat("deepseek")
    assert chat.model_name == "deepseek-chat"
    assert "deepseek.com" in str(chat.openai_api_base)


def test_invoke_failover_to_second_provider(monkeypatch):
    gw = ModelGateway(_settings())

    def fake_get_chat(provider, model=None, **kw):
        def invoke(_messages):
            if provider == "deepseek":
                raise RuntimeError("deepseek down")
            return _fake_msg(100, 20)
        return SimpleNamespace(model_name=model or "m", invoke=invoke)

    monkeypatch.setattr(gw, "get_chat", fake_get_chat)
    rec = _Rec()
    resp = gw.invoke([("user", "hi")], recorder=rec, run_id="r1", agent_type="bidding_agent", node="read")
    assert resp.usage_metadata["input_tokens"] == 100   # 来自回退的 qwen
    assert len(rec.usages) == 1                          # 成功那次记了用量
    assert len(rec.events) >= 1                          # deepseek 失败记了 model.error


def test_invoke_all_fail_raises(monkeypatch):
    gw = ModelGateway(_settings())
    monkeypatch.setattr(gw, "get_chat", lambda *a, **k: SimpleNamespace(
        model_name="m", invoke=lambda _m: (_ for _ in ()).throw(RuntimeError("boom"))))
    with pytest.raises(RuntimeError):
        gw.invoke([("user", "x")], recorder=_Rec(), run_id="r2", agent_type="bidding_agent")
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/agent && uv run pytest tests/test_model_gateway.py -q`
Expected: FAIL（`ModelGateway` 不存在）。

- [ ] **Step 3: 写 `src/agent/models/gateway.py`**

```python
from __future__ import annotations

import time
from typing import Any
from langchain_openai import ChatOpenAI
from agent.config import Settings
from agent.models.providers import PROVIDERS, KEY_FIELD
from agent.models.usage import extract_usage


class ModelGateway:
    def __init__(self, settings: Settings) -> None:
        self.s = settings

    def _api_key(self, provider: str) -> str:
        key = getattr(self.s, KEY_FIELD[provider], None)
        if not key:
            raise RuntimeError(f"模型 provider '{provider}' 缺少 API Key（{KEY_FIELD[provider].upper()}）")
        return key

    def get_chat(self, provider: str | None = None, model: str | None = None, **kw: Any) -> ChatOpenAI:
        provider = provider or self.s.model_default_provider   # 容忍 provider=None，回退默认家
        p = PROVIDERS[provider]
        return ChatOpenAI(
            model=model or p["default_model"],
            base_url=p["base_url"],
            api_key=self._api_key(provider),
            **kw,
        )

    def _chain(self, provider: str | None, model: str | None) -> list[tuple[str, str | None]]:
        first = (provider or self.s.model_default_provider, model or self.s.model_default_model)
        fb: list[tuple[str, str | None]] = []
        for item in (self.s.model_fallbacks or "").split(","):
            item = item.strip()
            if ":" in item:
                prov, mdl = item.split(":", 1)
                fb.append((prov.strip(), mdl.strip()))
        return [first, *fb]

    def invoke(
        self, messages: Any, provider: str | None = None, model: str | None = None, *,
        recorder: Any = None, run_id: str | None = None, agent_type: str | None = None,
        node: str | None = None, thread_id: str | None = None,
    ) -> Any:
        last_err: Exception | None = None
        for prov, mdl in self._chain(provider, model):
            try:
                t0 = time.monotonic()
                chat = self.get_chat(prov, mdl)
                resp = chat.invoke(messages)
                latency = int((time.monotonic() - t0) * 1000)
                if recorder is not None and run_id:
                    u = extract_usage(resp)
                    recorder.record_usage(
                        run_id, agent_type, provider=prov, model=getattr(chat, "model_name", mdl) or mdl,
                        input_tokens=u["input"], output_tokens=u["output"], cached_tokens=u["cached"],
                        reasoning_tokens=u["reasoning"], total_tokens=u["total"], node=node,
                        latency_ms=latency, finish_reason=u["finish_reason"], thread_id=thread_id,
                    )
                return resp
            except Exception as e:  # noqa: BLE001 故障转移：记录并降级
                last_err = e
                if recorder is not None and run_id:
                    recorder.log_event(
                        run_id, agent_type, "model.error", node=node, level="warn",
                        data={"provider": prov, "model": mdl, "error": str(e)}, thread_id=thread_id,
                    )
                continue
        assert last_err is not None
        raise last_err
```

- [ ] **Step 4: 运行确认通过**

Run: `cd services/agent && uv run pytest tests/test_model_gateway.py -q`
Expected: 3 passed（配置 + 故障转移 + 全失败抛错）。

- [ ] **Step 5: （可选）真实冒烟：有 DeepSeek Key 时跑一次**

```bash
# 仅当 .env.bidsaas.local 配了 DEEPSEEK_API_KEY 时
cd services/agent && uv run python -c "
from agent.config import settings
from agent.models.gateway import ModelGateway
gw = ModelGateway(settings)
print(gw.invoke([('user','用一句话介绍投标')]).content)
"
```
Expected: 打印模型回答（无 Key 则跳过本步）。

- [ ] **Step 6: 全量测试 + lint + 合并**

Run: `cd services/agent && uv run pytest -q && uv run ruff check src`
Expected: 全 passed，ruff 无错。

```bash
git add services/agent/src/agent/models/gateway.py services/agent/tests/test_model_gateway.py
git commit -m "feat(spec103): ModelGateway 切换 + 故障转移 + 用量埋点 + 测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase1/spec103-model-gateway -m "merge spec103: 模型网关"
git push origin main
```

---

## 验收清单（spec103 完成判据）

- [ ] `PROVIDERS` 含 deepseek/qwen/glm（OpenAI 兼容 base_url + 默认模型）。
- [ ] `get_chat(provider)` 返回指向对应 base_url 的 `ChatOpenAI`；Key 缺失明确报错。
- [ ] `invoke` 按"首选→回退链"故障转移；首家失败降级到下一家，全失败抛最后错误。
- [ ] 成功调用经 `Recorder.record_usage` 落 input/output/cached/reasoning/total + latency；失败记 `model.error` 事件。
- [ ] `extract_usage` 正确解析 langchain 用量（含 cache_read/reasoning）。
- [ ] 单测全无网络（fakes）；真实调用作可选冒烟。
- [ ] `uv run pytest` + `ruff` 全绿。
