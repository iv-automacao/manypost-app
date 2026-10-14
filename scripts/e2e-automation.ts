import { createHmac } from 'node:crypto';
import { AesGcmCryptoService } from '@manypost/core';
import { channels, createDb, makeAutomationRepository, makeWebhookRepository, organizations } from '@manypost/db';
import postgres from 'postgres';

/**
 * E2E da automação comentário → direct (openspec add-comment-automation), sem rede externa.
 *
 * Sobe uma Zernio falsa, prepara org + canal Instagram + automação ACTIVE + webhook de saída no banco
 * de desenvolvimento, inicia a API de verdade (MODE=all: rota pública, pg-boss, motor) apontada para
 * a Zernio falsa e conduz o fluxo inteiro: comentário → resposta pública + privada → botão → opção →
 * telefone → fim com WhatsApp → `lead.captured` assinado. Também prova que a reentrega do mesmo
 * evento não envia nada de novo e que assinatura errada é recusada. O fluxo v3 prova o atraso por
 * balão (job na fila, "digitando…") e o lembrete único (job antecipado direto no pg-boss).
 *
 *   DATABASE_URL=… REDIS_URL=… bun run scripts/e2e-automation.ts
 */

const API_PORT = 3101;
const FAKE_PORT = 3999;
const API = `http://localhost:${API_PORT}`;
const SECRET = 'e2e-segredo-do-webhook-com-mais-de-32-caracteres';
const IG_USER = `17841${Date.now()}`;
// id fixo por execução: o evento é deduplicado no banco, então o script precisa poder rodar de novo
const COMMENT_EVENT_ID = `e2e-comment-fixo-${Date.now()}`;

