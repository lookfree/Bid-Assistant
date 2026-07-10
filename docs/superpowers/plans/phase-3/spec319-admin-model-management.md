# spec319 · 运营后台「模型管理」重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把运营后台的模型配置从「/plans 页底部一张 3 字段卡」升级为**独立菜单「模型管理」**,支持:模型库(配服务商+模型名+参数,就地测试连通、就地调参)、运行编排(主模型 + 有序降级链),且**启用/入链前必须测试连通通过**。原型已确认:见 scratchpad model-admin-mockup(布局+配色对齐后台政务红 token+参数悬停说明)。

**Architecture:** 三层改动。① **agent**:`get_chat` 透传 `temperature/max_tokens/top_p`(当前完全没传——也是述标 max_tokens 走默认值的原因)——参数存进 `Settings`(`model_temperature/max_tokens/top_p`),`get_chat` 读设置并入 `ChatOpenAI`,这样生成节点的 `get_chat(provider=None)` 天然用上**主模型**参数,无需改各节点调用点;新增 `POST /models/test` 连通性探针端点(用该 provider 的 env key 建临时 ChatOpenAI,发固定短 prompt,回 `{ok, latency_ms, tokens, error}`);run 契约的 model override 在现有 `{provider, model, fallbacks}` 上**追加 `params`**(主模型参数),`fallbacks` 仍是 `"prov:model,..."` 字符串喂现有 `_chain`(compressor failover 保持不变)。② **App API**:配置数据结构从单条 `agent_model={provider,model,fallbacks}` 升级为 `{models:[...], chain:[id...]}`(读时向后兼容旧结构);新增 `/admin-api/models` 路由组(读/写整份配置 + 测试中转到 agent);`getAgentModel()` 从新结构派生 run override(主=`chain[0]` 的 provider/model/params,fallbacks=`chain[1:]` 拼 `prov:model` 串);createRun/rewriteChapter 带上。③ **admin 前端**:新 `/models` 菜单页(运行编排 + 模型库两段),测试/调参/启用交互,移除 /plans 底部的 AgentModelCard。

> **架构事实(决定上面的收敛)**:生成节点(read/outline/content/review/present、`_forced_submit`)走 `ctx.gateway.get_chat(provider=None)` 单模型、**无 failover**;真正的多模型 failover 只在 compressor 的 `ModelGateway.invoke()`（用 `_chain` 读 `model_fallbacks` 串）。故本轮参数作用于**主模型**(节点实际用的那个),降级链沿用现有字符串 failover 机制不改。给"整条链每模型独立参数 + 节点级 failover"是更大的改造，本轮不做(见决策记录 §1)。

**Tech Stack:** admin(Next.js + shadcn,配色用 `apps/admin/app/globals.css` 既有 oklch token);App API(Hono + Bun + Drizzle,`billing_configs` 复用,Zod,bun:test);agent(FastAPI + langchain_openai,uv/pytest)。

## Global Constraints

- **money-blind 不变**:模型配置不涉及计费;连通性测试是平台内部成本(固定短探针),不新增 hold/settle、不计用户积分。agent 仍只上报用量。
- **启用门槛(产品铁律)**:一个模型进入 `chain`(主模型或降级)前,其 `test.status` 必须为 `passed`。**服务端强制**:`PUT /admin-api/models` 校验 `chain` 里每个 id 对应的 model 都 `enabled && test.status==="passed"`,否则 400 `chain_requires_tested_models`——不能只靠前端禁用开关,防绕过 API 把配错/缺 key 的模型推上生产影响用户生成。
- **向后兼容**:配置读取遇到旧结构 `{provider, model, fallbacks}` 要平滑迁移成新结构(见契约「迁移读」),不能因老数据崩;`getAgentModel()` 对空/缺失配置回退到 agent 默认(deepseek),与今天一致。
- **降级铁律**:`chain` 为空 / 配置损坏 / model override 组装失败 → run 照常用 agent 侧默认模型跑(不因配置问题阻断生成)。
- **参数校验**:`temperature` 0–2、`top_p` 0–1、`max_tokens` 正整数且 ≤ 一个合理上限(如 32768);越界 400。缺省:temperature 0.7、max_tokens 8192、top_p 1.0(agent 也要有同款兜底,配置没给时用默认)。
- **权限**:读模型配置 `config.read`(或沿用现有 configs 读权限);写配置与触发测试 `config.write`(与现有 `PUT /admin-api/plans/configs/:key` 一致),带审计。
- **providers 白名单**:仅 `deepseek/qwen/glm`(agent `providers.py` 三家);model 名自由文本(允许 deepseek-reasoner/qwen-max 等);provider 非白名单 400。
- **配色/一致性**:admin 新页用 globals.css 既有 token(政务红 `--primary`、`--sidebar-*`、图表暖色带),不引入系统外色相;复用现有 shadcn 组件(Card/Button/Input/Switch/Select 等)与 app-sidebar 模式。
- 提交英文 Conventional Commits、lookfree、无 Co-Authored-By;函数 ≤80 行、文件 ≤800 行;关键方法注释解释「为什么」。
- 验证:App API `./test-on-mbp.sh`;agent `uv run pytest`(LLM/HTTP 全 mock);admin `bun test`(逻辑)+ 部署后手测。

