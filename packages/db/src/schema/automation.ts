import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './helpers';
import { channels } from './channels';
import { organizations, users } from './identity';

/**
 * Automação comentário → direct (openspec add-comment-automation, design D1).
 *
 * Status em `text` de conjunto fechado validado no core (precedente de `content_*`): acrescentar um
 * status depois não exige migration destrutiva. A migration só cria tabelas — segura no rollout e no
 * rollback (o código antigo ignora as três).
 */

/** uma automação por linha; `config` é o `CommentAutomationConfig` v1 validado em contracts */
export const commentAutomations = pgTable(
  'comment_automations',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    name: text('name').notNull(),
    /** DRAFT | TEST | ACTIVE | PAUSED */
    status: text('status').notNull().default('DRAFT'),
    config: jsonb('config').notNull(),
    /** no status TEST, só comentários destes usernames disparam */
    testUsernames: text('test_usernames').array().notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('comment_automations_org_channel_ix').on(t.orgId, t.channelId)],
);

/** execução de uma automação para um comentário — é também o lead */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => commentAutomations.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    mediaId: text('media_id').notNull(),
    commentId: text('comment_id').notNull(),
    commentText: text('comment_text').notNull().default(''),
    /** IGSID de quem comentou (o mesmo do remetente no direct) */
    participantId: text('participant_id').notNull(),
    participantUsername: text('participant_username'),
    /** id da conversa na ponte, conhecido na primeira mensagem recebida */
    conversationId: text('conversation_id'),
    /** nó atual do fluxo v2 (openspec add-flow-builder-canvas, design D5) */
    nodeId: text('node_id'),
    /** entradas em nó: compõe a Idempotency-Key `<run>:c<cursor>:<reasks>` */
    cursor: integer('cursor').notNull().default(0),
    /** último cursor cuja mensagem a ponte confirmou */
    sentCursor: integer('sent_cursor').notNull().default(-1),
    /** OPEN | COMPLETED | FAILED | UNCERTAIN | SKIPPED | ABANDONED */
    status: text('status').notNull().default('OPEN'),
    /** -1 aguarda a abertura; 0..n-1 aguarda a pergunta i; n = fim */
    step: integer('step').notNull().default(-1),
    /** maior passo cujo prompt já foi entregue (-1 = abertura entregue pela resposta privada) */
    promptSentStep: integer('prompt_sent_step').notNull().default(-2),
    reasks: integer('reasks').notNull().default(0),
    answers: jsonb('answers').notNull().default({}),
    /** PENDING | SENT | FAILED | NONE */
    publicReply: text('public_reply').notNull().default('PENDING'),
    /** PENDING | SENT | FAILED | UNCERTAIN */
    privateReply: text('private_reply').notNull().default('PENDING'),
    finishSentAt: timestamp('finish_sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }).notNull().defaultNow(),
    /** hora marcada do envio atrasado do nó atual; null = nenhum atraso pendente */
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    /** última mensagem da pessoa (janela de 24 h da Meta para o lembrete) */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    /** o lembrete desta execução já saiu (no máximo um) */
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    leadEmittedAt: timestamp('lead_emitted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('automation_runs_automation_comment_ux').on(t.automationId, t.commentId),
    index('automation_runs_channel_participant_status_ix').on(t.channelId, t.participantId, t.status),
    index('automation_runs_org_created_ix').on(t.orgId, t.createdAt),
  ],
);

/** gatilhos de uma automação (fluxo 1 → N gatilhos); hoje só `comment` (design D3) */
export const automationTriggers = pgTable(
  'automation_triggers',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => commentAutomations.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    /** comment (entrega 1); dm_keyword, story_reply… nas próximas */
    kind: text('kind').notNull(),
    config: jsonb('config').notNull(),
    /** posição do balão ⚡ no canvas */
    position: jsonb('position'),
    ...timestamps,
  },
  (t) => [
    index('automation_triggers_channel_kind_ix').on(t.channelId, t.kind),
    index('automation_triggers_automation_ix').on(t.automationId),
  ],
);

/** eventos recebidos de pontes externas, gravados uma vez e processados na fila */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: pk(),
    source: text('source').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('inbound_events_source_event_ux').on(t.source, t.eventId),
    index('inbound_events_received_ix').on(t.receivedAt),
  ],
);
