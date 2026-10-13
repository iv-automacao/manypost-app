import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type {
  AutomationRecord,
  AutomationRepository,
  AutomationRunRecord,
  AutomationTriggerRecord,
  InboundEventRecord,
} from '@manypost/core';
import type { AutomationRunStatus, AutomationStatus } from '@manypost/contracts';
import type { Db } from '../index';
import { automationRuns, automationTriggers, commentAutomations, inboundEvents } from '../schema';

const toAutomation = (row: typeof commentAutomations.$inferSelect): AutomationRecord => ({
  id: row.id,
  orgId: row.orgId,
  channelId: row.channelId,
  name: row.name,
  status: row.status as AutomationStatus,
  config: row.config,
  testUsernames: row.testUsernames,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRun = (row: typeof automationRuns.$inferSelect): AutomationRunRecord => ({
  id: row.id,
  orgId: row.orgId,
  automationId: row.automationId,
  channelId: row.channelId,
  mediaId: row.mediaId,
  commentId: row.commentId,
  commentText: row.commentText,
  participantId: row.participantId,
  participantUsername: row.participantUsername,
  conversationId: row.conversationId,
  nodeId: row.nodeId,
  cursor: row.cursor,
  sentCursor: row.sentCursor,
  status: row.status as AutomationRunStatus,
  step: row.step,
  promptSentStep: row.promptSentStep,
  reasks: row.reasks,
  answers: (row.answers ?? {}) as Record<string, string>,
  publicReply: row.publicReply as AutomationRunRecord['publicReply'],
  privateReply: row.privateReply as AutomationRunRecord['privateReply'],
  finishSentAt: row.finishSentAt,
  lastError: row.lastError,
  lastInteractionAt: row.lastInteractionAt,
  completedAt: row.completedAt,
  leadEmittedAt: row.leadEmittedAt,
  createdAt: row.createdAt,
});

const toTrigger = (row: typeof automationTriggers.$inferSelect): AutomationTriggerRecord => ({
  id: row.id,
  orgId: row.orgId,
  automationId: row.automationId,
  channelId: row.channelId,
  kind: row.kind as 'comment',
  config: row.config,
  position: (row.position ?? null) as AutomationTriggerRecord['position'],
  createdAt: row.createdAt,
});

export function makeAutomationRepository(db: Db): AutomationRepository {
  const alive = (orgId: string, id: string) =>
    and(eq(commentAutomations.orgId, orgId), eq(commentAutomations.id, id), isNull(commentAutomations.deletedAt));

  return {
    async create({ triggers, ...d }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(commentAutomations).values(d).returning();
        const a = toAutomation(row!);
        if (triggers?.length) {
          await tx.insert(automationTriggers).values(
            triggers.map((t) => ({ orgId: a.orgId, automationId: a.id, channelId: a.channelId, kind: t.kind, config: t.config, position: t.position })),
          );
        }
        return a;
      });
    },
    async update(orgId, id, patch, triggers) {
      return db.transaction(async (tx) => {
        const [row] = Object.keys(patch).length
          ? await tx.update(commentAutomations).set(patch).where(alive(orgId, id)).returning()
          : await tx.select().from(commentAutomations).where(alive(orgId, id));
        if (!row) return null;
        if (triggers) {
          // a lista enviada substitui os gatilhos da automação, na mesma transação
          await tx.delete(automationTriggers).where(eq(automationTriggers.automationId, id));
          if (triggers.length) {
            await tx.insert(automationTriggers).values(
              triggers.map((t) => ({ orgId, automationId: id, channelId: row.channelId, kind: t.kind, config: t.config, position: t.position })),
            );
          }
        }
        return toAutomation(row);
      });
    },
    async get(orgId, id) {
      const [row] = await db.select().from(commentAutomations).where(alive(orgId, id));
      return row ? toAutomation(row) : null;
    },
    async list(orgId, filter) {
      const rows = await db
        .select()
        .from(commentAutomations)
        .where(
          and(
            eq(commentAutomations.orgId, orgId),
            isNull(commentAutomations.deletedAt),
            filter?.channelId ? eq(commentAutomations.channelId, filter.channelId) : undefined,
          ),
        )
        .orderBy(desc(commentAutomations.createdAt));
      return rows.map(toAutomation);
    },
    async softDelete(orgId, id) {
      const rows = await db
        .update(commentAutomations)
        .set({ deletedAt: new Date(), status: 'PAUSED' })
        .where(alive(orgId, id))
        .returning({ id: commentAutomations.id });
      return rows.length > 0;
    },
    async listTriggerable(channelId) {
      const rows = await db
        .select()
        .from(commentAutomations)
        .where(
          and(
            eq(commentAutomations.channelId, channelId),
            isNull(commentAutomations.deletedAt),
            inArray(commentAutomations.status, ['ACTIVE', 'TEST']),
          ),
        )
        .orderBy(asc(commentAutomations.createdAt));
      return rows.map(toAutomation);
    },
    async listTriggers(automationIds) {
      if (!automationIds.length) return [];
      const rows = await db
        .select()
        .from(automationTriggers)
        .where(inArray(automationTriggers.automationId, automationIds))
        .orderBy(asc(automationTriggers.createdAt));
      return rows.map(toTrigger);
    },

    async createRun(d) {
      const inserted = await db.insert(automationRuns).values(d).onConflictDoNothing().returning();
      if (inserted[0]) return { run: toRun(inserted[0]), created: true };
      const [existing] = await db
        .select()
        .from(automationRuns)
        .where(and(eq(automationRuns.automationId, d.automationId), eq(automationRuns.commentId, d.commentId)));
      return { run: toRun(existing!), created: false };
    },
    async getRun(id) {
      const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, id));
      return row ? toRun(row) : null;
    },
    async findOpenRun(channelId, who, since) {
      const byWho = who.participantId
        ? eq(automationRuns.participantId, who.participantId)
        : who.username
          ? sql`lower(${automationRuns.participantUsername}) = ${who.username.toLowerCase()}`
          : undefined;
      if (!byWho) return null;
      const [row] = await db
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.channelId, channelId),
            eq(automationRuns.status, 'OPEN'),
            gte(automationRuns.lastInteractionAt, since),
            byWho,
          ),
        )
        .orderBy(desc(automationRuns.lastInteractionAt))
        .limit(1);
      return row ? toRun(row) : null;
    },
    async updateRun(id, patch) {
      const [row] = await db.update(automationRuns).set(patch).where(eq(automationRuns.id, id)).returning();
      return toRun(row!);
    },
    async listRuns(orgId, filter) {
      // uuid v7 é ordenado pelo tempo: o próprio id serve de cursor
      const rows = await db
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.orgId, orgId),
            filter.automationId ? eq(automationRuns.automationId, filter.automationId) : undefined,
            filter.status ? eq(automationRuns.status, filter.status) : undefined,
            filter.cursor ? lt(automationRuns.id, filter.cursor) : undefined,
          ),
        )
        .orderBy(desc(automationRuns.id))
        .limit(filter.limit + 1);
      const items = rows.slice(0, filter.limit).map(toRun);
      const next = rows.length > filter.limit ? items.at(-1)?.id : undefined;
      return { items, ...(next ? { nextCursor: next } : {}) };
    },

    async insertInboundEvent(d) {
      const rows = await db
        .insert(inboundEvents)
        .values(d)
        .onConflictDoNothing()
        .returning({ id: inboundEvents.id });
      return rows[0]?.id ?? null;
    },
    async getInboundEvent(id) {
      const [row] = await db.select().from(inboundEvents).where(eq(inboundEvents.id, id));
      if (!row) return null;
      const out: InboundEventRecord = {
        id: row.id,
        source: row.source,
        eventId: row.eventId,
        eventType: row.eventType,
        payload: row.payload,
        processedAt: row.processedAt,
        attempts: row.attempts,
      };
      return out;
    },
    async markInboundEvent(id, outcome) {
      await db
        .update(inboundEvents)
        .set(
          'processed' in outcome
            ? { processedAt: new Date(), attempts: sql`${inboundEvents.attempts} + 1`, lastError: null }
            : { attempts: sql`${inboundEvents.attempts} + 1`, lastError: outcome.error.slice(0, 500) },
        )
        .where(eq(inboundEvents.id, id));
    },
  };
}
