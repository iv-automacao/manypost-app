## Context

The pipeline was validated outside manypost (n8n + a Python renderer + a video API + a separate
database). This change moves orchestration, persistence and review into manypost while keeping the
renderer as an external HTTP service (it needs a headless browser and ffmpeg, which do not belong in
the API image).

## Decisions

### D1. Package ownership
- `contracts`: status set, formats, foundation keys, error codes, request/response schemas' enums.
- `core/domain/content-machine`: pure transition table (`canTransition`), lint-free
  helpers. Imports contracts only.
- `core/application`: ports (`ContentMachineRepository`, `ContentRenderer`, `VideoGenerationProvider`)
  and use cases (`content-machine.ts`, `content-machine-stages.ts`). Text generation goes through the
  existing `AiProvider` port and `withBudget`; no vendor name appears here.
- `core/infra/ai/video-*.ts`: HTTP adapter for the video provider (vendor name allowed only here).
- `core/infra/content-renderer.ts`: HTTP adapter for the renderer (generic, no vendor).
- `db`: schema `content-machine.ts`, migration, `content-machine.repo.ts`.
- `queue`: queue `content-machine`, handler wiring and a one-minute sweeper schedule.
- `api`: `/v1/content-machine/*` routes, container wiring.
- `web`: `features/content-machine/*` and routes under `app/(app)/maquina`.

### D2. Tables (all with `org_id` FK to organizations, uuidv7 ids, timestamps)
- `content_brands` (unique org): name, logo_media_id, logo_dark_media_id, palette jsonb, slogan,
  signature, tone, default_channel_id, cta_channel (`direct` | `whatsapp`), whatsapp_number.
- `content_foundations`: key (closed set), body; unique (org, key).
- `content_prompts`: name, version, system, active; unique (org, name, version); one active per name.
- `content_pieces`: status (text, closed set validated in core), format, pillar, icp, market,
  awareness, hook, plan jsonb, script jsonb, caption, hashtags text[], keyword (the brand's CTA word, repeated across pieces),
  media jsonb (media ids + order), review jsonb, feedback jsonb, attempts, scheduled_for, channel_id,
  post_group_id, published_at, permalink, cost_usd numeric, error, locked_until.
- `content_piece_events`: piece_id, stage, from_status, to_status, detail jsonb.
- `content_spend`: piece_id nullable, service, model, external_id unique, cost_usd.
- `content_hooks`: formula, template, example, pillar, origin, score, uses.

Status is `text` rather than a pgEnum so adding a status later is not destructive (same choice as
`webhook_deliveries.status`). One forward-only migration generated with
`bun run --cwd packages/db generate -- --name content-machine`; `meta/` is generated, never edited.

### D3. Stage execution
Queue `content-machine` carries `{ orgId, pieceId }`. The handler claims the piece with a conditional
update (`locked_until < now()`), reads its status and runs one stage:

| Status | Stage | Next |
|---|---|---|
| `ideia` | script + caption + lint (1 retry with findings) | `roteiro` |
| `roteiro` | production: render art, or generate narrated scenes and assemble the reel | `producao` |
| `producao` | review (reviewer prompt + lint) | `aprovado` or `revisao` |
| `aprovado` | schedule through the publishing use case | `agendado` |

After a successful stage the handler enqueues the piece again when the next status is automatic.
Retryable failures (provider, timeout, unreadable model output) retry twice with backoff before the
piece goes to `erro`. Scheduling is idempotent: the post group id is written right after the post is
created, and a retried stage reuses that group instead of creating another post. The reviewer's
`SEM_CTA` flag is dropped when the caption contains the exact keyword (checkable without a model).
Stages run in the API process (`MODE=all|standalone|full`); the dedicated worker does not consume
this queue. The queue has three local workers so a reel waiting on video does not block text stages.
The sweeper runs every minute: re-enqueue expired locks; reconcile `agendado` pieces with their post
group state. Jobs for the queue use a one-hour expiration because video generation can take minutes.

### D4. External services
- Renderer (`CONTENT_RENDERER_URL`, `CONTENT_RENDERER_KEY`): `POST /v2/render` returns PNG bytes as
  base64 for slides, drawn with the brand sent in the request (palette, logos for light and dark
  backgrounds, slogan, signature); `POST /lint`; `POST /paleta` (image URL → colors + suggested
  palette); `POST /montar-reel` (clip URLs + closing card → `video/mp4` bytes, duration in the
  `x-duracao-s` header). The legacy `POST /render` stays for the external pipeline until it is
  retired. Outbound calls reuse the outbound HTTP helper; the renderer URL
  is operator-configured (internal network allowed by configuration).
- Video provider (`VIDEO_PROVIDER_KEY`, `VIDEO_PROVIDER_MODEL`): submit, poll until terminal, read the
  cost from the provider estimate. Moderated, failed or cancelled requests are errors, never success.
- Generated bytes are persisted through the existing media persistence (org-scoped storage) before a
  piece references them.

### D5. Cost
Text cost = tokens × configured per-million prices (`CONTENT_TEXT_USD_IN`, `CONTENT_TEXT_USD_OUT`).
Video cost = provider estimate at submission. Spend rows are unique by `external_id`.

### D6. AI adapter settings
`AI_TOKEN_LIMIT_PARAM` (default `max_tokens`) and `AI_SEND_TEMPERATURE` (default `true`) are read by
the shared config mapping and applied by the chat-completions adapter only.

## Security
Human-session routes only; `orgId` from the principal; renderer and video keys never leave the server
and are never logged; prompts and generated text are not written to audit logs (audit records the
operation only).

## Observability
Every transition is an event row; stage failures log `pieceId`, stage and error code without content.

## Generated files
`packages/db/migrations/*` + `meta/` (drizzle generate), `apps/web/openapi.json` and
`apps/web/src/lib/api/schema.d.ts` (`API_URL=http://localhost:3100 bun run --cwd apps/web generate:api`).

## Rollback
Previous image ignores the queue and tables. Tables are additive.