let failures = 0;
function check(cond: unknown, msg: string) {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    failures++;
    console.error(`  FALHOU: ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`tempo esgotado esperando: ${what}`);
    await sleep(200);
  }
}

// ---- Zernio falsa + receptor do webhook de saída ----
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
  idem: string | null;
}
const calls: Call[] = [];
const hooks: Array<{ event: string | null; signature: string | null; body: Record<string, unknown> }> = [];
const fake = Bun.serve({
  port: FAKE_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === 'GET' ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
    if (url.pathname === '/hook') {
      hooks.push({ event: req.headers.get('x-manypost-event'), signature: req.headers.get('x-manypost-signature'), body });
      return Response.json({ ok: true });
    }
    calls.push({ method: req.method, path: url.pathname, body, idem: req.headers.get('idempotency-key') });
    if (url.pathname === '/api/v1/accounts') {
      return Response.json({
        accounts: [{ _id: 'zacc', platform: 'instagram', platformUserId: IG_USER, username: 'e2e.conta', isActive: true }],
      });
    }
    if (url.pathname.endsWith('/private-reply')) return Response.json({ status: 'ok', messageId: 'pm-1' });
    if (url.pathname.startsWith('/api/v1/inbox/comments/')) return Response.json({ success: true, data: { commentId: 'pub-1' } });
    if (url.pathname.startsWith('/api/v1/inbox/conversations/')) {
      return Response.json({ success: true, data: { messageId: `m-${calls.length}` } });
    }
    return Response.json({ error: 'não mockado' }, { status: 404 });
  },
});

// ---- banco: org, canal, automação e webhook de saída ----
const db = createDb(process.env.DATABASE_URL ?? '');
const crypto = AesGcmCryptoService.fromHex(process.env.ENCRYPTION_KEY ?? '');
const [org] = await db
  .insert(organizations)
  .values({ name: 'E2E automação', slug: `e2e-auto-${Date.now()}` })
  .returning();
const orgId = org!.id;
const [channel] = await db
  .insert(channels)
  .values({
    orgId,
    provider: 'instagram-standalone',
    externalId: IG_USER,
    name: 'E2E',
    username: 'e2e.conta',
    tokenEnc: new Uint8Array([1]),
    settings: { userId: IG_USER },
  })
  .returning();
const automation = await makeAutomationRepository(db).create({
  orgId,
  channelId: channel!.id,
  name: 'E2E cotação',
  status: 'ACTIVE',
  testUsernames: [],
  createdBy: null,
  config: {
    version: 1,
    trigger: { mediaIds: [], keywords: ['cotação'] },
    publicReplies: ['Te chamei no direct!'],
    opening: { text: 'Oi! Toque abaixo.', mode: 'button', buttonTitle: 'Quero!' },
    questions: [
      { kind: 'choice', field: 'plano', prompt: 'Qual plano?', options: [{ title: 'Saúde' }, { title: 'Vida' }] },
      { kind: 'text', field: 'whatsapp', prompt: 'Seu WhatsApp?', validate: 'phone' },
    ],
    finish: { text: 'Valeu!', whatsapp: { phone: '5592999990000', message: 'Quero {plano}', buttonTitle: 'Falar no WhatsApp' } },
    disclosure: true,
  },
});
// fluxo v2 (canvas) com o gatilho na tabela; a automação v1 acima não tem linha de gatilho
// e por isso também prova a queda para `config.trigger`
const P = { x: 0, y: 0 };
const ed = (source: string, sourceHandle: string, target: string) => ({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });
const automationV2 = await makeAutomationRepository(db).create({
  orgId,
  channelId: channel!.id,
  name: 'E2E canvas',
  status: 'ACTIVE',
  testUsernames: [],
  createdBy: null,
  config: {
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!', mode: 'text', buttonTitle: 'Quero!', disclosure: true } },
      { id: 'tipo', type: 'message', position: P, data: { text: 'Para quem?', format: 'buttons', options: [{ id: 'pf', title: 'Pessoa física' }, { id: 'pj', title: 'Minha empresa' }], saveTo: 'tipo', onTyped: 'reask' } },
      { id: 'info', type: 'message', position: P, data: { text: 'Empresarial tem condições especiais.', format: 'none', options: [], onTyped: 'reask' } },
      { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
      { id: 'c', type: 'condition', position: P, data: { field: 'tipo', op: 'equals', value: 'minha empresa' } },
      { id: 'wa', type: 'link', position: P, data: { text: 'Fale com a gente', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: 'Sou {nome}' } } },
      { id: 'seguir', type: 'link', position: P, data: { text: 'Segue a gente', buttonTitle: 'Seguir', target: { kind: 'url', url: 'https://instagram.com/e2e.conta' } } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Obrigado, {nome}!' } },
    ],
    edges: [ed('opening', 'next', 'tipo'), ed('tipo', 'pf', 'nome'), ed('tipo', 'pj', 'info'), ed('info', 'next', 'nome'), ed('nome', 'next', 'c'), ed('c', 'yes', 'wa'), ed('c', 'no', 'fim'), ed('wa', 'next', 'seguir')],
  },
  triggers: [{ kind: 'comment', config: { mediaIds: [], keywords: ['empresarial'], publicReplies: [] }, position: null }],
});
// fluxo v3 (add-flow-delay-reminder): lembrete em 5 min e balões com atraso depois da cidade
const automationV3 = await makeAutomationRepository(db).create({
  orgId,
  channelId: channel!.id,
  name: 'E2E atraso',
  status: 'ACTIVE',
  testUsernames: [],
  createdBy: null,
  config: {
    version: 2,
    reminder: { afterMinutes: 5, text: 'Ficou faltando pouco.' },
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!', mode: 'quick', buttonTitle: 'Quero ver', disclosure: false } },
      { id: 'cidade', type: 'message', position: P, data: { text: 'Em qual cidade?', format: 'quick', options: [{ id: 'mao', title: 'Manaus' }], saveTo: 'cidade', onTyped: 'reask' } },
      { id: 'wa', type: 'link', position: P, data: { text: 'Fale com a gente', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: '' }, delaySec: 2 } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Valeu!', delaySec: 1 } },
    ],
    edges: [ed('opening', 'next', 'cidade'), ed('cidade', 'mao', 'wa'), ed('wa', 'next', 'fim')],
  },
  triggers: [{ kind: 'comment', config: { mediaIds: [], keywords: ['atraso'], publicReplies: [] }, position: null }],
});
await makeWebhookRepository(db).create({
  orgId,
  name: 'e2e',
  url: `http://localhost:${FAKE_PORT}/hook`,
  events: ['lead.captured'],
  channelIds: [],
  ...(await crypto.encrypt('whsec_e2e', `webhook:${orgId}`).then((e) => ({
    secretEnc: e.ciphertext,
    secretKeyVersion: e.keyVersion,
  }))),
});

