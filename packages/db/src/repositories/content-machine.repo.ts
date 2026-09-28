import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import type {
  ContentFormat,
  ContentFoundationKey,
  ContentPieceStatus,
  ContentPromptName,
  ContentCtaChannel,
} from '@manypost/contracts';
import type {
  ContentBrandRecord,
  ContentMachineRepository,
  ContentPiecePatch,
  ContentPieceRecord,
} from '@manypost/core';
import type { Db } from '../index';
import {
  contentBrands,
  contentFoundations,
  contentHooks,
  contentPieceEvents,
  contentPieces,
  contentPrompts,
  contentSpend,
} from '../schema';

const AUTOMATICOS: ContentPieceStatus[] = ['ideia', 'roteiro', 'producao', 'aprovado'];

const toBrand = (row: typeof contentBrands.$inferSelect): ContentBrandRecord => ({
  orgId: row.orgId,
  name: row.name,
  logoMediaId: row.logoMediaId,
  logoDarkMediaId: row.logoDarkMediaId,
  palette: (row.palette ?? {}) as ContentBrandRecord['palette'],
  slogan: row.slogan,
  signature: row.signature,
  tone: row.tone,
  defaultChannelId: row.defaultChannelId,
  ctaChannel: row.ctaChannel as ContentCtaChannel,
  whatsappNumber: row.whatsappNumber,
  publishHour: row.publishHour,
  timezone: row.timezone,
  autoApprove: row.autoApprove,
  updatedAt: row.updatedAt,
});

