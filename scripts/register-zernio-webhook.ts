/**
 * Registra (ou atualiza) na Zernio o webhook da automação comentário → direct
 * (change add-comment-automation, design "Migration Plan").
 *
 * Roda DENTRO do container (precisa de DATABASE_URL, ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET e
 * API_PUBLIC_URL/PUBLIC_URL — ou `--url` com a URL pública da API):
 *
 *   bun run scripts/register-zernio-webhook.ts <channelId> [--url https://post.exemplo.com]
 *
 * O webhook fica filtrado pela conta do Instagram do canal (`accountIds`) e assina com o mesmo
 * segredo do ambiente. Antes de terminar, manda um evento de teste assinado para a própria rota e
 * confere a resposta. Nunca imprime a chave nem o segredo.
 */
import { createHmac } from 'node:crypto';
import { createDb } from '@manypost/db';

const args = process.argv.slice(2);
const channelId = args.find((a) => !a.startsWith('--'));
const urlFlag = args.indexOf('--url');
// a API pode ter host próprio (API_PUBLIC_URL); sem ele, é o mesmo do app (PUBLIC_URL)
const base = (urlFlag >= 0 ? args[urlFlag + 1] : (process.env.API_PUBLIC_URL ?? process.env.PUBLIC_URL))?.replace(/\/+$/, '');
if (!channelId || !base) {
  console.error('uso: bun run scripts/register-zernio-webhook.ts <channelId> [--url https://...]');
  process.exit(1);
}
const key = process.env.ZERNIO_API_KEY;
const secret = process.env.ZERNIO_WEBHOOK_SECRET;
if (!key || !secret) {
  console.error('defina ZERNIO_API_KEY e ZERNIO_WEBHOOK_SECRET no ambiente do serviço');
  process.exit(1);
}

const API = 'https://zernio.com/api/v1';
const zernio = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`zernio ${method} ${path} → HTTP ${res.status}: ${String(json.error ?? '')}`);
  return json;
};

const db = createDb(process.env.DATABASE_URL ?? '');
const row = await db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, channelId) });
if (!row) throw new Error('canal não encontrado');
const userId = (row.settings as { userId?: string } | null)?.userId || row.externalId;

const { accounts = [] } = (await zernio('GET', '/accounts?platform=instagram')) as {
  accounts?: Array<{ _id: string; platformUserId?: string; username?: string }>;
};
const account =
  accounts.find((a) => a.platformUserId === userId) ??
  accounts.find((a) => row.username && a.username?.toLowerCase() === row.username.toLowerCase());
if (!account) throw new Error('a chave da Zernio não enxerga a conta do Instagram deste canal');
console.log(`conta na Zernio: ${account._id} (@${account.username ?? '?'})`);

const url = `${base}/v1/integrations/zernio/webhook`;
const events = ['comment.received', 'message.received'];
const { webhooks = [] } = (await zernio('GET', '/webhooks/settings')) as {
  webhooks?: Array<{ _id: string; url: string }>;
};
const existing = webhooks.find((w) => w.url === url);
if (existing) {
  await zernio('PUT', '/webhooks/settings', {
    webhookId: existing._id,
    url,
    secret,
    events,
    accountIds: [account._id],
    isActive: true,
  });
  console.log(`webhook atualizado: ${existing._id} → ${url}`);
} else {
  const created = (await zernio('POST', '/webhooks/settings', {
    name: 'manypost — automação',
    url,
    secret,
    events,
    accountIds: [account._id],
    isActive: true,
  })) as { webhook?: { _id?: string }; _id?: string };
  console.log(`webhook criado: ${created.webhook?._id ?? created._id ?? '?'} → ${url}`);
}

// prova de ponta a ponta: evento de teste assinado com o segredo do ambiente
const body = JSON.stringify({ id: `selftest-${Date.now()}`, event: 'webhook.test' });
const sig = createHmac('sha256', secret).update(body).digest('hex');
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-zernio-signature': sig, 'x-zernio-event': 'webhook.test' },
  body,
});
console.log(
  res.ok
    ? `rota respondeu ${res.status} ✓ (assinatura conferida pelo manypost)`
    : `rota respondeu ${res.status} ✗ — confira se a API está no ar com ZERNIO_WEBHOOK_SECRET e a ponte ligadas`,
);
process.exit(res.ok ? 0 : 1);
