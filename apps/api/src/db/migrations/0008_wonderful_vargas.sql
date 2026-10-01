-- 쪽지함 대화 삭제(사용자별 삭제) 컬럼. 멱등: 이전 번호(0007_cultured_harrier)로 이미 적용된 DB 에서도 안전하게 재적용되도록 IF NOT EXISTS 사용
ALTER TABLE "conversation_members" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN IF NOT EXISTS "cleared_message_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 안전망: 0007_post_location_text 와 번호 충돌을 정리하는 과정에서 건너뛰어졌을 수 있는 DB 대비(멱등)
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "location_text" text;
