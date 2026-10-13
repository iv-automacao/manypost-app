import { createHmac } from 'node:crypto';
import { AesGcmCryptoService } from '@manypost/core';
import { channels, createDb, makeAutomationRepository, makeWebhookRepository, organizations } from '@manypost/db';

/**
 * E2E da automação comentário → direct (openspec add-comment-automation), sem rede externa.
 *
 * Sobe uma Zernio falsa, prepara org + canal Instagram + automação ACTIVE + webhook de saída no banco
 * de desenvolvimento, inicia a API de verdade (MODE=all: rota pública, pg-boss, motor) apontada para
 * a Zernio falsa e conduz o fluxo inteiro: comentário → resposta pública + privada → botão → opção →
 * telefone → fim com WhatsApp → `lead.captured` assinado. Também prova que a reentrega do mesmo
 * evento não envia nada de novo e que assinatura errada é recusada.
 *
 *   DATABASE_URL=… REDIS_URL=… bun run scripts/e2e-automation.ts
 */

const API_PORT = 3101;
const FAKE_PORT = 3999;
const API = `http://localhost:${API_PORT}`;
const SECRET = 'e2e-segredo-do-webhook-com-mais-de-32-caracteres';
const IG_USER = `17841${Date.now()}`;

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
  const first = await send('comment.received', commentEvent, { id: 'e2e-comment-fixo' });
  check(first.status === 200, 'evento assinado → 200');
  const pr = await until(() => calls.find((c) => c.path.endsWith('/c-e2e-1/private-reply')), 'resposta privada');
  const pub = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/inbox/comments/1801');
  check(pub?.body.message === 'Te chamei no direct!' && pub?.body.commentId === 'c-e2e-1', 'resposta pública no comentário');
  const prButtons = pr.body.buttons as Array<{ payload: string }>;
  check(String(pr.body.message).endsWith('Mensagem automática.'), 'abertura com aviso de automação');
  const run = await until(runRow, 'execução gravada');
  check(prButtons?.[0]?.payload === `mp1:${run.id}:o:0`, 'botão da abertura carrega o id da execução');

  const before = calls.length;
  await send('comment.received', commentEvent, { id: 'e2e-comment-fixo' });
  await send('comment.received', commentEvent);
  await sleep(1500);
  check(calls.filter((c) => c.method !== 'GET').length === calls.slice(0, before).filter((c) => c.method !== 'GET').length, 'reentrega e evento repetido não enviam nada');

  console.log('direct');
  await send('message.received', message({ text: 'Quero!' }, { postbackPayload: `mp1:${run.id}:o:0` }));
  const q1 = await until(() => sends()[0], 'pergunta 1');
  check(q1.idem === `${run.id}:0:0`, 'pergunta enviada com Idempotency-Key');
  check(JSON.stringify(q1.body.buttons).includes('Saúde'), 'opções como botões');

  await send('message.received', message({ text: 'Vida' }, { postbackPayload: `mp1:${run.id}:0:1` }));
  await until(() => sends()[1], 'pergunta 2');
  await send('message.received', message({ text: 'não sei' }));
  const reask = await until(() => sends()[2], 're-pergunta');
  check(reask.idem === `${run.id}:1:1`, 'telefone inválido re-pergunta com chave nova');
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
  const hook = await until(() => hooks.find((h) => h.event === 'lead.captured'), 'webhook lead.captured', 30_000);
  check(hook.signature?.startsWith('t=') && hook.signature.includes(',v1='), 'lead.captured assinado');
  check((hook.body.data as { runId?: string })?.runId === run.id, 'lead.captured com o runId');
} catch (e) {
  failures++;
  console.error(`  FALHOU: ${(e as Error).message}`);
} finally {
  api.kill();
  fake.stop(true);
}

console.log(failures ? `\n${failures} falha(s)` : '\nE2E da automação ok');
process.exit(failures ? 1 : 0);