## 契约

### 数据结构(billing_configs key `agent_model`,新 value 形状)
```jsonc
{
  "models": [
    {
      "id": "m_xxx",                 // 稳定 id(client 生成 uuid;链按 id 引用)
      "provider": "deepseek",        // deepseek | qwen | glm
      "model": "deepseek-chat",      // 自由文本模型名
      "params": { "temperature": 0.7, "max_tokens": 8192, "top_p": 1.0 },
      "enabled": true,
      "test": { "status": "passed", "at": "2026-07-10T06:00:00Z", "latencyMs": 128, "error": null }
      //         passed | failed | untested
    }
  ],
  "chain": ["m_xxx", "m_yyy"]        // chain[0]=主模型,其余=降级顺序;每个 id 必须 enabled+passed
}
```
- **迁移读**:`getModelConfig()` 读到旧结构(有 `provider`/`fallbacks` 键、无 `models`)→ 就地转成新结构:主 model 由 `{provider, model:model??默认, params:默认}` 生成 id 入 `models`;`fallbacks`(`"glm:glm-4-flash,..."`)每段拆成 model 入 `models`;`chain`=[主, ...fallbacks];test 全 `untested`、enabled 全 true(老数据视作已在用,避免迁移后主模型被门槛挡掉——迁移是一次性兼容,不倒查测试)。迁移结果**不立即回写**(读时转换,写时才落新结构),避免读操作产生写副作用。

### Agent 侧
1. **`config.py` Settings**:加 `model_temperature: float | None = None`、`model_max_tokens: int | None = None`、`model_top_p: float | None = None`(None = 不传,用 provider 默认)。
2. **`models/gateway.py` `get_chat`**:从 `self.s` 读上面三个参数,非 None 才并入 `ChatOpenAI(temperature=..., max_tokens=..., top_p=...)`;显式 `**kw` 仍可覆盖(优先级 kw > settings)。抽一个 `_params_kwargs()` 小方法组装,函数 ≤80 行。`providers.py` 无关。这样节点的 `get_chat(provider=None)` 与 compressor 的 `invoke`→`get_chat` 都自动带上参数,**无需改各节点调用点**。
3. **run override 追加 params**(`gateway.py` `model_override_to_settings`):`_OVERRIDE_MAP` 之外,识别 `sel["params"]`(dict),把 `temperature/max_tokens/top_p` 映射为 `model_temperature/max_tokens/top_p`(校验类型,越界/非数丢弃不抛)。现有 `{provider,model,fallbacks}` 映射不变;`executor.py` 的 `model_copy(update=override)` 路径不改。**降级铁律保留**:meta.model 缺失 → 用模块级默认 gateway(不改)。
4. **新增 `POST /models/test`**(agent 新路由 `routes/models.py`):body `{provider, model, params?}` → 校验 provider 在 `PROVIDERS` → 临时 `ModelGateway(settings.model_copy(update=params 映射)).get_chat(provider, model)` → `await chat.ainvoke([HumanMessage("请回复:OK")])`(固定探针)→ 计时 → 回 `{ok:true, latency_ms, tokens}`(tokens 取 usage_metadata 总数,取不到给 0)或 `{ok:false, error:"<可读原因>"}`。**不落库、不计费**、超时 15s(`asyncio.wait_for`)。provider 无 key(get_chat 抛 RuntimeError)→ `{ok:false, error:"<PROVIDER>_API_KEY 未配置"}`;其它异常 → `{ok:false, error:str(e) 截断}`。provider 非白名单 → 400。
5. `app.py` 挂载新路由。

