ALTER TABLE "jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_status_ck" CHECK ("comments"."status" in ('VISIBLE', 'HIDDEN', 'DELETED'));--> statement-breakpoint
ALTER TABLE "handover_requests" ADD CONSTRAINT "handover_status_ck" CHECK ("handover_requests"."status" in ('REQUESTED', 'VERIFIED', 'COMPLETED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_type_ck" CHECK ("jobs"."type" in ('MATCH_POST'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_ck" CHECK ("jobs"."status" in ('QUEUED', 'RUNNING', 'DONE', 'FAILED'));--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_status_ck" CHECK ("matches"."status" in ('PENDING', 'CONFIRMED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_level_ck" CHECK ("matches"."level" in ('AUTO', 'CANDIDATE'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_ck" CHECK ("messages"."type" in ('TEXT', 'SYSTEM', 'VERIFY_QUESTION', 'VERIFY_ANSWER'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_ck" CHECK ("notifications"."type" in ('MATCH', 'COMMENT', 'REPLY', 'MESSAGE'));--> statement-breakpoint
ALTER TABLE "post_photos" ADD CONSTRAINT "post_photos_ai_status_ck" CHECK ("post_photos"."ai_status" in ('NONE', 'PENDING', 'DONE', 'FAILED'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_match_state_ck" CHECK ("posts"."match_state" in ('PENDING', 'DONE', 'FAILED'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_status_ck" CHECK ("posts"."status" in ('OPEN', 'MATCHED', 'RETURNED', 'CLOSED'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_type_ck" CHECK ("posts"."type" in ('LOST', 'FOUND'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_type_ck" CHECK ("reports"."target_type" in ('POST', 'COMMENT', 'MESSAGE', 'USER'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_ck" CHECK ("users"."status" in ('ACTIVE', 'DELETED'));