import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Container } from '../../container';
import type { AppEnv } from '../middleware/context';
import { requireAuth } from '../middleware/auth';
import { idempotency } from '../middleware/public-api';
import { AUTH_SECURITY, createApp, errorResponses, jsonBody, jsonResponse } from '../openapi';

/**
 * Comentários e métricas de um canal (change add-instagram-engagement) — montado em
 * `/v1/channels`, ao lado do router de conexão. A rota só adapta HTTP: escopo, status do canal,
 * classificação de falha e auditoria vivem no caso de uso (`makeEngagement`).
 *
 * Ids de mídia/comentário entram no PATH da Graph da Meta, então só passam se forem numéricos —
 * `../me` ou `1?fields=` morrem aqui, antes de qualquer decifragem de token.
 */

const ExternalId = z.string().regex(/^\d{1,32}$/, 'id da rede inválido');
const ChannelParam = z.object({ id: z.string().uuid() });
const MediaParams = ChannelParam.extend({ mediaId: ExternalId });
const CommentParams = ChannelParam.extend({ commentId: ExternalId });

const PageQuery = z.object({
  cursor: z.string().max(512).optional().openapi({ description: 'cursor opaco devolvido em `nextCursor`' }),
});
const InsightsQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(30)
    .default(28)
    .openapi({ description: 'janela até agora, em dias (a Graph aceita no máximo 30)' }),
});

const ReplyBody = z.object({ message: z.string().min(1).max(2200) });
const VisibilityBody = z.object({ hidden: z.boolean() });

const MetricValues = z
  .record(z.number().nullable())
  .openapi({ description: '`null` = a rede não devolveu essa métrica (nunca inventamos zero)' });

const Media = z
  .object({
    id: z.string(),
    mediaType: z.string().openapi({ example: 'CAROUSEL_ALBUM' }),
    productType: z.string().optional().openapi({ example: 'REELS' }),
    caption: z.string().optional(),
    permalink: z.string().optional(),
    previewUrl: z.string().optional().openapi({ description: 'URL temporária da rede — não guardar' }),
    timestamp: z.string(),
    likeCount: z.number().optional(),
    commentsCount: z.number().optional(),
  })
  .openapi('EngagementMedia');

const CommentBase = z.object({
  id: z.string(),
  text: z.string(),
  username: z.string().optional(),
  timestamp: z.string(),
  likeCount: z.number().optional(),
  hidden: z.boolean(),
  fromOwner: z.boolean().openapi({ description: 'escrito pela própria conta conectada' }),
});
// a rede só tem um nível de resposta: `replies` de uma resposta vem sempre vazio
const Reply = CommentBase.extend({
  replies: z.array(z.object({})).max(0).openapi({ description: 'sempre vazio' }),
}).openapi('EngagementReply');
const Comment = CommentBase.extend({ replies: z.array(Reply) }).openapi('EngagementComment');

const page = <T extends z.ZodTypeAny>(item: T, name: string) =>
  z.object({ items: z.array(item), nextCursor: z.string().optional() }).openapi(name);

const AccountInsights = z
  .object({
    since: z.string(),
    until: z.string(),
    totals: MetricValues,
    followersCount: z.number().nullable(),
    mediaCount: z.number().nullable(),
    dailyReach: z.array(z.object({ date: z.string(), value: z.number() })),
  })
  .openapi('AccountInsights');

const MediaWithInsights = z
  .object({ media: Media, metrics: MetricValues, unavailableReason: z.string().optional() })
  .openapi('MediaWithInsights');

const ENGAGEMENT_ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 502);

/** IP do cliente para a auditoria — o primeiro do x-forwarded-for (proxy da plataforma) */
const clientIp = (c: Context<AppEnv>) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;

