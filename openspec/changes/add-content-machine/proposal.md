## Why

Agencies that run content for clients today stitch together a planner, a copy model, a design tool, a
video generator, a reviewer and a scheduler by hand. A validated external pipeline (idea → script →
art/video → compliance review → schedule → publish) already proved the flow for a health-insurance
broker; this change brings that pipeline into manypost as an organization-scoped "content machine" so
the whole cycle is visible, reviewable and reproducible in one product.

## Goals

- Model a content piece with an explicit lifecycle and make every transition auditable.
- Let an organization keep its brand identity (logo, extracted palette, slogan, tone) and its
  editorial foundation (products, personas, voice, offers, pillars) and versioned prompts in manypost.
- Generate a week of pieces from a plan, then advance each piece automatically through script,
  production (carousel/post/story art and short video with native narration) and review.
- Stop for a human when the review flags a risk; schedule approved pieces through the existing
  publishing pipeline.
- Record the monetary cost of every generation per piece and per month.

## Non-goals

- No billing, credits or plan gating for the machine (installations run self-hosted/internal).
- No public REST or MCP surface in this change: `/v1` (human session) only.
- No lead tracking, CRM integration, metrics or paid-traffic automation (later changes).
- No model weights or self-hosted inference; generation uses approved third-party APIs only.
- No change to the existing kanban, composer or approval-link behavior.

## What Changes

- New organization-scoped tables for brand, foundation documents, prompts, pieces, piece events,
  generation spend and hook formulas, with one forward-only migration.
- New core domain (`content-machine`) with a closed status set and transition table, plus use cases
  for setup, planning, stage execution, human decisions, editing, brand and foundation management.
- New ports: a content renderer (art rendering, text lint, palette extraction, reel assembly) and a
  video generation provider; HTTP adapters live in `infra`.
- New pg-boss queue for stage execution and a periodic sweeper (stuck pieces, publication status).
- New `/v1/content-machine/*` routes and a "Máquina" area in the web app (board, piece detail,
  brand identity, foundation/prompts, spend).
- The OpenAI-compatible text adapter gains two optional settings so reasoning-family models work:
  the name of the output-token limit parameter and whether temperature is sent.

## Capabilities

### New Capabilities

- `content-machine`: organization-scoped content pipeline, brand identity, foundation, prompts,
  stage execution, human review, scheduling and spend.

### Modified Capabilities

- `ai-provider-runtime`: optional token-limit parameter name and temperature omission for the
  chat-completions dialect.

## Impact

- **Data:** additive migration only; no existing table changes. New rows are always scoped by
  `org_id`.
- **Security:** routes require an authenticated human of the organization; renderer and video
  credentials stay server-side in environment variables; outbound requests keep SSRF protection.
- **Product identity:** the area is named "Máquina" in pt-BR; the wordmark stays `manypost`.
- **Deploy:** new optional environment variables (`CONTENT_RENDERER_URL`, `CONTENT_RENDERER_KEY`,
  `VIDEO_PROVIDER_KEY`, token-parameter settings). Without them the machine reports the missing
  capability instead of failing silently. No Railway-specific change.

## Compatibility

Purely additive. Installations that never open the machine see no behavior change. The adapter
settings default to the current behavior (`max_tokens`, temperature sent).

## Rollback

Deploy the previous image. The migration is additive; its tables can remain unused or be dropped by
a follow-up down migration. Queued machine jobs are ignored by an image without the handler.