// ---- API de verdade apontada para a Zernio falsa ----
const api = Bun.spawn(['bun', 'run', 'apps/api/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(API_PORT),
    MODE: 'all',
    ZERNIO_API_KEY: 'sk_e2e',
    ZERNIO_ORG_IDS: orgId,
    ZERNIO_WEBHOOK_SECRET: SECRET,
    ZERNIO_API_URL: `http://localhost:${FAKE_PORT}/api/v1`,
    WEBHOOKS_ALLOW_PRIVATE: 'true',
  },
  stdout: 'ignore',
  stderr: 'ignore',
});

let seq = 0;
const send = async (event: string, payload: Record<string, unknown>, opts: { id?: string; badSig?: boolean } = {}) => {
  const id = opts.id ?? `e2e-${Date.now()}-${++seq}`;
  const body = JSON.stringify({ id, event, account: { accountId: 'zacc', id: 'zacc' }, ...payload });
  const sig = createHmac('sha256', opts.badSig ? 'outro-segredo' : SECRET).update(body).digest('hex');
  return fetch(`${API}/v1/integrations/zernio/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zernio-signature': sig, 'x-zernio-event': event, 'x-zernio-event-id': id },
    body,
  });
};
const message = (over: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  message: {
    conversationId: 'conv-e2e',
    platform: 'instagram',
    direction: 'incoming',
    text: '',
    sender: { id: 'igsid-e2e', username: 'cliente.e2e' },
    ...over,
  },
  conversation: { id: 'conv-e2e', participantId: 'igsid-e2e' },
  metadata,
});
const runRow = () =>
  db.query.automationRuns.findFirst({ where: (r, { eq }) => eq(r.automationId, automation.id) });
const sends = () => calls.filter((c) => c.path === '/api/v1/inbox/conversations/conv-e2e/messages');

try {
  await until(async () => (await fetch(`${API}/health`).catch(() => null))?.ok, 'API no ar', 60_000);
  console.log('webhook');
  check((await send('comment.received', {}, { badSig: true })).status === 401, 'assinatura errada → 401');

  console.log('comentário');
  const commentEvent = {
    comment: {
      id: 'c-e2e-1',
      platformPostId: '1801',
      platform: 'instagram',
      text: 'Quero uma COTACAO',
      author: { id: 'igsid-e2e', username: 'cliente.e2e', isOwnAccount: false },
      isReply: false,
      parentCommentId: null,
    },
  };
  const first = await send('comment.received', commentEvent, { id: COMMENT_EVENT_ID });
  check(first.status === 200, 'evento assinado → 200');
  const pr = await until(() => calls.find((c) => c.path.endsWith('/c-e2e-1/private-reply')), 'resposta privada');
  const pub = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/inbox/comments/1801');
  check(pub?.body.message === 'Te chamei no direct!' && pub?.body.commentId === 'c-e2e-1', 'resposta pública no comentário');
  const prButtons = pr.body.buttons as Array<{ payload: string }>;
  check(String(pr.body.message).endsWith('Mensagem automática.'), 'abertura com aviso de automação');
  const run = await until(runRow, 'execução gravada');
  check(prButtons?.[0]?.payload === `mp2:${run.id}:opening:next`, 'botão da abertura carrega o id da execução');

  const before = calls.length;
  await send('comment.received', commentEvent, { id: COMMENT_EVENT_ID });
  await send('comment.received', commentEvent);
  await sleep(1500);
  check(calls.filter((c) => c.method !== 'GET').length === calls.slice(0, before).filter((c) => c.method !== 'GET').length, 'reentrega e evento repetido não enviam nada');

  console.log('direct');
  await send('message.received', message({ text: 'Quero!' }, { postbackPayload: `mp2:${run.id}:opening:next` }));
  const q1 = await until(() => sends()[0], 'pergunta 1');
  check(q1.idem === `${run.id}:c1:0`, 'pergunta enviada com Idempotency-Key');
  check(JSON.stringify(q1.body.buttons).includes('Saúde'), 'opções como botões');

  await send('message.received', message({ text: 'Vida' }, { postbackPayload: `mp2:${run.id}:q0:o1` }));
  await until(() => sends()[1], 'pergunta 2');
  await send('message.received', message({ text: 'não sei' }));
  const reask = await until(() => sends()[2], 're-pergunta');
  check(reask.idem === `${run.id}:c2:1`, 'telefone inválido re-pergunta com chave nova');
  await send('message.received', message({ text: '(92) 98888-7777' }));
  const fim = await until(() => sends()[3], 'mensagem final');
  check(
    JSON.stringify(fim.body.buttons).includes(encodeURIComponent('Quero Vida')),
    'fim com botão do WhatsApp preenchido com a resposta',
  );

  const done = await until(async () => {
    const r = await runRow();
    return r?.status === 'COMPLETED' && r.leadEmittedAt ? r : null;
  }, 'execução completa');
  check(
    JSON.stringify(done.answers) === JSON.stringify({ plano: 'Vida', whatsapp: '92988887777' }),
    'respostas gravadas',
  );
  // pelo runId: num banco reaproveitado chegam entregas atrasadas de execuções anteriores do script
  const hook = await until(
    () => hooks.find((h) => h.event === 'lead.captured' && (h.body.data as { runId?: string })?.runId === run.id),
    'webhook lead.captured',
    30_000,
  );
  check(hook.signature?.startsWith('t=') && hook.signature.includes(',v1='), 'lead.captured assinado');
  check((hook.body.data as { runId?: string })?.runId === run.id, 'lead.captured com o runId');

  console.log('fluxo v2 (canvas)');
  const message2 = (over: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    message: { conversationId: 'conv-e2e-2', platform: 'instagram', direction: 'incoming', text: '', sender: { id: 'igsid-e2e-2', username: 'empresa.e2e' }, ...over },
    conversation: { id: 'conv-e2e-2', participantId: 'igsid-e2e-2' },
    metadata,
  });
  const sends2 = () => calls.filter((c) => c.path === '/api/v1/inbox/conversations/conv-e2e-2/messages');
  await send('comment.received', {
    comment: { id: 'c-e2e-2', platformPostId: '1802', platform: 'instagram', text: 'plano EMPRESARIAL', author: { id: 'igsid-e2e-2', username: 'empresa.e2e', isOwnAccount: false }, isReply: false, parentCommentId: null },
  });
  const pr2 = await until(() => calls.find((c) => c.path.endsWith('/c-e2e-2/private-reply')), 'resposta privada v2');
  check(!pr2.body.buttons && String(pr2.body.message).includes('Responda esta mensagem para continuar.'), 'abertura v2 em texto, sem botão');
  const run2 = await until(() => db.query.automationRuns.findFirst({ where: (r, { eq }) => eq(r.automationId, automationV2.id) }), 'execução v2');
  await send('message.received', message2({ text: 'oi' }));
  await until(() => sends2()[0], 'botões v2');
  await send('message.received', message2({ text: 'Minha empresa' }, { postbackPayload: `mp2:${run2.id}:tipo:pj` }));
  await until(() => sends2()[2], 'info + nome');
  check(sends2()[1]?.body.message === 'Empresarial tem condições especiais.' && sends2()[2]?.body.message === 'Seu nome?', 'mensagens encadeadas no mesmo evento');
  await send('message.received', message2({ text: 'Ana' }));
  await until(() => sends2()[4], 'WhatsApp + seguir');
  check(JSON.stringify(sends2()[3]?.body.buttons).includes(encodeURIComponent('Sou Ana')), 'link do WhatsApp preenchido');
  check(JSON.stringify(sends2()[4]?.body.buttons).includes('instagram.com/e2e.conta'), 'pedir para seguir depois do WhatsApp');
  const done2 = await until(async () => {
    const r = await db.query.automationRuns.findFirst({ where: (x, { eq }) => eq(x.automationId, automationV2.id) });
    return r?.status === 'COMPLETED' && r.leadEmittedAt ? r : null;
  }, 'execução v2 completa');
  // jsonb não preserva a ordem das chaves: compara os campos
  const ans2 = done2.answers as Record<string, string>;
  check(Object.keys(ans2).length === 2 && ans2.tipo === 'Minha empresa' && ans2.nome === 'Ana', 'respostas v2 gravadas');
  await until(() => hooks.find((h) => (h.body.data as { runId?: string })?.runId === run2.id), 'lead.captured v2', 30_000);

  console.log('fluxo v3 (atraso e lembrete)');
  const pg = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
  try {
    const message3 = (over: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
      message: { conversationId: 'conv-e2e-3', platform: 'instagram', direction: 'incoming', text: '', sender: { id: 'igsid-e2e-3', username: 'atraso.e2e' }, ...over },
      conversation: { id: 'conv-e2e-3', participantId: 'igsid-e2e-3' },
      metadata,
    });
    const sends3 = () => calls.filter((c) => c.path === '/api/v1/inbox/conversations/conv-e2e-3/messages');
    await send('comment.received', {
      comment: { id: 'c-e2e-3', platformPostId: '1803', platform: 'instagram', text: 'quero ATRASO', author: { id: 'igsid-e2e-3', username: 'atraso.e2e', isOwnAccount: false }, isReply: false, parentCommentId: null },
    });
    const pr3 = await until(() => calls.find((c) => c.path.endsWith('/c-e2e-3/private-reply')), 'resposta privada v3');
    check((pr3.body.quickReplies as Array<{ title: string }>)?.[0]?.title === 'Quero ver' && !pr3.body.buttons, 'abertura com resposta rápida');
    const run3 = await until(() => db.query.automationRuns.findFirst({ where: (r, { eq }) => eq(r.automationId, automationV3.id) }), 'execução v3');
    await send('message.received', message3({ text: 'Quero ver' }, { quickReplyPayload: `mp2:${run3.id}:opening:next` }));
    const cidade = await until(() => sends3()[0], 'pergunta da cidade');
    check(cidade.body.message === 'Em qual cidade?', 'pergunta da cidade enviada');

    // lembrete: o job fica na fila para daqui a 5 min; antecipa direto no pg-boss
    const job = await until(async () => {
      const rows = await pg`SELECT id, start_after FROM pgboss.job WHERE name = 'automation-event' AND data->>'timer' = 'reminder' AND data->>'runId' = ${run3.id} AND state = 'created'`;
      return rows[0];
    }, 'job do lembrete');
    const mins = (new Date(job.start_after as string).getTime() - Date.now()) / 60_000;
    check(mins > 4 && mins <= 5.1, 'lembrete agendado para ~5 min depois da resposta');
    // simula os 5 min: a última mensagem da pessoa "fica" 5 min no passado e o job vence agora
    await pg`UPDATE automation_runs SET last_inbound_at = now() - interval '5 minutes' WHERE id = ${run3.id}`;
    await pg`UPDATE pgboss.job SET start_after = now() WHERE id = ${job.id as string}`;
    const rem = await until(() => sends3().find((c) => c.idem === `${run3.id}:rem1`), 'lembrete enviado', 30_000);
    check(rem.body.message === 'Ficou faltando pouco.' && !rem.body.quickReplies, 'lembrete com o texto sozinho');
    const remQ = await until(() => sends3().find((c) => c.idem === `${run3.id}:rem1:q`), 'pergunta repetida');
    check(remQ.body.message === 'Em qual cidade?' && (remQ.body.quickReplies as Array<{ title: string }>)?.[0]?.title === 'Manaus', 'pergunta repetida com as opções');

    // atraso: o link do WhatsApp sai ~2 s depois da resposta, com "digitando…" antes
    const t0 = Date.now();
    await send('message.received', message3({ text: 'Manaus' }, { quickReplyPayload: `mp2:${run3.id}:cidade:mao` }));
    await until(() => calls.find((c) => c.path === '/api/v1/inbox/conversations/conv-e2e-3/typing'), 'digitando');
    await sleep(800);
    check(!sends3().some((c) => c.body.message === 'Fale com a gente'), 'link ainda não saiu durante a espera');
    const wa = await until(() => sends3().find((c) => c.body.message === 'Fale com a gente'), 'link depois da espera', 30_000);
    check(Date.now() - t0 >= 2000 && wa.idem === `${run3.id}:c2:0`, 'link saiu depois de 2 s com a chave do nó');
    const done3 = await until(async () => {
      const r = await db.query.automationRuns.findFirst({ where: (x, { eq }) => eq(x.automationId, automationV3.id) });
      return r?.status === 'COMPLETED' && r.leadEmittedAt ? r : null;
    }, 'execução v3 completa', 30_000);
    check(sends3().filter((c) => c.body.message === 'Valeu!').length === 1 && done3.reminderSentAt !== null, 'fim enviado uma vez e lembrete registrado');
    check(sends3().filter((c) => c.body.message === 'Fale com a gente').length === 1, 'link enviado uma vez');
  } finally {
    await pg.end();
  }
} catch (e) {
  failures++;
  console.error(`  FALHOU: ${(e as Error).message}`);
} finally {
  api.kill();
  fake.stop(true);
}

console.log(failures ? `\n${failures} falha(s)` : '\nE2E da automação ok');
process.exit(failures ? 1 : 0);
