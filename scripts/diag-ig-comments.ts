/**
 * Diagnóstico operacional: por que `/{media}/comments` volta vazio num canal `instagram-standalone`
 * que conta comentários (change add-instagram-engagement, verificação em produção 2026-10-12).
 *
 * Roda DENTRO do container da aplicação (precisa de DATABASE_URL e ENCRYPTION_KEY do ambiente):
 *
 *   bun run scripts/diag-ig-comments.ts <channelId> [mediaId]
 *
 * Só imprime status HTTP, quantidade de itens, presença de paginação e a mensagem/código de erro
 * da Meta. Nunca imprime o token, nem texto ou autor de comentário (dado de terceiros).
 */
import { AesGcmCryptoService, channelAad } from '@manypost/core';
import { createDb } from '@manypost/db';

const [channelId, mediaArg] = process.argv.slice(2);
if (!channelId) {
  console.error('uso: bun run scripts/diag-ig-comments.ts <channelId> [mediaId]');
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL ?? '');
const crypto = AesGcmCryptoService.fromHex(process.env.ENCRYPTION_KEY ?? '');

// API relacional: os operadores vêm no callback (nada de importar drizzle-orm fora do pacote db)
const row = await db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, channelId) });
if (!row) throw new Error('canal não encontrado');
if (row.provider !== 'instagram-standalone') throw new Error(`provider ${row.provider} fora do escopo`);

const token = await crypto.decrypt(
  row.tokenEnc,
  channelAad(row.orgId, row.provider, row.externalId),
  row.tokenKeyVersion,
);
const userId = (row.settings as { userId?: string } | null)?.userId ?? 'me';
console.log(`canal ok · status=${row.status} · escopos=${row.scopes.join(',')} · userId=${userId === 'me' ? 'me' : 'definido'}`);

/** chama a Graph e resume a resposta sem dado sensível */
async function probe(label: string, url: string) {
  const u = new URL(url);
  u.searchParams.set('access_token', token);
  const res = await fetch(u);
  const body = (await res.json().catch(() => ({}))) as {
    data?: unknown[];
    paging?: unknown;
    error?: { message?: string; code?: number; error_subcode?: number };
    comments_count?: number;
    comments?: { data?: unknown[] };
  };
  const summary = body.error
    ? `ERRO code=${body.error.code}${body.error.error_subcode ? `/${body.error.error_subcode}` : ''} "${body.error.message}"`
    : Array.isArray(body.data)
      ? `data=${body.data.length} paging=${body.paging ? 'sim' : 'não'}`
      : `campos=${Object.keys(body).join(',')}${body.comments ? ` comments.data=${body.comments.data?.length ?? 0}` : ''}${typeof body.comments_count === 'number' ? ` comments_count=${body.comments_count}` : ''}`;
  console.log(`${label.padEnd(34)} HTTP ${res.status} · ${summary}`);
  return body;
}

const V21 = 'https://graph.instagram.com/v21.0';
const V25 = 'https://graph.instagram.com/v25.0';
const RAW = 'https://graph.instagram.com';

await probe('me', `${V21}/me?fields=user_id,username,account_type`);

let mediaId = mediaArg;
if (!mediaId) {
  const media = (await probe('media (5 recentes)', `${V21}/${userId}/media?fields=id,comments_count&limit=25`)) as {
    data?: Array<{ id: string; comments_count?: number }>;
  };
  mediaId = media.data?.find((m) => (m.comments_count ?? 0) > 0)?.id;
  if (!mediaId) throw new Error('nenhum post recente com comentários');
}
console.log(`post testado: ${mediaId}`);

const FULL = 'id,text,timestamp,like_count,hidden,username,from{id,username}';
await probe('post: comments_count', `${V21}/${mediaId}?fields=comments_count,media_product_type`);
await probe('comments sem fields (v21)', `${V21}/${mediaId}/comments`);
await probe('comments id,text (v21)', `${V21}/${mediaId}/comments?fields=id,text,timestamp`);
await probe('comments + username (v21)', `${V21}/${mediaId}/comments?fields=id,username`);
await probe('comments + from (v21)', `${V21}/${mediaId}/comments?fields=id,from{id,username}`);
await probe('comments + hidden (v21)', `${V21}/${mediaId}/comments?fields=id,hidden`);
await probe('comments campos do app (v21)', `${V21}/${mediaId}/comments?fields=${FULL},replies{${FULL}}`);
await probe('comments sem fields (v25)', `${V25}/${mediaId}/comments`);
await probe('comments sem versão', `${RAW}/${mediaId}/comments`);
await probe('post: comments{id} (v21)', `${V21}/${mediaId}?fields=comments{id}`);

process.exit(0);
