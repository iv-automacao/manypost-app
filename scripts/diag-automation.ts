/**
 * Diagnóstico da automação comentário → direct (change add-comment-automation, tarefa 7.3).
 *
 * Roda DENTRO do container (precisa de DATABASE_URL e, para a parte da Zernio, ZERNIO_API_KEY):
 *
 *   bun run scripts/diag-automation.ts <channelId>
 *
 * Responde "onde o comentário parou": o webhook está registrado e ativo na Zernio, a Zernio
 * entregou (logs de entrega), o manypost gravou o evento, a fila processou, e — refazendo os
 * filtros do motor sobre cada comentário gravado — por que ele disparou ou não. Nunca imprime
 * chave, segredo, token nem texto de comentário; usernames só aparecem como "na lista de teste".
 */
import { automationLogic, commentTriggerOf, loadFlow, type LoadedFlow } from '@manypost/core';
import { createDb, makeAutomationRepository } from '@manypost/db';
import { parseZernioEvent } from '@manypost/providers';

const [channelId] = process.argv.slice(2);
if (!channelId) {
  console.error('uso: bun run scripts/diag-automation.ts <channelId>');
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL ?? '');
const row = await db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, channelId) });
if (!row) throw new Error('canal não encontrado');
const userId = (row.settings as { userId?: string } | null)?.userId || row.externalId;
const orgs = (process.env.ZERNIO_ORG_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

console.log('\n== ambiente');
console.log(`canal provider=${row.provider} status=${row.status} · MODE=${process.env.MODE ?? 'all (padrão)'}`);
console.log(
  `ZERNIO_API_KEY ${process.env.ZERNIO_API_KEY ? 'ok' : 'AUSENTE'} · org ${orgs.includes(row.orgId) ? 'na' : 'FORA da'} ZERNIO_ORG_IDS · ZERNIO_WEBHOOK_SECRET ${process.env.ZERNIO_WEBHOOK_SECRET ? 'ok' : 'AUSENTE'}`,
);
if (process.env.MODE === 'api') console.log('⚠ MODE=api não consome a fila automation-event');

// ---------- Zernio: conta, webhook e logs de entrega
let zernioAccountId: string | null = null;
const key = process.env.ZERNIO_API_KEY;
if (key) {
  const API = (process.env.ZERNIO_API_URL ?? 'https://zernio.com/api/v1').replace(/\/+$/, '');
  const zget = async (path: string) => {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  console.log('\n== Zernio');
  const acc = await zget('/accounts?platform=instagram');
  const accounts = (acc.json.accounts ?? []) as Array<{ _id: string; platformUserId?: string; username?: string; isActive?: boolean }>;
  const account =
    accounts.find((a) => a.platformUserId === userId) ??
    accounts.find((a) => row.username && a.username?.toLowerCase() === row.username.toLowerCase());
  if (!account) console.log(`✗ a chave não enxerga a conta (HTTP ${acc.status}, ${accounts.length} contas IG)`);
  else {
    zernioAccountId = account._id;
    console.log(`conta ${account._id} · ativa=${account.isActive !== false} · platformUserId ${account.platformUserId === userId ? 'confere' : 'DIFERENTE do canal'}`);
  }

  const wh = await zget('/webhooks/settings');
  const hooks = (wh.json.webhooks ?? []) as Array<Record<string, unknown>>;
  console.log(`webhooks na Zernio: ${hooks.length} (HTTP ${wh.status})`);
  for (const h of hooks) {
    const ids = (h.accountIds ?? []) as string[];
    console.log(
      `- ${String(h._id)} url=${String(h.url)} ativo=${String(h.isActive)} eventos=${JSON.stringify(h.events)} ` +
        `contas=${ids.length === 0 ? 'todas' : ids.includes(zernioAccountId ?? '') ? 'inclui a conta ✓' : 'NÃO inclui a conta ✗'}` +
        (h.failureCount ? ` falhas=${String(h.failureCount)}` : '') +
        (h.lastFiredAt ? ` último disparo=${String(h.lastFiredAt)}` : ''),
    );
  }

  const logs = await zget('/webhooks/logs?limit=15');
  const items = (logs.json.logs ?? logs.json.data ?? []) as Array<Record<string, unknown>>;
  if (logs.status !== 200) console.log(`logs de entrega: HTTP ${logs.status}`);
  else {
    console.log(`últimas entregas (${items.length}):`);
    for (const l of items) {
      console.log(
        `- ${String(l.createdAt ?? l.timestamp ?? '?')} ${String(l.event ?? '?')} → ${String(l.statusCode ?? l.status ?? '?')}` +
          (l.errorMessage || l.error ? ` erro=${String(l.errorMessage ?? l.error).slice(0, 120)}` : ''),
      );
    }
  }
}

// ---------- manypost: automações do canal
console.log('\n== automações do canal');
const automations = await db.query.commentAutomations.findMany({
  where: (a, { eq, and, isNull }) => and(eq(a.channelId, channelId), isNull(a.deletedAt)),
});
const triggerRows = await makeAutomationRepository(db).listTriggers(automations.map((a) => a.id));
const loadedById = new Map<string, LoadedFlow | null>();
for (const a of automations) {
  const loaded = loadFlow(a.config);
  loadedById.set(a.id, loaded);
  const mine = triggerRows.filter((t) => t.automationId === a.id);
  console.log(
    `- ${a.id} "${a.name}" status=${a.status} contas de teste=${a.testUsernames.length} ` +
      (loaded ? `config v${(a.config as { version?: number }).version ?? 1} nós=${loaded.flow.nodes.length}` : 'CONFIG INVÁLIDA'),
  );
  if (mine.length === 0) {
    const t = loaded ? commentTriggerOf(a.id, triggerRows, loaded) : null;
    console.log(`    gatilho: (gatilho da config v1)${t ? ` posts=${t.mediaIds.length === 0 ? 'todos' : t.mediaIds.length} palavras=${JSON.stringify(t.keywords)} respostas públicas=${t.publicReplies.length}` : ''}`);
  }
  for (const t of mine) {
    const c = (t.config ?? {}) as { mediaIds?: string[]; keywords?: string[]; publicReplies?: string[] };
    console.log(
      `    gatilho ${t.kind}: posts=${c.mediaIds?.length ? c.mediaIds.length : 'todos'} palavras=${JSON.stringify(c.keywords ?? [])} respostas públicas=${c.publicReplies?.length ?? 0}`,
    );
  }
}
if (automations.length === 0) console.log('nenhuma automação neste canal');

// ---------- manypost: eventos recebidos
console.log('\n== eventos recebidos (últimos 15)');
const events = await db.query.inboundEvents.findMany({
  orderBy: (e, { desc }) => [desc(e.receivedAt)],
  limit: 15,
});
if (events.length === 0) console.log('NENHUM evento gravado — a Zernio não entregou nada na rota');
for (const e of events) {
  const p = parseZernioEvent(e.eventType, e.payload);
  const raw = e.payload as { account?: { accountId?: string; id?: string } };
  const accRef = raw.account?.accountId ?? raw.account?.id ?? '?';
  let why = '';
  if (!p) why = 'descartado no parse (não é Instagram ou falta campo)';
  else if (zernioAccountId && p.accountRef !== zernioAccountId) why = 'conta da Zernio diferente da deste canal';
  else if (p.kind === 'comment') {
    if (p.isReply) why = 'é resposta a comentário (ignorado)';
    else if (p.isOwn) why = 'autor é a própria conta (ignorado)';
    else {
      const author = p.authorUsername?.toLowerCase() ?? null;
      const per = automations
        .filter((a) => a.status === 'TEST' || a.status === 'ACTIVE')
        .map((a) => {
          const loaded = loadedById.get(a.id);
          const t = loaded ? commentTriggerOf(a.id, triggerRows, loaded) : null;
          if (!t) return `"${a.name}": config ou gatilho inválido`;
          if (a.status === 'TEST' && !(author && a.testUsernames.includes(author)))
            return `"${a.name}": autor ${author ? 'fora da lista de teste' : 'SEM username no evento'}`;
          if (t.mediaIds.length > 0 && !t.mediaIds.includes(p.mediaId)) return `"${a.name}": post ${p.mediaId} fora da lista`;
          if (!automationLogic.matchesCommentTrigger(t, { mediaId: p.mediaId, text: p.text })) return `"${a.name}": palavra-chave não bateu`;
          return `"${a.name}": BATEU`;
        });
      why = per.length ? per.join(' · ') : 'nenhuma automação em Teste/Ativa';
    }
  } else why = `mensagem ${p.outgoing ? 'enviada (ignorada)' : p.standby ? 'em standby (ignorada)' : 'recebida'}${p.payload ? ' com botão' : ''}`;
  console.log(
    `- ${e.receivedAt.toISOString()} ${e.eventType} conta=${accRef} processado=${e.processedAt ? 'sim' : 'NÃO'} tentativas=${e.attempts}` +
      (e.lastError ? ` erro=${e.lastError.slice(0, 160)}` : '') +
      `\n    → ${why}`,
  );
}

// ---------- execuções
console.log('\n== execuções (últimas 10)');
const runs = await db.query.automationRuns.findMany({
  where: (r, { eq }) => eq(r.channelId, channelId),
  orderBy: (r, { desc }) => [desc(r.createdAt)],
  limit: 10,
});
if (runs.length === 0) console.log('nenhuma execução');
for (const r of runs) {
  console.log(
    `- ${r.createdAt.toISOString()} status=${r.status} passo=${r.step} nó=${r.nodeId ?? '-'} cursor=${r.cursor} enviado=${r.sentCursor} pública=${r.publicReply} privada=${r.privateReply}` +
      (r.lastError ? ` erro=${r.lastError.slice(0, 200)}` : ''),
  );
}

// ---------- fila
console.log('\n== fila automation-event');
try {
  const jobs = await db.$client<{ state: string; count: string }[]>`
    SELECT state, count(*)::text AS count FROM pgboss.job WHERE name = 'automation-event' GROUP BY state`;
  console.log(jobs.length ? jobs.map((j) => `${j.state}=${j.count}`).join(' · ') : 'nenhum job');
  const failed = await db.$client<{ output: unknown }[]>`
    SELECT output FROM pgboss.job WHERE name = 'automation-event' AND state = 'failed' ORDER BY created_on DESC LIMIT 3`;
  for (const f of failed) console.log(`falha: ${JSON.stringify(f.output).slice(0, 240)}`);
} catch (err) {
  console.log(`não li a fila: ${String(err).slice(0, 160)}`);
}
process.exit(0);
