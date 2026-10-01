ALTER TABLE "post_photos" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post_photos" ADD COLUMN "sensitive_ai" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post_photos" ADD COLUMN "sensitive_tag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post_photos" ADD COLUMN "sensitive_override" text;--> statement-breakpoint
ALTER TABLE "post_photos" ADD COLUMN "sensitive_kinds" jsonb;--> statement-breakpoint
ALTER TABLE "post_photos" ADD COLUMN "blurred_key" text;--> statement-breakpoint
ALTER TABLE "post_photos" ADD CONSTRAINT "post_photos_override_ck" CHECK ("post_photos"."sensitive_override" is null or "post_photos"."sensitive_override" in ('MARK', 'UNMARK'));