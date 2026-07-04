-- spec308 会员中心：plans 加档位标识 code（free/personal/professional），同档不同 cycle 行共享同 code。
ALTER TABLE "plans" ADD COLUMN "code" text;
ALTER TABLE "plans" ADD CONSTRAINT "plans_code_check" CHECK ("code" is null or "code" in ('free','personal','professional'));
