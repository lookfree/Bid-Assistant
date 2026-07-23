-- spec332：发票加 file_key（运营上传的电子发票 PDF 在 MinIO 的对象 key），供邮件下载链接/站内下载现签。
ALTER TABLE "invoice_requests" ADD COLUMN IF NOT EXISTS "file_key" text;
