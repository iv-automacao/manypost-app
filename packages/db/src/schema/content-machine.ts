import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './helpers';
import { channels } from './channels';
import { media, postGroups } from './content';
import { organizations } from './identity';

/**
 * Máquina de conteúdo (openspec add-content-machine, design D2).
 *
 * Status e chaves são `text` de conjunto fechado validado no core — mesma escolha de
 * `webhook_deliveries.status`: acrescentar um status depois não exige migration destrutiva.
 */

/** identidade visual e canal padrão da organização — uma linha por org */
export const contentBrands = pgTable(
  'content_brands',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull().default(''),
    logoMediaId: uuid('logo_media_id').references(() => media.id),
    logoDarkMediaId: uuid('logo_dark_media_id').references(() => media.id),
    /** { primaria, secundaria, destaque, fundo, texto, extraidas: string[] } — cores em #rrggbb */
    palette: jsonb('palette').notNull().default({}),
    slogan: text('slogan').notNull().default(''),
    signature: text('signature').notNull().default(''),
    tone: text('tone').notNull().default(''),
    defaultChannelId: uuid('default_channel_id').references(() => channels.id),
    ctaChannel: text('cta_channel').notNull().default('direct'),
    whatsappNumber: text('whatsapp_number').notNull().default(''),
    /** palavra do CTA ("Manda PLANO no direct"): simples de propósito, repetida entre peças */
    ctaWord: text('cta_word').notNull().default('PLANO'),
    /** palavra do CTA para empresa/MEI */
    ctaWordBusiness: text('cta_word_business').notNull().default('EMPRESA'),
    /** hora local (0–23) em que a peça aprovada é publicada no dia do slot */
    publishHour: integer('publish_hour').notNull().default(18),
    timezone: text('timezone').notNull().default('America/Manaus'),
    /** false = toda peça para em `revisao`, mesmo sem flag do revisor */
    autoApprove: boolean('auto_approve').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('content_brands_org_ux').on(t.orgId)],
);

/** documentos da fundação editorial (produtos, icp, personagem, marca, escada, pilares) */
export const contentFoundations = pgTable(
  'content_foundations',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    body: text('body').notNull().default(''),
    /** produtos com preço expiram: o revisor reprova dado de tabela vencida */
    validUntil: date('valid_until', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('content_foundations_org_key_ux').on(t.orgId, t.key)],
);

/** prompts versionados — uma versão ativa por nome */
export const contentPrompts = pgTable(
  'content_prompts',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    system: text('system').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('content_prompts_org_name_version_ux').on(t.orgId, t.name, t.version),
    uniqueIndex('content_prompts_active_ux').on(t.orgId, t.name).where(sql`${t.active}`),
  ],
);

export const contentPieces = pgTable(
  'content_pieces',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    status: text('status').notNull().default('ideia'),
    format: text('format').notNull(),
    pillar: text('pillar').notNull().default(''),
    icp: text('icp').notNull().default(''),
    market: text('market').notNull().default('manaus'),
    awareness: text('awareness').notNull().default(''),
    hook: text('hook').notNull().default(''),
    /** pauta: ângulo, fórmula, data do slot */
    plan: jsonb('plan').notNull().default({}),
    /** roteiro: hook/story/offer, slides ou cenas, pendências */
    script: jsonb('script'),
    caption: text('caption').notNull().default(''),
    hashtags: text('hashtags').array().notNull().default(sql`'{}'::text[]`),
    keyword: text('keyword').notNull(),
    /** [{ mediaId, kind, order }] */
    media: jsonb('media').notNull().default([]),
    /** saída do revisor: { aprovado, flags[], motivo } */
    review: jsonb('review'),
    /** pedidos de ajuste humanos, mais recente por último */
    feedback: jsonb('feedback').notNull().default([]),
    attempts: integer('attempts').notNull().default(0),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    channelId: uuid('channel_id').references(() => channels.id),
    postGroupId: uuid('post_group_id').references(() => postGroups.id),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    permalink: text('permalink'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    error: text('error'),
    /** trava de execução de etapa: o sweeper reenfileira quando vence */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // a palavra do CTA é simples e se repete entre peças (não identifica a peça)
    index('content_pieces_org_keyword_ix').on(t.orgId, t.keyword),
    index('content_pieces_org_status_ix').on(t.orgId, t.status),
    index('content_pieces_org_created_ix').on(t.orgId, t.createdAt),
  ],
);

export const contentPieceEvents = pgTable(
  'content_piece_events',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    pieceId: uuid('piece_id')
      .notNull()
      .references(() => contentPieces.id),
    stage: text('stage').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('content_piece_events_piece_ix').on(t.pieceId, t.createdAt)],
);

/** cada geração paga vira uma linha; `external_id` impede contar a mesma duas vezes */
export const contentSpend = pgTable(
  'content_spend',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    pieceId: uuid('piece_id').references(() => contentPieces.id),
    service: text('service').notNull(),
    model: text('model').notNull().default(''),
    externalId: text('external_id').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('content_spend_org_external_ux').on(t.orgId, t.externalId),
    index('content_spend_org_created_ix').on(t.orgId, t.createdAt),
  ],
);

/** fórmulas de gancho — moldes que a pauta usa */
export const contentHooks = pgTable(
  'content_hooks',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    formula: text('formula').notNull(),
    template: text('template').notNull(),
    example: text('example').notNull().default(''),
    pillar: text('pillar').notNull().default(''),
    origin: text('origin').notNull().default('referencia'),
    score: integer('score').notNull().default(0),
    uses: integer('uses').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('content_hooks_org_formula_ux').on(t.orgId, t.formula)],
);
