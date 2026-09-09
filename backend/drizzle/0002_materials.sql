CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expert_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"title" text,
	"raw_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "material_id" uuid;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "injection_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_expert_id_experts_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."experts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "materials_tenant_expert_idx" ON "materials" USING btree ("tenant_id","expert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "materials_expert_hash_key" ON "materials" USING btree ("expert_id","content_hash");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_material_idx" ON "chunks" USING btree ("material_id");