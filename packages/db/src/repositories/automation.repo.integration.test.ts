import { afterAll, describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import { makeAutomationRepository } from './automation.repo';

/**
 * O que só o banco prova na automação comentário → direct (add-comment-automation): o `ON CONFLICT`
 * casa com o índice único (uma execução por comentário, um evento por id), a busca de execução
 * aberta respeita canal/janela e a listagem de leads é escopada por org com cursor pelo uuid v7.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const pgTest = databaseUrl ? test : test.skip;
const client = databaseUrl ? postgres(databaseUrl, { max: 4, onnotice: () => {} }) : null;
const db = client ? drizzle(client, { schema }) : null;
const repo = () => makeAutomationRepository(db!);

afterAll(async () => {
  await client?.end();
});

async function seed(suffix: string) {
  const [org] = await client!<{ id: string }[]>`
    INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), ${`Auto ${suffix}`}, ${`auto-${suffix}`})
    RETURNING id`;
  const [ch] = await db!
    .insert(schema.channels)
    .values({
      orgId: org!.id,
      provider: 'instagram-standalone',
      externalId: `17841${suffix}`,
      name: 'Invista',
      tokenEnc: new Uint8Array([1, 2, 3]),
    })
    .returning();
  const automation = await repo().create({
    orgId: org!.id,
    channelId: ch!.id,
    name: 'Cotação',
    status: 'ACTIVE',
    config: { version: 1 },
    testUsernames: [],
    createdBy: null,
  });
  return { orgId: org!.id, channelId: ch!.id, automation };
}

const run = (s: Awaited<ReturnType<typeof seed>>, commentId: string, participantId = 'igsid-1') => ({
  orgId: s.orgId,
  automationId: s.automation.id,
  channelId: s.channelId,
  mediaId: '1801',
  commentId,
  commentText: 'quero',
  participantId,
  participantUsername: 'Cliente.Um',
  publicReply: 'PENDING' as const,
});

describe('automação com PostgreSQL real', () => {
  pgTest('uma execução por comentário: a segunda chamada devolve a existente', async () => {
    const s = await seed(`${Date.now()}a`);
    const a = await repo().createRun(run(s, 'c-1'));
    const b = await repo().createRun(run(s, 'c-1'));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    expect(a.run).toMatchObject({ status: 'OPEN', step: -1, promptSentStep: -2, answers: {} });
  });

  pgTest('execução aberta por participante ou username, dentro da janela', async () => {
    const s = await seed(`${Date.now()}b`);
    const { run: r } = await repo().createRun(run(s, 'c-2', 'igsid-2'));
    const since = new Date(Date.now() - 60_000);
    expect((await repo().findOpenRun(s.channelId, { participantId: 'igsid-2' }, since))?.id).toBe(r.id);
    expect((await repo().findOpenRun(s.channelId, { username: 'cliente.um' }, since))?.id).toBe(r.id);
    expect(await repo().findOpenRun(s.channelId, { participantId: 'igsid-2' }, new Date(Date.now() + 60_000))).toBeNull();
    await repo().updateRun(r.id, { status: 'COMPLETED', answers: { nome: 'Ana' } });
    expect(await repo().findOpenRun(s.channelId, { participantId: 'igsid-2' }, since)).toBeNull();
  });

  pgTest('leads por org com cursor', async () => {
    const s = await seed(`${Date.now()}c`);
    const outra = await seed(`${Date.now()}d`);
    for (const c of ['c-3', 'c-4', 'c-5']) await repo().createRun(run(s, c));
    await repo().createRun(run(outra, 'c-6'));
    const p1 = await repo().listRuns(s.orgId, { limit: 2 });
    expect(p1.items.map((r) => r.commentId)).toEqual(['c-5', 'c-4']);
    const p2 = await repo().listRuns(s.orgId, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((r) => r.commentId)).toEqual(['c-3']);
    expect(p2.nextCursor).toBeUndefined();
  });

  pgTest('evento gravado uma vez por (fonte, id)', async () => {
    const eventId = `ev-${Date.now()}`;
    const a = await repo().insertInboundEvent({ source: 'zernio', eventId, eventType: 'comment.received', payload: {} });
    const b = await repo().insertInboundEvent({ source: 'zernio', eventId, eventType: 'comment.received', payload: {} });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await repo().markInboundEvent(a!, { error: 'falhou' });
    await repo().markInboundEvent(a!, { processed: true });
    expect(await repo().getInboundEvent(a!)).toMatchObject({ attempts: 2 });
  });

  pgTest('automação de outra org não aparece nem é editada', async () => {
    const s = await seed(`${Date.now()}e`);
    const outra = await seed(`${Date.now()}f`);
    expect(await repo().get(outra.orgId, s.automation.id)).toBeNull();
    expect(await repo().update(outra.orgId, s.automation.id, { name: 'x' })).toBeNull();
    expect(await repo().softDelete(outra.orgId, s.automation.id)).toBe(false);
    expect((await repo().listTriggerable(s.channelId)).map((a) => a.id)).toEqual([s.automation.id]);
  });

  pgTest('gatilhos gravados com a automação e substituídos no update', async () => {
    const s = await seed(`${Date.now()}g`);
    const trig = { kind: 'comment' as const, config: { mediaIds: [], keywords: ['plano'], publicReplies: [] }, position: { x: -240, y: 0 } };
    const a = await repo().create({
      orgId: s.orgId,
      channelId: s.channelId,
      name: 'Com gatilho',
      status: 'DRAFT',
      config: { version: 2 },
      testUsernames: [],
      createdBy: null,
      triggers: [trig],
    });
    const t1 = await repo().listTriggers([a.id]);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toMatchObject({ automationId: a.id, orgId: s.orgId, channelId: s.channelId, kind: 'comment', position: { x: -240, y: 0 } });
    await repo().update(s.orgId, a.id, { name: 'Renomeada' }, [{ ...trig, config: { mediaIds: [], keywords: ['cotação'], publicReplies: [] } }]);
    const t2 = await repo().listTriggers([a.id]);
    expect(t2).toHaveLength(1);
    expect((t2[0]!.config as { keywords: string[] }).keywords).toEqual(['cotação']);
    // update sem lista não mexe nos gatilhos; de outra org não grava nada
    await repo().update(s.orgId, a.id, { name: 'De novo' });
    expect(await repo().listTriggers([a.id])).toHaveLength(1);
    const outra = await seed(`${Date.now()}h`);
    expect(await repo().update(outra.orgId, a.id, { name: 'x' }, [])).toBeNull();
    expect(await repo().listTriggers([a.id])).toHaveLength(1);
  });

  pgTest('execução nasce sem nó, cursor 0 e enviado -1; o patch grava o cursor', async () => {
    const s = await seed(`${Date.now()}i`);
    const { run: r } = await repo().createRun(run(s, 'c-9'));
    expect(r).toMatchObject({ nodeId: null, cursor: 0, sentCursor: -1 });
    const u = await repo().updateRun(r.id, { nodeId: 'q0', cursor: 1, sentCursor: 1, status: 'ABANDONED' });
    expect(u).toMatchObject({ nodeId: 'q0', cursor: 1, sentCursor: 1, status: 'ABANDONED' });
  });

  pgTest('atraso e lembrete: colunas nascem nulas e gravam/limpam pelo patch', async () => {
    const s = await seed(`${Date.now()}k`);
    const { run: r } = await repo().createRun(run(s, 'c-10'));
    expect(r).toMatchObject({ resumeAt: null, lastInboundAt: null, reminderSentAt: null });
    const at = new Date('2026-10-14T12:00:05Z');
    const u = await repo().updateRun(r.id, { resumeAt: at, lastInboundAt: at, reminderSentAt: at });
    expect(u).toMatchObject({ resumeAt: at, lastInboundAt: at, reminderSentAt: at });
    expect((await repo().updateRun(r.id, { resumeAt: null })).resumeAt).toBeNull();
  });

  pgTest('backfill cria um gatilho por automação v1 e é idempotente', async () => {
    const s = await seed(`${Date.now()}j`);
    await repo().update(s.orgId, s.automation.id, {
      config: { version: 1, trigger: { mediaIds: ['1801'], keywords: ['plano'] }, publicReplies: ['Oi'] },
    });
    const sql = await Bun.file(new URL('../../migrations/0013_flow-builder-backfill.sql', import.meta.url)).text();
    await client!.unsafe(sql);
    await client!.unsafe(sql);
    const t = await repo().listTriggers([s.automation.id]);
    expect(t).toHaveLength(1);
    expect(t[0]!.config).toEqual({ mediaIds: ['1801'], keywords: ['plano'], publicReplies: ['Oi'] });
  });
});
