-- spec310 运营手动调积分：credit_transactions 加 admin_adjust 类型（±，运营后台调整）。
ALTER TABLE "credit_transactions" DROP CONSTRAINT IF EXISTS "credit_tx_type_check";
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_tx_type_check" CHECK ("type" in ('grant','purchase','hold','settle','release','expire','referral_reward','refund_clawback','admin_adjust'));
