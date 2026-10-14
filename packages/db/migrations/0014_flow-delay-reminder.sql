ALTER TABLE "automation_runs" ADD COLUMN "resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "reminder_sent_at" timestamp with time zone;