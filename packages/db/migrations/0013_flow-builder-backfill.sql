-- Um gatilho `comment` por automação v1 que ainda não tem gatilho (openspec add-flow-builder-canvas).
-- Idempotente: rodar de novo não duplica. Não altera `comment_automations`.
INSERT INTO "automation_triggers" ("id", "org_id", "automation_id", "channel_id", "kind", "config", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  a."org_id",
  a."id",
  a."channel_id",
  'comment',
  jsonb_build_object(
    'mediaIds', COALESCE(a."config"->'trigger'->'mediaIds', '[]'::jsonb),
    'keywords', COALESCE(a."config"->'trigger'->'keywords', '[]'::jsonb),
    'publicReplies', COALESCE(a."config"->'publicReplies', '[]'::jsonb)
  ),
  now(),
  now()
FROM "comment_automations" a
WHERE a."deleted_at" IS NULL
  AND COALESCE(a."config"->>'version', '1') = '1'
  AND NOT EXISTS (SELECT 1 FROM "automation_triggers" t WHERE t."automation_id" = a."id");
