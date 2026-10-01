CREATE INDEX "handover_post_idx" ON "handover_requests" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "messages_post_idx" ON "messages" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "notifications_post_idx" ON "notifications" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "notifications_match_idx" ON "notifications" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "notifications_comment_idx" ON "notifications" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "notifications_conversation_idx" ON "notifications" USING btree ("conversation_id");