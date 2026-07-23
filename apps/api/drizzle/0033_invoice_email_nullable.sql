-- spec332：发票改为站内下载后不再收集邮箱，email 列放开 NOT NULL（历史数据保留，新申请不填）。
ALTER TABLE "invoice_requests" ALTER COLUMN "email" DROP NOT NULL;
