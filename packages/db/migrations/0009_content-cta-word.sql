DROP INDEX "content_pieces_org_keyword_ux";--> statement-breakpoint
ALTER TABLE "content_brands" ADD COLUMN "cta_word" text DEFAULT 'PLANO' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_brands" ADD COLUMN "cta_word_business" text DEFAULT 'EMPRESA' NOT NULL;--> statement-breakpoint
CREATE INDEX "content_pieces_org_keyword_ix" ON "content_pieces" USING btree ("org_id","keyword");