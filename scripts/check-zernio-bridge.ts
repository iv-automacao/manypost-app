/**
 * Checagem operacional da ponte de comentários pela Zernio (change add-zernio-comment-bridge).
 *
 * Roda DENTRO do container (precisa de DATABASE_URL, ENCRYPTION_KEY e, para testar a ponte,
 * ZERNIO_API_KEY/ZERNIO_ORG_IDS):
 *
 *   bun run scripts/check-zernio-bridge.ts <channelId>
 *
 * Mostra o id da organização do canal (o valor de ZERNIO_ORG_IDS), se a ponte está ligada para ele,
 * se a chave da Zernio enxerga a conta e quantos comentários a ponte devolve no post mais recente
 * com comentários. Nunca imprime chave, token, texto ou autor de comentário.
 */
import { AesGcmCryptoService, channelAad } from '@manypost/core';
import { createDb } from '@manypost/db';
import { makeZernioBridge } from '@manypost/providers';

const [channelId] = process.argv.slice(2);
if (!channelId) {
  console.error('uso: bun run scripts/check-zernio-bridge.ts <channelId>');
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL ?? '');
const row = await db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, channelId) });
if (!row) throw new Error('canal não encontrado');

console.log(`canal ok · provider=${row.provider} · status=${row.status}`);
console.log(`orgId (use em ZERNIO_ORG_IDS): ${row.orgId}`);

const key = process.env.ZERNIO_API_KEY;
const orgs = (process.env.ZERNIO_ORG_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
console.log(`ZERNIO_API_KEY ${key ? 'definida' : 'AUSENTE'} · org ${orgs.includes(row.orgId) ? 'na' : 'FORA da'} ZERNIO_ORG_IDS`);
if (!key) process.exit(0);

const userId = (row.settings as { userId?: string } | null)?.userId;
const bridge = makeZernioBridge({
  apiKey: key,
  fetch: globalThis.fetch,
  log: (level, msg, data) => console.log(`[${level}] ${msg} ${JSON.stringify(data ?? {})}`),
});
const t = await bridge.forAccount({
  platformUserId: userId || row.externalId,
  ...(row.username ? { username: row.username } : {}),
});
if (!t) {
  console.log('a chave da Zernio NÃO enxerga esta conta do Instagram (ou a Zernio recusou a chave)');
  process.exit(0);
}
console.log('a chave da Zernio enxerga a conta ✓');

// post mais recente com comentários, pela Graph própria (que lista posts normalmente)
const crypto = AesGcmCryptoService.fromHex(process.env.ENCRYPTION_KEY ?? '');
const token = await crypto.decrypt(row.tokenEnc, channelAad(row.orgId, row.provider, row.externalId), row.tokenKeyVersion);
const u = new URL(`https://graph.instagram.com/v21.0/${userId || 'me'}/media`);
u.searchParams.set('fields', 'id,comments_count');
u.searchParams.set('limit', '25');
u.searchParams.set('access_token', token);
const media = (await (await fetch(u)).json()) as { data?: Array<{ id: string; comments_count?: number }> };
const post = media.data?.find((m) => (m.comments_count ?? 0) > 0);
if (!post) {
  console.log('nenhum post recente com comentários para testar');
  process.exit(0);
}
try {
  const page = await t.listComments(post.id, { limit: 25 });
  const replies = page.items.reduce((n, c) => n + c.replies.length, 0);
  console.log(
    `post ${post.id}: Meta conta ${post.comments_count} · ponte devolveu ${page.items.length} comentários + ${replies} respostas`,
  );
} catch (e) {
  const f = e as { status?: number; body?: string };
  console.log(`ponte falhou · HTTP ${f.status ?? '?'} · ${f.body ?? String(e)}`);
}
process.exit(0);
