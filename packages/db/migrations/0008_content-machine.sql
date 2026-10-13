CREATE TABLE "content_brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"logo_media_id" uuid,
	"logo_dark_media_id" uuid,
	"palette" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"slogan" text DEFAULT '' NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"tone" text DEFAULT '' NOT NULL,
	"default_channel_id" uuid,
	"cta_channel" text DEFAULT 'direct' NOT NULL,
	"whatsapp_number" text DEFAULT '' NOT NULL,
	"publish_hour" integer DEFAULT 18 NOT NULL,
	"timezone" text DEFAULT 'America/Manaus' NOT NULL,
	"auto_approve" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_foundations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"valid_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_hooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"formula" text NOT NULL,
	"template" text NOT NULL,
	"example" text DEFAULT '' NOT NULL,
	"pillar" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'referencia' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_piece_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"piece_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_pieces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'ideia' NOT NULL,
	"format" text NOT NULL,
	"pillar" text DEFAULT '' NOT NULL,
	"icp" text DEFAULT '' NOT NULL,
	"market" text DEFAULT 'manaus' NOT NULL,
	"awareness" text DEFAULT '' NOT NULL,
	"hook" text DEFAULT '' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"script" jsonb,
	"caption" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"keyword" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review" jsonb,
	"feedback" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"channel_id" uuid,
	"post_group_id" uuid,
	"published_at" timestamp with time zone,
	"permalink" text,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"system" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_spend" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"piece_id" uuid,
	"service" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"external_id" text NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_brands" ADD CONSTRAINT "content_brands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_brands" ADD CONSTRAINT "content_brands_logo_media_id_media_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_brands" ADD CONSTRAINT "content_brands_logo_dark_media_id_media_id_fk" FOREIGN KEY ("logo_dark_media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_brands" ADD CONSTRAINT "content_brands_default_channel_id_channels_id_fk" FOREIGN KEY ("default_channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_foundations" ADD CONSTRAINT "content_foundations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_hooks" ADD CONSTRAINT "content_hooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_piece_events" ADD CONSTRAINT "content_piece_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_piece_events" ADD CONSTRAINT "content_piece_events_piece_id_content_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_post_group_id_post_groups_id_fk" FOREIGN KEY ("post_group_id") REFERENCES "public"."post_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_prompts" ADD CONSTRAINT "content_prompts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_spend" ADD CONSTRAINT "content_spend_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_spend" ADD CONSTRAINT "content_spend_piece_id_content_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_brands_org_ux" ON "content_brands" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_foundations_org_key_ux" ON "content_foundations" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "content_hooks_org_formula_ux" ON "content_hooks" USING btree ("org_id","formula");--> statement-breakpoint
CREATE INDEX "content_piece_events_piece_ix" ON "content_piece_events" USING btree ("piece_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_pieces_org_keyword_ux" ON "content_pieces" USING btree ("org_id","keyword");--> statement-breakpoint
CREATE INDEX "content_pieces_org_status_ix" ON "content_pieces" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "content_pieces_org_created_ix" ON "content_pieces" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_prompts_org_name_version_ux" ON "content_prompts" USING btree ("org_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "content_prompts_active_ux" ON "content_prompts" USING btree ("org_id","name") WHERE "content_prompts"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "content_spend_org_external_ux" ON "content_spend" USING btree ("org_id","external_id");--> statement-breakpoint
CREATE INDEX "content_spend_org_created_ix" ON "content_spend" USING btree ("org_id","created_at");