### App API 侧
1. **`services/config.ts` 或新 `services/model-config.ts`**:`getModelConfig()`(读+迁移)、`saveModelConfig(cfg)`(校验后写 key `agent_model`)。校验:providers 白名单、params 范围、`chain` 每 id 存在且对应 model `enabled && test.status==="passed"`(违反 → 抛 `ChainRequiresTestedError`)。
2. **`routes/admin/models.ts`**(新,挂 `/admin-api/models`):
   - `GET /` → `getModelConfig()`(`config.read`)。
   - `PUT /` body=整份 `{models, chain}` → Zod 校验 + `saveModelConfig` + 审计(`config.write`);校验失败 400(`invalid_params`/`chain_requires_tested_models`/`unknown_provider`)。
   - `POST /test` body `{provider, model, params?}` → `config.write` → 中转 `agentClient.testModel(...)`(新方法,超时 20s)→ 回 agent 的 `{ok, latencyMs, tokens}`/`{ok, error}`。**不改配置**(测试无状态,client 把结果并进 model.test 后随 PUT 落库)。
3. **`services/agent-client.ts`**:`getAgentModel()` 改为读 `getModelConfig()` → 组装 run override `{provider, model, params, fallbacks}`——主= `chain[0]` 的 model 的 `{provider, model, params}`,`fallbacks`= `chain[1:]` 对应 model 拼 `"prov:model,..."` 串(与现有 agent `_chain` 解析一致);`chain` 空 → 返回 `undefined`(agent 用默认)。**沿用现有 override 形状 + 追加 `params`**,createRun/rewriteChapter 调用点不用改结构(已透传 `model`)。加 `testModel({provider,model,params})` 打 agent `/models/test`。
4. **移除**旧 `agent_model` 的 `{provider,model,fallbacks}` 写路径依赖(`/admin-api/plans/configs` 仍可写其它 config key,但 agent_model 改由 `/admin-api/models` 管;plans 页不再写它)。

### admin 前端侧
1. **`app-sidebar.tsx`**:新增菜单项「模型管理」`/models`(放「套餐与积分口径」与「系统与权限」之间),图标用齿轮/芯片类。
2. **`app/(admin)/models/page.tsx` + 组件**:两段——
   - **运行编排**:读 config.chain → 主模型槽(高亮)+ 降级有序列表(上下调序/移除),顶部活状态行,「保存运行配置」显式 PUT。只有 model 库里 enabled 的能加入。
   - **模型库**:model 卡列表,每卡:provider(select 三家)+ model 名(input)+ 三参数(input,带悬停说明文案见原型)+ 测试连通按钮(调 `/admin-api/models/test`,转圈→回显 `✓ 128ms·42 tokens` 或 `✗ 错误`)+ 启用开关(未测通禁用)+ 编辑/删除。「+ 添加模型」。
   - 状态机:改 provider/model/params → test 置 `untested`、若在 chain 中给「参数已改建议重测」提示;测试成功 → test.status=passed 可启用;保存(PUT)整份配置。
3. **`lib/admin-api.ts`**:加 `models.get()/save(cfg)/test({provider,model,params})`。
4. **`plans/plans-client.tsx`**:移除 `AgentModelCard`/`AgentModelFields`/相关 mapping(挪到 /models)。
5. 配色/组件复用现有 shadcn + globals.css token(勿新引色)。

### 验证口径
- **agent pytest**:settings 带参数时 `get_chat` → ChatOpenAI 收到 temperature/max_tokens/top_p(mock ChatOpenAI 断言 kwargs),settings 参数为 None 时不传该 kwarg;`model_override_to_settings` 把 `params` 映射为 model_* 字段、越界/非数丢弃;`/models/test` 成功(mock ainvoke 返回带 usage)→ `{ok,latency_ms,tokens}`;provider 无 key → `{ok:false,error}`;ainvoke 抛错 → `{ok:false,error}` 不 500;provider 非白名单 → 400。
- **App API bun test(mbp)**:`getModelConfig` 迁移旧结构正确;`saveModelConfig`/`PUT` 校验——chain 含未测通 model → 400 `chain_requires_tested_models`;params 越界 → 400;unknown provider → 400;`getAgentModel` 从新结构派生 `{provider,model,params,fallbacks}`(主=chain[0],fallbacks=chain[1:] 拼串)、空配置 → undefined;`POST /test` 中转(mock agentClient)。
- **admin bun test**:config↔表单 mapping、chain 调序/校验逻辑、test 结果并入 model 逻辑(SDK mock)。
- **端到端(部署后手测)**:新菜单页可配 deepseek + 测试通过 + 启用 + 设为主模型 + 保存 → 跑一次真实生成用上该配置(查 agent_token_usage 的 model 列)。