const toPiece = (row: typeof contentPieces.$inferSelect): ContentPieceRecord => ({
  id: row.id,
  orgId: row.orgId,
  status: row.status as ContentPieceStatus,
  format: row.format as ContentFormat,
  pillar: row.pillar,
  icp: row.icp,
  market: row.market,
  awareness: row.awareness,
  hook: row.hook,
  plan: (row.plan ?? {}) as Record<string, unknown>,
  script: (row.script ?? null) as Record<string, unknown> | null,
  caption: row.caption,
  hashtags: row.hashtags,
  keyword: row.keyword,
  media: (row.media ?? []) as ContentPieceRecord['media'],
  review: (row.review ?? null) as ContentPieceRecord['review'],
  feedback: (row.feedback ?? []) as ContentPieceRecord['feedback'],
  attempts: row.attempts,
  scheduledFor: row.scheduledFor,
  channelId: row.channelId,
  postGroupId: row.postGroupId,
  publishedAt: row.publishedAt,
  permalink: row.permalink,
  costUsd: Number(row.costUsd),
  error: row.error,
  lockedUntil: row.lockedUntil,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** traduz o patch do core para colunas; `undefined` = não mexe */
const patchColumns = (p: ContentPiecePatch) => {
  const { incrementAttempts, resetAttempts, ...campos } = p;
  const out: Partial<typeof contentPieces.$inferInsert> & Record<string, unknown> = {};
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) out[k] = v;
  if (incrementAttempts) out.attempts = sql`${contentPieces.attempts} + 1` as unknown as number;
  if (resetAttempts) out.attempts = 0;
  return out;
};

export function makeContentMachineRepository(db: Db): ContentMachineRepository {
  return {
    async getBrand(orgId) {
      const [row] = await db.select().from(contentBrands).where(eq(contentBrands.orgId, orgId)).limit(1);
      return row ? toBrand(row) : null;
    },

    async upsertBrand(orgId, patch) {
      const campos = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const [row] = await db
        .insert(contentBrands)
        .values({ orgId, ...campos })
        .onConflictDoUpdate({
          target: contentBrands.orgId,
          set: { ...campos, updatedAt: new Date() },
        })
        .returning();
      return toBrand(row!);
    },

    async listFoundations(orgId) {
      const rows = await db
        .select()
        .from(contentFoundations)
        .where(eq(contentFoundations.orgId, orgId))
        .orderBy(asc(contentFoundations.key));
      return rows.map((r) => ({
        key: r.key as ContentFoundationKey,
        body: r.body,
        validUntil: r.validUntil,
        updatedAt: r.updatedAt,
      }));
    },

    async upsertFoundation(orgId, key, body, validUntil) {
      const [row] = await db
        .insert(contentFoundations)
        .values({ orgId, key, body, validUntil })
        .onConflictDoUpdate({
          target: [contentFoundations.orgId, contentFoundations.key],
          set: { body, validUntil, updatedAt: new Date() },
        })
        .returning();
      return {
        key: row!.key as ContentFoundationKey,
        body: row!.body,
        validUntil: row!.validUntil,
        updatedAt: row!.updatedAt,
      };
    },

    async seedFoundations(orgId, keys) {
      if (keys.length === 0) return;
      await db
        .insert(contentFoundations)
        .values(keys.map((key) => ({ orgId, key })))
        .onConflictDoNothing();
    },

    async listPrompts(orgId) {
      const rows = await db
        .select()
        .from(contentPrompts)
        .where(eq(contentPrompts.orgId, orgId))
        .orderBy(asc(contentPrompts.name), desc(contentPrompts.version));
      return rows.map((r) => ({
        id: r.id,
        name: r.name as ContentPromptName,
        version: r.version,
        system: r.system,
        active: r.active,
        createdAt: r.createdAt,
      }));
    },

    async activePrompt(orgId, name) {
      const [r] = await db
        .select()
        .from(contentPrompts)
        .where(and(eq(contentPrompts.orgId, orgId), eq(contentPrompts.name, name), eq(contentPrompts.active, true)))
        .limit(1);
      return r
        ? { id: r.id, name: r.name as ContentPromptName, version: r.version, system: r.system, active: r.active, createdAt: r.createdAt }
        : null;
    },

    async savePromptVersion(orgId, name, system) {
      const r = await db.transaction(async (tx) => {
        // serializa por (org, nome): FOR UPDATE não enxerga a versão que outra transação acabou de
        // inserir, e sem linhas não trava nada — o advisory lock cobre os dois casos
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`content_prompts:${orgId}:${name}`}))`);
        const atuais = await tx
          .select({ version: contentPrompts.version })
          .from(contentPrompts)
          .where(and(eq(contentPrompts.orgId, orgId), eq(contentPrompts.name, name)));
        const proxima = atuais.reduce((m, x) => Math.max(m, x.version), 0) + 1;
        await tx
          .update(contentPrompts)
          .set({ active: false, updatedAt: new Date() })
          .where(and(eq(contentPrompts.orgId, orgId), eq(contentPrompts.name, name), eq(contentPrompts.active, true)));
        const [nova] = await tx
          .insert(contentPrompts)
          .values({ orgId, name, version: proxima, system, active: true })
          .returning();
        return nova!;
      });
      return { id: r.id, name: r.name as ContentPromptName, version: r.version, system: r.system, active: r.active, createdAt: r.createdAt };
    },

    async seedPrompts(orgId, prompts) {
      if (prompts.length === 0) return;
      // versão 1 só entra quando o nome não tem nenhuma: o unique (org, nome, versão) garante
      await db
        .insert(contentPrompts)
        .values(prompts.map((p) => ({ orgId, name: p.name, version: 1, system: p.system, active: true })))
        .onConflictDoNothing();
    },

    async listHooks(orgId) {
      const rows = await db
        .select()
        .from(contentHooks)
        .where(eq(contentHooks.orgId, orgId))
        .orderBy(desc(contentHooks.score), asc(contentHooks.uses));
      return rows.map((r) => ({
        id: r.id,
        formula: r.formula,
        template: r.template,
        example: r.example,
        pillar: r.pillar,
        origin: r.origin,
        score: r.score,
        uses: r.uses,
      }));
    },

    async seedHooks(orgId, hooks) {
      if (hooks.length === 0) return;
      await db
        .insert(contentHooks)
        .values(hooks.map((h) => ({ orgId, ...h })))
        .onConflictDoNothing();
    },

    async bumpHookUse(orgId, formula) {
      await db
        .update(contentHooks)
        .set({ uses: sql`${contentHooks.uses} + 1` })
        .where(and(eq(contentHooks.orgId, orgId), eq(contentHooks.formula, formula)));
    },

    async createPiece(orgId, d) {
      const [row] = await db.transaction(async (tx) => {
        const criada = await tx.insert(contentPieces).values({ orgId, ...d, status: 'ideia' }).returning();
        await tx.insert(contentPieceEvents).values({
          orgId,
          pieceId: criada[0]!.id,
          stage: 'criacao',
          fromStatus: null,
          toStatus: 'ideia',
          detail: { formato: d.format },
        });
        return criada;
      });
      return toPiece(row!);
    },

    async listPieces(orgId, opts) {
      const rows = await db
        .select()
        .from(contentPieces)
        .where(
          and(
            eq(contentPieces.orgId, orgId),
            opts?.statuses?.length ? inArray(contentPieces.status, opts.statuses) : sql`true`,
          ),
        )
        .orderBy(desc(contentPieces.createdAt))
        .limit(Math.min(opts?.limit ?? 200, 500));
      return rows.map(toPiece);
    },

    async getPiece(orgId, id) {
      const [row] = await db
        .select()
        .from(contentPieces)
        .where(and(eq(contentPieces.orgId, orgId), eq(contentPieces.id, id)))
        .limit(1);
      return row ? toPiece(row) : null;
    },

    async keywordsWithPrefix(orgId, prefix) {
      const rows = await db
        .select({ keyword: contentPieces.keyword })
        .from(contentPieces)
        .where(and(eq(contentPieces.orgId, orgId), like(contentPieces.keyword, `${prefix}%`)));
      return rows.map((r) => r.keyword);
    },

    async hooksSince(orgId, since) {
      const rows = await db
        .select({ hook: contentPieces.hook })
        .from(contentPieces)
        .where(and(eq(contentPieces.orgId, orgId), gte(contentPieces.createdAt, since)));
      return rows.map((r) => r.hook).filter(Boolean);
    },

    async claim(orgId, id, status, leaseSec) {
      const [row] = await db
        .update(contentPieces)
        // truncado em ms: o valor volta ao JS sem perda e serve de token de posse (fence)
        .set({ lockedUntil: sql`date_trunc('milliseconds', now() + make_interval(secs => ${leaseSec}))` })
        .where(
          and(
            eq(contentPieces.orgId, orgId),
            eq(contentPieces.id, id),
            eq(contentPieces.status, status),
            or(isNull(contentPieces.lockedUntil), lt(contentPieces.lockedUntil, sql`now()`)),
          ),
        )
        .returning();
      return row ? toPiece(row) : null;
    },

    async release(orgId, id, opts) {
      const rows = await db
        .update(contentPieces)
        .set({ ...patchColumns(opts.patch ?? {}), lockedUntil: opts.holdUntil ?? null })
        .where(
          and(
            eq(contentPieces.orgId, orgId),
            eq(contentPieces.id, id),
            opts.fence ? eq(contentPieces.lockedUntil, opts.fence) : sql`true`,
          ),
        )
        .returning({ id: contentPieces.id });
      return rows.length > 0;
    },

    async transition(orgId, id, from, to, patch, event, fence) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(contentPieces)
          .set({ ...patchColumns(patch), status: to, lockedUntil: null })
          .where(
            and(
              eq(contentPieces.orgId, orgId),
              eq(contentPieces.id, id),
              eq(contentPieces.status, from),
              fence ? eq(contentPieces.lockedUntil, fence) : sql`true`,
            ),
          )
          .returning();
        if (!row) return null;
        await tx.insert(contentPieceEvents).values({
          orgId,
          pieceId: id,
          stage: event.stage,
          fromStatus: from,
          toStatus: to,
          detail: event.detail ?? {},
        });
        return toPiece(row);
      });
    },

    async update(orgId, id, patch, opts) {
      const filtros = and(
        eq(contentPieces.orgId, orgId),
        eq(contentPieces.id, id),
        opts?.onlyIn?.length ? inArray(contentPieces.status, opts.onlyIn) : sql`true`,
        opts?.fence ? eq(contentPieces.lockedUntil, opts.fence) : sql`true`,
        opts?.unlocked ? or(isNull(contentPieces.lockedUntil), lt(contentPieces.lockedUntil, sql`now()`)) : sql`true`,
      );
      const campos = patchColumns(patch);
      // drizzle recusa `.set({})`: patch vazio só confere as condições e devolve a peça
      if (Object.keys(campos).length === 0) {
        const [row] = await db.select().from(contentPieces).where(filtros).limit(1);
        return row ? toPiece(row) : null;
      }
      const [row] = await db.update(contentPieces).set(campos).where(filtros).returning();
      return row ? toPiece(row) : null;
    },

    async plannedSlots(orgId, from, to) {
      const rows = await db
        .select({ slot: sql<string>`${contentPieces.plan}->>'slot'`, format: contentPieces.format })
        .from(contentPieces)
        .where(
          and(
            eq(contentPieces.orgId, orgId),
            sql`${contentPieces.plan}->>'origem' = 'pauta'`,
            sql`${contentPieces.plan}->>'slot' between ${from} and ${to}`,
            sql`${contentPieces.status} <> 'reprovado'`,
          ),
        );
      return rows;
    },

    async events(orgId, pieceId) {
      const rows = await db
        .select()
        .from(contentPieceEvents)
        .where(and(eq(contentPieceEvents.orgId, orgId), eq(contentPieceEvents.pieceId, pieceId)))
        .orderBy(asc(contentPieceEvents.createdAt));
      return rows.map((r) => ({
        id: r.id,
        stage: r.stage,
        fromStatus: (r.fromStatus ?? null) as ContentPieceStatus | null,
        toStatus: r.toStatus as ContentPieceStatus,
        detail: (r.detail ?? {}) as Record<string, unknown>,
        createdAt: r.createdAt,
      }));
    },

    async stalled(now, idleSec) {
      const limite = new Date(now.getTime() - idleSec * 1000);
      const rows = await db
        .select({ orgId: contentPieces.orgId, id: contentPieces.id })
        .from(contentPieces)
        .where(
          and(
            inArray(contentPieces.status, AUTOMATICOS),
            or(
              lt(contentPieces.lockedUntil, now),
              and(isNull(contentPieces.lockedUntil), lt(contentPieces.updatedAt, limite)),
            ),
          ),
        )
        .limit(50);
      return rows;
    },

    async erroredWithPost() {
      const rows = await db
        .select({
          orgId: contentPieces.orgId,
          id: contentPieces.id,
          postGroupId: sql<string>`coalesce(${contentPieces.plan}->>'agendamentoId', ${contentPieces.postGroupId}::text)`,
        })
        .from(contentPieces)
        .where(
          and(
            eq(contentPieces.status, 'erro'),
            sql`coalesce(${contentPieces.plan}->>'agendamentoId', ${contentPieces.postGroupId}::text) is not null`,
          ),
        )
        .limit(200);
      return rows;
    },

    async scheduled() {
      return db
        .select({ orgId: contentPieces.orgId, id: contentPieces.id, postGroupId: contentPieces.postGroupId })
        .from(contentPieces)
        .where(eq(contentPieces.status, 'agendado'))
        .limit(200);
    },

    async addSpend(d) {
      return db.transaction(async (tx) => {
        const inserida = await tx
          .insert(contentSpend)
          .values({
            orgId: d.orgId,
            pieceId: d.pieceId,
            service: d.service,
            model: d.model,
            externalId: d.externalId,
            costUsd: d.costUsd.toFixed(6),
            detail: d.detail ?? {},
          })
          .onConflictDoNothing()
          .returning({ id: contentSpend.id });
        if (inserida.length === 0) return false;
        if (d.pieceId) {
          await tx
            .update(contentPieces)
            .set({ costUsd: sql`${contentPieces.costUsd} + ${d.costUsd.toFixed(6)}::numeric` })
            .where(and(eq(contentPieces.orgId, d.orgId), eq(contentPieces.id, d.pieceId)));
        }
        return true;
      });
    },

    async spendSummary(orgId, from, to) {
      const janela = and(eq(contentSpend.orgId, orgId), gte(contentSpend.createdAt, from), lt(contentSpend.createdAt, to));
      const porServico = await db
        .select({
          service: contentSpend.service,
          model: contentSpend.model,
          costUsd: sql<string>`coalesce(sum(${contentSpend.costUsd}), 0)`,
          count: sql<number>`count(*)::int`,
        })
        .from(contentSpend)
        .where(janela)
        .groupBy(contentSpend.service, contentSpend.model)
        .orderBy(desc(sql`sum(${contentSpend.costUsd})`));
      const porPeca = await db
        .select({
          pieceId: contentPieces.id,
          keyword: contentPieces.keyword,
          format: contentPieces.format,
          costUsd: sql<string>`coalesce(sum(${contentSpend.costUsd}), 0)`,
        })
        .from(contentSpend)
        .innerJoin(contentPieces, eq(contentPieces.id, contentSpend.pieceId))
        .where(janela)
        .groupBy(contentPieces.id, contentPieces.keyword, contentPieces.format)
        .orderBy(desc(sql`sum(${contentSpend.costUsd})`))
        .limit(50);
      const byService = porServico.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
      return {
        totalUsd: byService.reduce((s, r) => s + r.costUsd, 0),
        byService,
        pieces: porPeca.map((r) => ({ ...r, costUsd: Number(r.costUsd) })),
      };
    },
  };
}
