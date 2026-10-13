import { z } from '@hono/zod-openapi';
import {
  AutomationRunStatuses,
  AutomationStatuses,
  CommentAutomationConfigSchema,
} from '@manypost/contracts';
import type { Context } from 'hono';
import type { Container } from '../../container';
import type { AppEnv } from '../middleware/context';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { AUTH_SECURITY, createApp, errorResponses, jsonBody, jsonResponse } from '../openapi';

/**
 * Automação comentário → direct (openspec add-comment-automation) — montado em `/v1/automations`.
 * A rota só adapta HTTP: escopo por org, validação da configuração e auditoria vivem no caso de uso.
 * Mudar status (inclusive ativar) e apagar exigem ADMIN/OWNER: ativar faz a marca falar sozinha.
 */

const IdParam = z.object({ id: z.string().uuid() });
const Config = CommentAutomationConfigSchema.openapi?.('CommentAutomationConfig') ?? CommentAutomationConfigSchema;

const CreateBody = z.object({
  channelId: z.string().uuid(),
  name: z.string().min(1).max(80),
  config: Config,
  testUsernames: z.array(z.string().max(31)).max(10).optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  config: Config.optional(),
  testUsernames: z.array(z.string().max(31)).max(10).optional(),
});
const StatusBody = z.object({ status: z.enum(AutomationStatuses) });
const ListQuery = z.object({ channelId: z.string().uuid().optional() });
const LeadsQuery = z.object({
  automationId: z.string().uuid().optional(),
  status: z.enum(AutomationRunStatuses).optional(),
  cursor: z.string().uuid().optional(),
});

const Automation = z
  .object({
    id: z.string(),
    channelId: z.string(),
    name: z.string(),
    status: z.enum(AutomationStatuses),
    config: Config.nullable().openapi({ description: '`null` = configuração gravada não passa mais na validação' }),
    testUsernames: z.array(z.string()),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('CommentAutomation');

const Lead = z
  .object({
    id: z.string(),
    automationId: z.string(),
    automationName: z.string().nullable(),
    channelId: z.string(),
    mediaId: z.string(),
    commentId: z.string(),
    commentText: z.string(),
    participantUsername: z.string().nullable(),
    status: z.enum(AutomationRunStatuses),
    step: z.number(),
    answers: z.record(z.string()),
    publicReply: z.string(),
    privateReply: z.string(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi('AutomationLead');

const ERRORS = errorResponses(400, 401, 403, 404);

const clientIp = (c: Context<AppEnv>) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function automationRoutes(ctn: Container) {
  const app = createApp();
  app.use('*', requireAuth({ authenticateHuman: ctn.auth.authenticateHuman }));
  const svc = ctn.automation.automations;

  const actorOf = (c: Context<AppEnv>) => {
    const p = c.get('principal');
    return {
      type: p.kind === 'api_key' ? ('API_KEY' as const) : ('USER' as const),
      id: p.userId ?? p.apiKeyId ?? null,
      ip: clientIp(c),
    };
  };
  const orgOf = (c: Context<AppEnv>) => c.get('principal').orgId;

  type View = Awaited<ReturnType<typeof svc.get>>;
  const out = (a: View) => ({
    id: a.id,
    channelId: a.channelId,
    name: a.name,
    status: a.status,
    config: a.config,
    testUsernames: a.testUsernames,
    createdBy: a.createdBy,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Automações de comentário da organização',
    request: { query: ListQuery },
    responses: { 200: jsonResponse('automações', z.object({ items: z.array(Automation) })), ...ERRORS },
  });
  app.get('/', async (c) => {
    const { channelId } = ListQuery.parse(c.req.query());
    const items = await svc.list(orgOf(c), channelId ? { channelId } : undefined);
    return c.json({ items: items.map(out) });
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Cria uma automação (em rascunho)',
    request: jsonBody(CreateBody),
    responses: { 201: jsonResponse('criada', Automation), ...ERRORS },
  });
  app.post('/', async (c) => {
    const b = CreateBody.parse(await c.req.json());
    const a = await svc.create({
      orgId: orgOf(c),
      actor: actorOf(c),
      channelId: b.channelId,
      name: b.name,
      config: b.config,
      ...(b.testUsernames ? { testUsernames: b.testUsernames } : {}),
    });
    return c.json(out(a), 201);
  });

  // antes de `/:id` para não ser capturada como id
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/leads',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Leads (execuções) das automações, mais recentes primeiro',
    request: { query: LeadsQuery },
    responses: {
      200: jsonResponse('leads', z.object({ items: z.array(Lead), nextCursor: z.string().optional() })),
      ...ERRORS,
    },
  });
  app.get('/leads', async (c) => {
    const q = LeadsQuery.parse(c.req.query());
    const page = await svc.leads(orgOf(c), {
      ...(q.automationId ? { automationId: q.automationId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: 50,
    });
    return c.json({
      items: page.items.map((r) => ({
        id: r.id,
        automationId: r.automationId,
        automationName: r.automationName,
        channelId: r.channelId,
        mediaId: r.mediaId,
        commentId: r.commentId,
        commentText: r.commentText,
        participantUsername: r.participantUsername,
        status: r.status,
        step: r.step,
        answers: r.answers,
        publicReply: r.publicReply,
        privateReply: r.privateReply,
        lastError: r.lastError,
        createdAt: r.createdAt.toISOString(),
        completedAt: iso(r.completedAt),
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/{id}',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Uma automação',
    request: { params: IdParam },
    responses: { 200: jsonResponse('automação', Automation), ...ERRORS },
  });
  app.get('/:id', async (c) => {
    const { id } = IdParam.parse(c.req.param());
    return c.json(out(await svc.get(orgOf(c), id)));
  });

  app.openAPIRegistry.registerPath({
    method: 'patch',
    path: '/{id}',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Edita nome, configuração ou contas de teste',
    request: { params: IdParam, ...jsonBody(UpdateBody) },
    responses: { 200: jsonResponse('automação', Automation), ...ERRORS },
  });
  app.patch('/:id', async (c) => {
    const { id } = IdParam.parse(c.req.param());
    const b = UpdateBody.parse(await c.req.json());
    const a = await svc.update({
      orgId: orgOf(c),
      id,
      actor: actorOf(c),
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.config !== undefined ? { config: b.config } : {}),
      ...(b.testUsernames ? { testUsernames: b.testUsernames } : {}),
    });
    return c.json(out(a));
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/{id}/status',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Muda o status (rascunho, teste, ativa, pausada) — requer ADMIN/OWNER',
    request: { params: IdParam, ...jsonBody(StatusBody) },
    responses: { 200: jsonResponse('automação', Automation), ...ERRORS },
  });
  app.post('/:id/status', requireAdmin(), async (c) => {
    const { id } = IdParam.parse(c.req.param());
    const { status } = StatusBody.parse(await c.req.json());
    return c.json(out(await svc.setStatus({ orgId: orgOf(c), id, actor: actorOf(c), status })));
  });

  app.openAPIRegistry.registerPath({
    method: 'delete',
    path: '/{id}',
    tags: ['automations'],
    security: AUTH_SECURITY,
    summary: 'Apaga a automação (os leads continuam) — requer ADMIN/OWNER',
    request: { params: IdParam },
    responses: { 204: { description: 'apagada' }, ...ERRORS },
  });
  app.delete('/:id', requireAdmin(), async (c) => {
    const { id } = IdParam.parse(c.req.param());
    await svc.remove({ orgId: orgOf(c), id, actor: actorOf(c) });
    return c.body(null, 204);
  });

  return app;
}
