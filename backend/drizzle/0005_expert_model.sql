CREATE TABLE "expert_model_drafts" (
	"expert_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"model" jsonb NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_jobs" ADD COLUMN "kind" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "experts" ADD COLUMN "confirmed_dimensions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "experts" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expert_model_drafts" ADD CONSTRAINT "expert_model_drafts_expert_id_experts_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."experts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expert_model_drafts_tenant_idx" ON "expert_model_drafts" USING btree ("tenant_id");