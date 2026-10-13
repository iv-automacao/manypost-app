CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"media_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"comment_text" text DEFAULT '' NOT NULL,
	"participant_id" text NOT NULL,
	"participant_username" text,
	"conversation_id" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"step" integer DEFAULT -1 NOT NULL,
	"prompt_sent_step" integer DEFAULT -2 NOT NULL,
	"reasks" integer DEFAULT 0 NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"public_reply" text DEFAULT 'PENDING' NOT NULL,
	"private_reply" text DEFAULT 'PENDING' NOT NULL,
	"finish_sent_at" timestamp with time zone,
	"last_error" text,
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"lead_emitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"config" jsonb NOT NULL,
	"test_usernames" text[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_comment_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."comment_automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automations" ADD CONSTRAINT "comment_automations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automations" ADD CONSTRAINT "comment_automations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automations" ADD CONSTRAINT "comment_automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_automation_comment_ux" ON "automation_runs" USING btree ("automation_id","comment_id");--> statement-breakpoint
CREATE INDEX "automation_runs_channel_participant_status_ix" ON "automation_runs" USING btree ("channel_id","participant_id","status");--> statement-breakpoint
CREATE INDEX "automation_runs_org_created_ix" ON "automation_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_automations_org_channel_ix" ON "comment_automations" USING btree ("org_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_source_event_ux" ON "inbound_events" USING btree ("source","event_id");--> statement-breakpoint
CREATE INDEX "inbound_events_received_ix" ON "inbound_events" USING btree ("received_at");