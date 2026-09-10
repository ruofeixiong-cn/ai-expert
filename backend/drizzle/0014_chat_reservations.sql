CREATE TABLE "chat_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expert_id" uuid NOT NULL,
	"fan_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_reservations" ADD CONSTRAINT "chat_reservations_expert_id_experts_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."experts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reservations" ADD CONSTRAINT "chat_reservations_fan_user_id_users_id_fk" FOREIGN KEY ("fan_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_reservations_expert_fan_idx" ON "chat_reservations" USING btree ("expert_id","fan_user_id","created_at");