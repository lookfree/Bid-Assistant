-- 钱从严：每个 hold 至多一条了结流水（settle 或 release，其 ref=holdId）。
-- DB 层杜绝「结算成功后异常路径再补退还」造成的双返还，以及并发 settle+release 竞争。
CREATE UNIQUE INDEX IF NOT EXISTS "credit_tx_hold_settlement_uq" ON "credit_transactions" ("ref") WHERE type IN ('settle','release');
