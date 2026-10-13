CREATE TABLE "automation_triggers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"position" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "node_id" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "sent_cursor" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_comment_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."comment_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_triggers_channel_kind_ix" ON "automation_triggers" USING btree ("channel_id","kind");--> statement-breakpoint
CREATE INDEX "automation_triggers_automation_ix" ON "automation_triggers" USING btree ("automation_id");