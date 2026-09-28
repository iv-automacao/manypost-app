import { z } from '@hono/zod-openapi';
import {
  ContentCtaChannels,
  ContentFormats,
  ContentFoundationKeys,
  ContentPieceStatuses,
  ContentPromptNames,
  ErrorCodes,
  type ContentFoundationKey,
  type ContentPromptName,
} from '@manypost/contracts';
import { DomainError, type ContentBrandRecord, type ContentPieceRecord } from '@manypost/core';
import type { Container } from '../../container';
import { requireAuth } from '../middleware/auth';
import { AUTH_SECURITY, createApp, errorResponses, jsonBody, jsonResponse } from '../openapi';

/**
 * Máquina de conteúdo (openspec add-content-machine): superfície humana `/v1` apenas.
 * Tudo é da organização do principal; id de outra organização responde 404.
 */

/** data que existe no calendário — a regex sozinha deixava 2026-13-40 chegar ao banco (500) */
const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'data inexistente');

const PiecesQuery = z.object({
  status: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const SpendQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Palette = z
  .object({
    primaria: Hex.optional(),
    destaque: Hex.optional(),
    fundoEscuro: Hex.optional(),
    fundoClaro: Hex.optional(),
    texto: Hex.optional(),
    textoSuave: Hex.optional(),
    extraidas: z.array(z.string()).optional(),
  })
  .openapi('ContentPalette');

const BrandOut = z
  .object({
    name: z.string(),
    logoMediaId: z.string().nullable(),
    logoUrl: z.string().nullable(),
    logoDarkMediaId: z.string().nullable(),
    logoDarkUrl: z.string().nullable(),
    palette: Palette,
    slogan: z.string(),
    signature: z.string(),
    tone: z.string(),
    defaultChannelId: z.string().nullable(),
    ctaChannel: z.enum(ContentCtaChannels),
    whatsappNumber: z.string(),
    publishHour: z.number().int(),
    timezone: z.string(),
    autoApprove: z.boolean(),
  })
  .openapi('ContentBrand');

const BrandPatch = z
  .object({
    name: z.string().max(80),
    logoMediaId: z.string().uuid().nullable(),
    logoDarkMediaId: z.string().uuid().nullable(),
    palette: Palette,
    slogan: z.string().max(200),
    signature: z.string().max(200),
    tone: z.string().max(2000),
    defaultChannelId: z.string().uuid().nullable(),
    ctaChannel: z.enum(ContentCtaChannels),
    whatsappNumber: z.string().max(20),
    publishHour: z.number().int().min(0).max(23),
    timezone: z.string().max(60),
    autoApprove: z.boolean(),
  })
  .partial();

const Capabilities = z
  .object({
    text: z.boolean(),
    renderer: z.boolean(),
    video: z.boolean(),
    videoModel: z.string().nullable(),
  })
  .openapi('ContentCapabilities');

const MediaOut = z.object({
  mediaId: z.string(),
  kind: z.enum(['image', 'video']),
  order: z.number().int(),
  url: z.string().nullable(),
  mime: z.string().nullable(),
});

const Flag = z.object({ codigo: z.string(), trecho: z.string(), motivo: z.string() });
const LintFinding = z.object({ nivel: z.enum(['erro', 'aviso']), codigo: z.string(), msg: z.string() });

const PieceOut = z
  .object({
    id: z.string(),
    status: z.enum(ContentPieceStatuses),
    format: z.enum(ContentFormats),
    pillar: z.string(),
    icp: z.string(),
    market: z.string(),
    awareness: z.string(),
    hook: z.string(),
    plan: z.record(z.string(), z.unknown()),
    script: z.record(z.string(), z.unknown()).nullable(),
    caption: z.string(),
    hashtags: z.array(z.string()),
    keyword: z.string(),
    media: z.array(MediaOut),
    review: z
      .object({ aprovado: z.boolean(), flags: z.array(Flag), motivo: z.string(), lint: z.array(LintFinding).optional() })
      .nullable(),
    feedback: z.array(z.object({ at: z.string(), stage: z.string(), text: z.string(), by: z.string().nullable() })),
    attempts: z.number().int(),
    scheduledFor: z.string().datetime().nullable(),
    channelId: z.string().nullable(),
    postGroupId: z.string().nullable(),
    publishedAt: z.string().datetime().nullable(),
    permalink: z.string().nullable(),
    costUsd: z.number(),
    error: z.string().nullable(),
    running: z.boolean().openapi({ description: 'true = uma etapa está executando agora' }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('ContentPiece');

const EventOut = z
  .object({
    id: z.string(),
    stage: z.string(),
    fromStatus: z.string().nullable(),
    toStatus: z.string(),
    detail: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .openapi('ContentPieceEvent');

const FoundationOut = z
  .object({ key: z.enum(ContentFoundationKeys), body: z.string(), validUntil: z.string().nullable(), updatedAt: z.string().datetime() })
  .openapi('ContentFoundation');

const PromptOut = z
  .object({ id: z.string(), name: z.enum(ContentPromptNames), version: z.number().int(), system: z.string(), active: z.boolean(), createdAt: z.string().datetime() })
  .openapi('ContentPrompt');

const HookOut = z
  .object({ id: z.string(), formula: z.string(), template: z.string(), example: z.string(), pillar: z.string(), origin: z.string(), score: z.number().int(), uses: z.number().int() })
  .openapi('ContentHook');

const Overview = z
  .object({
    brand: BrandOut,
    capabilities: Capabilities,
    counts: z.record(z.string(), z.number().int()),
    foundationFilled: z.number().int(),
    foundationTotal: z.number().int(),
  })
  .openapi('ContentOverview');

const CreatePieceBody = z.object({
  format: z.enum(ContentFormats),
  hook: z.string().min(1).max(500).openapi({ description: 'a ideia ou o gancho' }),
  angle: z.string().max(1000).optional(),
  pillar: z.string().max(40).optional(),
  icp: z.string().max(40).optional(),
  market: z.string().max(40).optional(),
  scheduledFor: z.string().datetime().optional(),
  channelId: z.string().uuid().optional(),
});

const PlanBody = z.object({
  weekStart: CalendarDate,
  market: z.string().max(40).optional(),
  channelId: z.string().uuid().optional(),
  slots: z
    .array(
      z.object({
        date: CalendarDate,
        format: z.enum(ContentFormats),
        pillar: z.string().max(40),
        icp: z.string().max(40).optional(),
        market: z.string().max(40).optional(),
      }),
    )
    .max(14)
    .optional(),
});

const EditBody = z.object({
  caption: z.string().max(2200).optional(),
  hashtags: z.array(z.string().max(60)).max(5).optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
});

const DecisionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('redo'), stage: z.enum(['roteiro', 'producao']), feedback: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('retry') }),
]);

const SpendOut = z
  .object({
    month: z.string(),
    totalUsd: z.number(),
    byService: z.array(z.object({ service: z.string(), model: z.string(), costUsd: z.number(), count: z.number().int() })),
    pieces: z.array(z.object({ pieceId: z.string(), keyword: z.string(), format: z.string(), costUsd: z.number() })),
  })
  .openapi('ContentSpend');

const iso = (d: Date | null) => (d ? d.toISOString() : null);


export function contentMachineRoutes(ctn: Container) {
  const app = createApp();
  app.use('*', requireAuth({ authenticateHuman: ctn.auth.authenticateHuman }));
  const cm = ctn.contentMachine;
  const tags = ['content-machine'];
  const actor = (c: { get: (k: 'principal') => { orgId: string; userId: string } }) => ({
    orgId: c.get('principal').orgId,
    userId: c.get('principal').userId,
  });

  /** URL e mime das mídias: o quadro mostra miniatura sem outra ida ao servidor */
  const mediaInfo = async (orgId: string, pieces: ContentPieceRecord[]) => {
    const ids = [...new Set(pieces.flatMap((p) => p.media.map((m) => m.mediaId)))];
    const registros = ids.length ? await ctn.repos.media.findMany(orgId, ids) : [];
    return new Map(registros.map((r) => [r.id, { url: cm.publicUrl(r.path), mime: r.mime }]));
  };
  const pieceOut = (p: ContentPieceRecord, info: Map<string, { url: string; mime: string }>) => ({
    ...p,
    media: [...p.media].sort((a, b) => a.order - b.order).map((m) => ({ ...m, url: info.get(m.mediaId)?.url ?? null, mime: info.get(m.mediaId)?.mime ?? null })),
    running: Boolean(p.lockedUntil && p.lockedUntil > new Date()),
    scheduledFor: iso(p.scheduledFor),
    publishedAt: iso(p.publishedAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    lockedUntil: undefined,
    orgId: undefined,
  });
  const brandOut = async (b: ContentBrandRecord) => {
    const ids = [b.logoMediaId, b.logoDarkMediaId].filter((x): x is string => Boolean(x));
    const registros = ids.length ? await ctn.repos.media.findMany(b.orgId, ids) : [];
    const url = (id: string | null) => {
      const r = registros.find((m) => m.id === id);
      return r ? cm.publicUrl(r.path) : null;
    };
    const { orgId: _o, updatedAt: _u, ...resto } = b;
    return { ...resto, logoUrl: url(b.logoMediaId), logoDarkUrl: url(b.logoDarkMediaId) };
  };
  const onePiece = async (orgId: string, id: string) => {
    const p = await cm.repo.getPiece(orgId, id);
    if (!p) throw new DomainError(ErrorCodes.NotFound, 'peça não encontrada');
    return pieceOut(p, await mediaInfo(orgId, [p]));
  };

  // ---------------------------------------------------------------- visão geral e identidade

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/overview',
    tags,
    security: AUTH_SECURITY,
    summary: 'Estado da máquina: identidade, capacidades e contagem por etapa',
    description: 'Na primeira chamada, configura a organização (prompts, fórmulas e fundação vazia).',
    responses: { 200: jsonResponse('visão geral', Overview), ...errorResponses(401) },
  });
  app.get('/overview', async (c) => {
    const { orgId } = actor(c);
    const brand = await cm.setup(orgId);
    const [pieces, docs] = await Promise.all([cm.repo.listPieces(orgId, { limit: 500 }), cm.repo.listFoundations(orgId)]);
    const counts: Record<string, number> = Object.fromEntries(ContentPieceStatuses.map((s) => [s, 0]));
    for (const p of pieces) counts[p.status] = (counts[p.status] ?? 0) + 1;
    return c.json({
      brand: await brandOut(brand),
      capabilities: cm.capabilities,
      counts,
      foundationFilled: docs.filter((d) => d.body.trim().length > 0).length,
      foundationTotal: ContentFoundationKeys.length,
    });
  });

  app.openAPIRegistry.registerPath({
    method: 'put',
    path: '/brand',
    tags,
    security: AUTH_SECURITY,
    summary: 'Atualiza a identidade visual e as preferências de publicação',
    request: jsonBody(BrandPatch),
    responses: { 200: jsonResponse('identidade', BrandOut), ...errorResponses(400, 401, 404) },
  });
  app.put('/brand', async (c) => {
    const { orgId } = actor(c);
    const body = BrandPatch.parse(await c.req.json());
    await cm.setup(orgId);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return c.json(await brandOut(await cm.updateBrand(orgId, patch)));
  });

  const PaletteBody = z.object({ mediaId: z.string().uuid().optional() });
  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/brand/palette',
    tags,
    security: AUTH_SECURITY,
    summary: 'Extrai a paleta de cores da logo',
    description: 'Sem `mediaId`, usa a logo principal. Sem logo definida, a imagem enviada vira a logo.',
    request: jsonBody(PaletteBody, false),
    responses: { 200: jsonResponse('identidade com a paleta', BrandOut), ...errorResponses(400, 401, 404, 501, 502) },
  });
  app.post('/brand/palette', async (c) => {
    const { orgId } = actor(c);
    const body = PaletteBody.parse(await c.req.json().catch(() => ({})));
    await cm.setup(orgId);
    return c.json(await brandOut(await cm.extractPalette(orgId, body.mediaId)));
  });

  // ---------------------------------------------------------------- fundação, prompts, fórmulas

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/foundation',
    tags,
    security: AUTH_SECURITY,
    summary: 'Documentos da fundação editorial',
    responses: { 200: jsonResponse('fundação', z.array(FoundationOut)), ...errorResponses(401) },
  });
  app.get('/foundation', async (c) => {
    await cm.setup(actor(c).orgId);
    const docs = await cm.repo.listFoundations(actor(c).orgId);
    return c.json(docs.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() })));
  });

  const FoundationBody = z.object({ body: z.string().max(30_000), validUntil: CalendarDate.nullable().optional() });
  app.openAPIRegistry.registerPath({
    method: 'put',
    path: '/foundation/{key}',
    tags,
    security: AUTH_SECURITY,
    summary: 'Grava um documento da fundação',
    request: { params: z.object({ key: z.enum(ContentFoundationKeys) }), ...jsonBody(FoundationBody) },
    responses: { 200: jsonResponse('documento', FoundationOut), ...errorResponses(400, 401) },
  });
  app.put('/foundation/:key', async (c) => {
    const key = z.enum(ContentFoundationKeys).parse(c.req.param('key')) as ContentFoundationKey;
    const body = FoundationBody.parse(await c.req.json());
    const d = await cm.updateFoundation(actor(c), key, body.body, body.validUntil ?? null);
    return c.json({ ...d, updatedAt: d.updatedAt.toISOString() });
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/prompts',
    tags,
    security: AUTH_SECURITY,
    summary: 'Prompts da máquina, com o histórico de versões',
    responses: { 200: jsonResponse('prompts', z.array(PromptOut)), ...errorResponses(401) },
  });
  app.get('/prompts', async (c) => {
    await cm.setup(actor(c).orgId);
    const list = await cm.repo.listPrompts(actor(c).orgId);
    return c.json(list.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })));
  });

  const PromptBody = z.object({ system: z.string().min(20).max(30_000) });
  app.openAPIRegistry.registerPath({
    method: 'put',
    path: '/prompts/{name}',
    tags,
    security: AUTH_SECURITY,
    summary: 'Cria uma versão nova (ativa) do prompt',
    request: { params: z.object({ name: z.enum(ContentPromptNames) }), ...jsonBody(PromptBody) },
    responses: { 200: jsonResponse('versão criada', PromptOut), ...errorResponses(400, 401) },
  });
  app.put('/prompts/:name', async (c) => {
    const name = z.enum(ContentPromptNames).parse(c.req.param('name')) as ContentPromptName;
    const body = PromptBody.parse(await c.req.json());
    const p = await cm.savePrompt(actor(c), name, body.system);
    return c.json({ ...p, createdAt: p.createdAt.toISOString() });
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/hooks',
    tags,
    security: AUTH_SECURITY,
    summary: 'Fórmulas de gancho que a pauta usa',
    responses: { 200: jsonResponse('fórmulas', z.array(HookOut)), ...errorResponses(401) },
  });
  app.get('/hooks', async (c) => {
    await cm.setup(actor(c).orgId);
    return c.json(await cm.repo.listHooks(actor(c).orgId));
  });

  // ---------------------------------------------------------------- peças

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/pieces',
    tags,
    security: AUTH_SECURITY,
    summary: 'Peças da máquina, mais recentes primeiro',
    request: { query: z.object({ status: z.string().optional().openapi({ description: 'status separados por vírgula' }), limit: z.coerce.number().int().min(1).max(500).optional() }) },
    responses: { 200: jsonResponse('peças', z.array(PieceOut)), ...errorResponses(401) },
  });
  app.get('/pieces', async (c) => {
    const { orgId } = actor(c);
    const q = PiecesQuery.parse(c.req.query());
    const statuses = (q.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is (typeof ContentPieceStatuses)[number] => (ContentPieceStatuses as readonly string[]).includes(s));
    const pieces = await cm.repo.listPieces(orgId, { ...(statuses.length ? { statuses } : {}), limit: q.limit ?? 200 });
    const info = await mediaInfo(orgId, pieces);
    return c.json(pieces.map((p) => pieceOut(p, info)));
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/pieces',
    tags,
    security: AUTH_SECURITY,
    summary: 'Cria uma peça a partir de uma ideia; a esteira começa sozinha',
    request: jsonBody(CreatePieceBody),
    responses: { 201: jsonResponse('peça criada', PieceOut), ...errorResponses(400, 401, 404, 501) },
  });
  app.post('/pieces', async (c) => {
    const a = actor(c);
    const body = CreatePieceBody.parse(await c.req.json());
    const p = await cm.createPiece(a, {
      format: body.format,
      hook: body.hook,
      ...(body.angle ? { angle: body.angle } : {}),
      ...(body.pillar ? { pillar: body.pillar } : {}),
      ...(body.icp ? { icp: body.icp } : {}),
      ...(body.market ? { market: body.market } : {}),
      ...(body.scheduledFor ? { scheduledFor: new Date(body.scheduledFor) } : {}),
      ...(body.channelId ? { channelId: body.channelId } : {}),
    });
    return c.json(await onePiece(a.orgId, p.id), 201);
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/plan',
    tags,
    security: AUTH_SECURITY,
    summary: 'Pede a pauta da semana; as peças aparecem no quadro quando a geração termina',
    description:
      'Sem `slots`, usa o mix padrão (2 carrosséis, 1 reels, 1 post). A geração roda na fila (o modelo ' +
      'passa do tempo de uma requisição); semana já planejada responde 409.',
    request: jsonBody(PlanBody),
    responses: {
      202: jsonResponse('pauta na fila', z.object({ queued: z.literal(true), weekStart: z.string() }).openapi('ContentPlanQueued')),
      ...errorResponses(400, 401, 404, 409, 501),
    },
  });
  app.post('/plan', async (c) => {
    const a = actor(c);
    const body = PlanBody.parse(await c.req.json());
    await cm.setup(a.orgId);
    const out = await cm.requestPlan(a, {
      weekStart: body.weekStart,
      ...(body.slots ? { slots: body.slots } : {}),
      ...(body.market ? { market: body.market } : {}),
      ...(body.channelId ? { channelId: body.channelId } : {}),
    });
    return c.json(out, 202);
  });

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/pieces/{id}',
    tags,
    security: AUTH_SECURITY,
    summary: 'Uma peça com o histórico de etapas',
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: jsonResponse('peça', z.object({ piece: PieceOut, events: z.array(EventOut) }).openapi('ContentPieceDetail')),
      ...errorResponses(401, 404),
    },
  });
  app.get('/pieces/:id', async (c) => {
    const { orgId } = actor(c);
    const id = z.string().uuid().parse(c.req.param('id'));
    const piece = await onePiece(orgId, id);
    const events = await cm.repo.events(orgId, id);
    return c.json({ piece, events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })) });
  });

  app.openAPIRegistry.registerPath({
    method: 'patch',
    path: '/pieces/{id}',
    tags,
    security: AUTH_SECURITY,
    summary: 'Ajusta legenda, hashtags, data ou canal antes do agendamento',
    request: { params: z.object({ id: z.string().uuid() }), ...jsonBody(EditBody) },
    responses: { 200: jsonResponse('peça', PieceOut), ...errorResponses(400, 401, 404, 409) },
  });
  app.patch('/pieces/:id', async (c) => {
    const a = actor(c);
    const id = z.string().uuid().parse(c.req.param('id'));
    const body = EditBody.parse(await c.req.json());
    await cm.edit(a, id, {
      ...(body.caption !== undefined ? { caption: body.caption } : {}),
      ...(body.hashtags !== undefined ? { hashtags: body.hashtags } : {}),
      ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null } : {}),
      ...(body.channelId !== undefined ? { channelId: body.channelId } : {}),
    });
    return c.json(await onePiece(a.orgId, id));
  });

  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/pieces/{id}/decision',
    tags,
    security: AUTH_SECURITY,
    summary: 'Decisão humana: aprovar, reprovar, refazer uma etapa ou tentar de novo',
    request: { params: z.object({ id: z.string().uuid() }), ...jsonBody(DecisionBody) },
    responses: { 200: jsonResponse('peça', PieceOut), ...errorResponses(400, 401, 404, 409) },
  });
  app.post('/pieces/:id/decision', async (c) => {
    const a = actor(c);
    const id = z.string().uuid().parse(c.req.param('id'));
    const body = DecisionBody.parse(await c.req.json());
    await cm.decide(a, id, body);
    return c.json(await onePiece(a.orgId, id));
  });

  // ---------------------------------------------------------------- gasto

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/spend',
    tags,
    security: AUTH_SECURITY,
    summary: 'Gasto do mês por serviço e por peça (USD)',
    request: { query: SpendQuery },
    responses: { 200: jsonResponse('gasto', SpendOut), ...errorResponses(401) },
  });
  app.get('/spend', async (c) => c.json(await cm.spend(actor(c).orgId, SpendQuery.parse(c.req.query()).month)));

  return app;
}