export function engagementRoutes(ctn: Container) {
  const app = createApp();
  app.use('*', requireAuth({ authenticateHuman: ctn.auth.authenticateHuman }));

  const actorOf = (c: Context<AppEnv>) => {
    const p = c.get('principal');
    return {
      type: p.kind === 'api_key' ? ('API_KEY' as const) : ('USER' as const),
      id: p.userId ?? p.apiKeyId ?? null,
      ip: clientIp(c),
    };
  };
  const target = (c: Context<AppEnv>, id: string) => ({ orgId: c.get('principal').orgId, channelId: id });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/{id}/media',
    tags: ['engagement'],
    security: AUTH_SECURITY,
    summary: 'Posts recentes da conta conectada (inclui os que não saíram pelo manypost)',
    request: { params: ChannelParam, query: PageQuery },
    responses: { 200: jsonResponse('página de posts', page(Media, 'EngagementMediaPage')), ...ENGAGEMENT_ERRORS },
  });
  app.get('/:id/media', async (c) => {
    const { id } = ChannelParam.parse(c.req.param());
    const { cursor } = PageQuery.parse(c.req.query());
    return c.json(await ctn.engagement.listMedia({ ...target(c, id), ...(cursor ? { cursor } : {}), limit: 12 }));
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/{id}/media/{mediaId}/comments',
    tags: ['engagement'],
    security: AUTH_SECURITY,
    summary: 'Comentários de um post, com as respostas',
    request: { params: MediaParams, query: PageQuery },
    responses: {
      200: jsonResponse('página de comentários', page(Comment, 'EngagementCommentPage')),
      ...ENGAGEMENT_ERRORS,
    },
  });
  app.get('/:id/media/:mediaId/comments', async (c) => {
    const { id, mediaId } = MediaParams.parse(c.req.param());
    const { cursor } = PageQuery.parse(c.req.query());
    return c.json(
      await ctn.engagement.listComments({ ...target(c, id), mediaId, ...(cursor ? { cursor } : {}) }),
    );
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/{id}/comments/{commentId}/replies',
    tags: ['engagement'],
    security: AUTH_SECURITY,
    summary: 'Responde um comentário publicamente',
    description:
      'Aceita `Idempotency-Key`: a mesma chave devolve a primeira resposta em vez de responder de novo. ' +
      'Falha de transporte depois do envio volta como `channel.provider_failed` com `extra.uncertain=true` ' +
      '— confira os comentários antes de repetir.',
    request: { params: CommentParams, ...jsonBody(ReplyBody) },
    responses: { 201: jsonResponse('resposta publicada', z.object({ id: z.string() })), ...ENGAGEMENT_ERRORS },
  });
  app.post('/:id/comments/:commentId/replies', idempotency(ctn.runtime.idempotency), async (c) => {
    const { id, commentId } = CommentParams.parse(c.req.param());
    const { message } = ReplyBody.parse(await c.req.json());
    const out = await ctn.engagement.reply({ ...target(c, id), commentId, message, actor: actorOf(c) });
    return c.json(out, 201);
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/{id}/comments/{commentId}/visibility',
    tags: ['engagement'],
    security: AUTH_SECURITY,
    summary: 'Oculta ou reexibe um comentário',
    request: { params: CommentParams, ...jsonBody(VisibilityBody) },
    responses: { 204: { description: 'aplicado (idempotente)' }, ...ENGAGEMENT_ERRORS },
  });
  app.post('/:id/comments/:commentId/visibility', idempotency(ctn.runtime.idempotency), async (c) => {
    const { id, commentId } = CommentParams.parse(c.req.param());
    const { hidden } = VisibilityBody.parse(await c.req.json());
    await ctn.engagement.setHidden({ ...target(c, id), commentId, hidden, actor: actorOf(c) });
    return c.body(null, 204);
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/{id}/insights',
    tags: ['engagement'],
    security: AUTH_SECURITY,
    summary: 'Métricas da conta no período (até 30 dias)',
    description: 'A rede pode atrasar os dados em até 48 h. Métrica que a rede recusar volta `null`.',
    request: { params: ChannelParam, query: InsightsQuery },
    responses: { 200: jsonResponse('métricas da conta', AccountInsights), ...ENGAGEMENT_ERRORS },
  });
  app.get('/:id/insights', async (c) => {
    const { id } = ChannelParam.parse(c.req.param());
    const { days } = InsightsQuery.parse(c.req.query());
    return c.json(await ctn.engagement.accountInsights({ ...target(c, id), days }));
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/{id}/insights/media',
    tags: ['engagement'],
    security: AUTH_SECURITY,
    summary: 'Métricas vitalícias dos posts recentes',
    description: 'Post que a rede recusar volta com métricas `null` e `unavailableReason`, sem derrubar a página.',
    request: { params: ChannelParam, query: PageQuery },
    responses: {
      200: jsonResponse('posts com métricas', page(MediaWithInsights, 'MediaInsightsPage')),
      ...ENGAGEMENT_ERRORS,
    },
  });
  app.get('/:id/insights/media', async (c) => {
    const { id } = ChannelParam.parse(c.req.param());
    const { cursor } = PageQuery.parse(c.req.query());
    return c.json(
      await ctn.engagement.mediaInsights({ ...target(c, id), ...(cursor ? { cursor } : {}), limit: 12 }),
    );
  });

  return app;
}