## Tasks

- [ ] **Task A(agent)**:Settings 加参数字段 + `get_chat` 从 settings 透传参数 + `model_override_to_settings` 追加 params 映射 + `/models/test` 探针端点(挂 app.py)+ pytest(全 mock)。
- [ ] **Task B(App API)**:模型配置新结构(读迁移/写校验)+ `/admin-api/models` 路由(GET/PUT/POST test)+ `getAgentModel` 派生链 + agent-client testModel + mbp 测试。
- [ ] **Task C(admin 前端)**:`/models` 菜单页(运行编排 + 模型库,测试/调参/启用/编排交互,配色对齐)+ admin-api 方法 + 从 /plans 移除旧卡 + 逻辑单测。
- [ ] **Task D(验证/部署)**:三侧全绿 → `/code-review` 全修 → 合并 main → 部署 mbp → 端到端手测。

## 决策记录

1. **参数作用于主模型,降级链沿用现有字符串 failover(不做节点级逐项参数)**:读代码发现生成节点走 `get_chat(provider=None)` 单模型、**无 failover**,failover 只在 compressor。故"整条链每模型独立参数"对生成节点是过度设计——最高价值是让**主模型**参数真正作用到生成(修 `get_chat` 完全不传参、DeepSeek 走默认 max_tokens 的老问题,呼应 spec205.1 述标)。本轮:override 在现有 `{provider,model,fallbacks}` 上追加 `params`(主模型的),参数存 Settings 由 `get_chat` 读取,自动覆盖节点与 compressor 两条路径;降级链继续用 `fallbacks` 字符串喂 `_chain`(现状不改)。**已知取舍**:模型库里非主模型的 model 也能配参数,但运行时只有主模型(`chain[0]`)的参数生效,降级位模型的参数在它被设为主模型时才生效——UI 上不误导(参数是"该模型被用作主模型时的参数");给"节点级 failover + 逐项参数"是更大改造,留候选。
2. **测试无状态、启用门槛服务端强制**:`/test` 只回结果不改配置(测试可发生在首次保存前);测试结果由 client 并入 model.test 随 PUT 落库;`PUT` 服务端校验 chain 全测通——这样"启用前必须测通"既有前端引导(开关禁用)又有服务端兜底(防绕过 API),符合"不破坏用户生成"的产品铁律。
3. **复用 `billing_configs` 单 key `agent_model`,不建新表**:配置体量小(几条 model),单 JSON 够用;迁移读兼容旧结构,写才落新结构,读无副作用。避免迁移+新表的成本,与现有 config 存储一致。
4. **连通性探针=固定短 prompt,平台承担成本**:按你的决策,只验 key/网络/延迟,不让运营自定义 prompt(更省成本更简单);探针在 agent 侧执行(key 在那)。回显延迟/token/错误。
5. **参数默认与兜底双写**:App 校验时补默认,agent `get_chat` 也对缺失参数用默认——任一侧配置缺参都不崩,且行为一致(修了当前"完全不传 max_tokens"导致 DeepSeek 走 4096/8192 默认的隐患,现在主模型可显式设 8192,呼应 spec205.1 述标)。

## 本轮不做(候选池)
- 按节点(读标/提纲/正文/审查/述标)分别配参数(矩阵式);本轮每模型一套全局参数。
- 自定义测试 prompt / 测试真实投标样例;本轮仅固定连通探针。
- 降级链拖拽排序(本轮用上下箭头调序);拖拽留后续体验优化。
- presence_penalty/frequency_penalty 等更多参数;本轮三个主参数。
- 新增 provider(仅 deepseek/qwen/glm);加 provider 是 providers.py + env key 的独立小改。
