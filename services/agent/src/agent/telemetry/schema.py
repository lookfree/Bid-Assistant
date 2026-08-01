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
  duration_s    numeric(12,3)                     -- 整个 run 耗时（秒，三位小数保住毫秒精度）
);
CREATE INDEX IF NOT EXISTS agent_request_type_idx   ON agent.agent_request (agent_type, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_request_thread_idx ON agent.agent_request (thread_id);
-- run 结果持久副本（对账恢复用）：Redis result 键只留 24h，App 收尾被打断后超窗即无从恢复；
-- PG 副本让成功 run 的结果永远可取（幂等迁移，存量库就地加列）。
ALTER TABLE agent.agent_request ADD COLUMN IF NOT EXISTS result jsonb;

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
-- 事件角色（submit 事件用）：human=模型输入 / ai=模型提交输出（幂等迁移，存量库就地加列）。
ALTER TABLE agent.agent_event_log ADD COLUMN IF NOT EXISTS role text;

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
  ttft_s           numeric(12,3),                     -- 首 token 延迟（秒）
  latency_s        numeric(12,3),                     -- 整次调用耗时（秒）
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
  duration_s   numeric(12,3),                       -- 工具耗时（秒；工具常见毫秒级，整数秒会全归零）
  args_summary jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS agent_tool_run_idx  ON agent.agent_tool_call (run_id);
CREATE INDEX IF NOT EXISTS agent_tool_name_idx ON agent.agent_tool_call (agent_type, tool, ts DESC);

-- 耗时列毫秒改秒（2026-08-01 运营要求：人工查表可读）。存量库就地改列：重命名 + ÷1000 换算一次，
-- numeric(12,3) 三位小数无损保住毫秒精度（工具调用常见毫秒级，整数秒会全归零）。幂等：改过的库列名
-- 不再匹配，DO 块空转。
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='agent' AND table_name='agent_request' AND column_name='duration_ms') THEN
    ALTER TABLE agent.agent_request RENAME COLUMN duration_ms TO duration_s;
    ALTER TABLE agent.agent_request ALTER COLUMN duration_s TYPE numeric(12,3) USING round(duration_s/1000.0, 3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='agent' AND table_name='agent_token_usage' AND column_name='latency_ms') THEN
    ALTER TABLE agent.agent_token_usage RENAME COLUMN latency_ms TO latency_s;
    ALTER TABLE agent.agent_token_usage ALTER COLUMN latency_s TYPE numeric(12,3) USING round(latency_s/1000.0, 3);
    ALTER TABLE agent.agent_token_usage RENAME COLUMN ttft_ms TO ttft_s;
    ALTER TABLE agent.agent_token_usage ALTER COLUMN ttft_s TYPE numeric(12,3) USING round(ttft_s/1000.0, 3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='agent' AND table_name='agent_tool_call' AND column_name='duration_ms') THEN
    ALTER TABLE agent.agent_tool_call RENAME COLUMN duration_ms TO duration_s;
    ALTER TABLE agent.agent_tool_call ALTER COLUMN duration_s TYPE numeric(12,3) USING round(duration_s/1000.0, 3);
  END IF;
END $do$;
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
