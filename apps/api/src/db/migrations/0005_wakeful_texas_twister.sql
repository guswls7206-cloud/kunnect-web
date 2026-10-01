-- 글 검색(ILIKE)용 trigram 인덱스에 pg_trgm 확장이 필요하다. 관리형 DB 는 확장 생성 권한/허용 여부를 확인할 것.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("id") WHERE "jobs"."status" = 'QUEUED';--> statement-breakpoint
CREATE INDEX "posts_title_trgm_idx" ON "posts" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "posts_description_trgm_idx" ON "posts" USING gin ("description" gin_trgm_ops);