from psycopg_pool import ConnectionPool

SETUP_SQL = """
CREATE SCHEMA IF NOT EXISTS agent;

-- thread_id = 会话键（LangGraph 原生：checkpointer 按它续状态）；同一会话可有多个 run。
CREATE TABLE IF NOT EXISTS agent.agent_request (
  run_id        uuid PRIMARY KEY,                  -- 一次执行（App 生成）
  thread_id     text NOT NULL,                     -- 会话/对话（= LangGraph thread_id）
  agent_type    text NOT NULL,
  status        text NOT NULL DEFAULT 'queued',    -- queued/running/succeeded/failed/interrupted/canceled
  file_refs     jsonb,
  input_summary jsonb,
  node_count    int  NOT NULL DEFAULT 0,
  error         text,
  error_type    text,                              -- 失败归类（model_error/timeout/parse_error/...），便于筛
  -- 用量汇总（完成时由 usage_summary 回填，省去列表页 join token_usage）
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_tokens bigint NOT NULL DEFAULT 0,
  total_tokens  bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   int
);
CREATE INDEX IF NOT EXISTS agent_request_type_idx   ON agent.agent_request (agent_type, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_request_thread_idx ON agent.agent_request (thread_id);

CREATE TABLE IF NOT EXISTS agent.agent_event_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL,
  thread_id   text,                                -- 会话键（= LangGraph thread_id，便于跨 run 看会话时间线）
  agent_type  text NOT NULL,
  seq         int  NOT NULL,                        -- run 内单调递增序号
  ts          timestamptz NOT NULL DEFAULT now(),
  event_type  text NOT NULL,                        -- run.start/node.start/node.end/tool.call/model.call/sse.chunk/interrupt/resume/error/run.end
  node        text,
  level       text NOT NULL DEFAULT 'info',
  data        jsonb,                                -- 事件载荷（脱敏）
  event_meta  jsonb                                 -- 事件元数据（trace/来源/标签等）
);
CREATE INDEX IF NOT EXISTS agent_event_run_idx    ON agent.agent_event_log (run_id, seq);
CREATE INDEX IF NOT EXISTS agent_event_thread_idx ON agent.agent_event_log (thread_id);
CREATE INDEX IF NOT EXISTS agent_event_type_idx   ON agent.agent_event_log (agent_type, ts DESC);

CREATE TABLE IF NOT EXISTS agent.agent_token_usage (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           uuid NOT NULL,
  thread_id        text,                              -- 便于按会话汇总成本（与其它表对齐）
  agent_type       text NOT NULL,
  ts               timestamptz NOT NULL DEFAULT now(),
  provider         text NOT NULL,                     -- deepseek/qwen/glm
  model            text NOT NULL,
  node             text,
  input_tokens     int NOT NULL DEFAULT 0,
  output_tokens    int NOT NULL DEFAULT 0,
  cached_tokens    int NOT NULL DEFAULT 0,            -- input 中命中提示词缓存的部分（input 的子集，计价更低，非额外相加）
  reasoning_tokens int NOT NULL DEFAULT 0,            -- 推理模型(DeepSeek-R1 等)的思考 token，单列
  total_tokens     int NOT NULL DEFAULT 0,            -- 通常 = input + output（厂商回报，便捷列）
  ttft_ms          int,                               -- 首 token 延迟（流式关键指标）
  latency_ms       int,                               -- 整次调用耗时
  finish_reason    text
);
CREATE INDEX IF NOT EXISTS agent_usage_run_idx    ON agent.agent_token_usage (run_id);
CREATE INDEX IF NOT EXISTS agent_usage_thread_idx ON agent.agent_token_usage (thread_id);
CREATE INDEX IF NOT EXISTS agent_usage_type_idx   ON agent.agent_token_usage (agent_type, ts DESC);

-- 工具调用只落本表（结构化，便于"哪个工具最慢/最易失败"）；event_log 不重复写工具明细。
CREATE TABLE IF NOT EXISTS agent.agent_tool_call (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       uuid NOT NULL,
  thread_id    text,
  agent_type   text NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  tool         text NOT NULL,
  node         text,
  ok           boolean NOT NULL DEFAULT true,
  duration_ms  int,
  args_summary jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS agent_tool_run_idx  ON agent.agent_tool_call (run_id);
CREATE INDEX IF NOT EXISTS agent_tool_name_idx ON agent.agent_tool_call (agent_type, tool, ts DESC);
"""


def setup_telemetry(pool: ConnectionPool) -> None:
    """幂等建 agent schema 与四表（spec104 迁移时调用一次）。"""
    with pool.connection() as conn:
        conn.execute(SETUP_SQL)
        conn.commit()


if __name__ == "__main__":
    from agent.db import get_pool

    setup_telemetry(get_pool())
    print("[telemetry] agent schema 四表已就绪")
