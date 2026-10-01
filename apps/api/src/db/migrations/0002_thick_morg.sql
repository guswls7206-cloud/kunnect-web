CREATE TABLE "ai_call_counters" (
	"day" text PRIMARY KEY NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_photos" ADD COLUMN "ai_key" text;--> statement-breakpoint
CREATE INDEX "rate_counters_expires_idx" ON "rate_counters" USING btree ("expires_at");