import { describe, expect, it } from 'bun:test';
import type { ContentPieceStatus } from '@manypost/contracts';
import type { AiProvider, BudgetGuard } from '../ports/ai-provider';
import type {
  ContentBrandRecord,
  ContentMachineRepository,
  ContentPieceEventRecord,
  ContentPieceRecord,
  ContentPromptRecord,
  ContentRenderer,
  VideoGenerationProvider,
} from '../ports/content-machine';
import type { MediaRecord } from '../ports/media';
import {
  makeContentSetup,
  makeCreatePiece,
  makeDecidePiece,
  makeExtractPalette,
  makePlanContentWeek,
  makeSpendSummary,
  zonedDate,
  type ContentMachineDeps,
} from './content-machine';
import { makeRunContentStage, makeSweepContent } from './content-machine-stages';

const ORG = 'org-1';
const OUTRA = 'org-2';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 56, 0, 0, 5, 70, 8, 6, 0, 0, 0]);
// ftyp mp4 mínimo reconhecido pelo sniff
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]);

/** repositório em memória com as mesmas regras de posse e condição do real */
function fakeRepo() {
  let brand: ContentBrandRecord | null = null;
  const foundations = new Map<string, { body: string; validUntil: string | null }>();
  const prompts: ContentPromptRecord[] = [];
  const hooks: Array<{ formula: string; uses: number }> = [];
  const pieces = new Map<string, ContentPieceRecord>();
  const events: Array<ContentPieceEventRecord & { pieceId: string }> = [];
  const spend: Array<{ orgId: string; pieceId: string | null; externalId: string; costUsd: number; service: string; model: string }> = [];
  let seq = 0;

  const aplicar = (p: ContentPieceRecord, patch: Record<string, unknown>) => {
    const { incrementAttempts, resetAttempts, ...campos } = patch;
    for (const [k, v] of Object.entries(campos)) if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
    if (incrementAttempts) p.attempts++;
    if (resetAttempts) p.attempts = 0;
    p.updatedAt = new Date();
  };

  const repo: ContentMachineRepository = {
    async getBrand(orgId) {
      return brand && brand.orgId === orgId ? brand : null;
    },
    async upsertBrand(orgId, patch) {
      brand = {
        ...(brand ?? {
          orgId, name: '', logoMediaId: null, logoDarkMediaId: null, palette: {}, slogan: '', signature: '', tone: '',
          defaultChannelId: null, ctaChannel: 'direct', whatsappNumber: '', publishHour: 18, timezone: 'America/Manaus', autoApprove: true, updatedAt: new Date(),
        }),
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      } as ContentBrandRecord;
      return brand;
    },
    async listFoundations() {
      return [...foundations].map(([key, v]) => ({ key: key as never, body: v.body, validUntil: v.validUntil, updatedAt: new Date() }));
    },
    async upsertFoundation(_o, key, body, validUntil) {
      foundations.set(key, { body, validUntil });
      return { key, body, validUntil, updatedAt: new Date() };
    },
    async seedFoundations(_o, keys) {
      for (const k of keys) if (!foundations.has(k)) foundations.set(k, { body: '', validUntil: null });
    },
    async listPrompts() {
      return prompts;
    },
    async activePrompt(_o, name) {
      return prompts.find((p) => p.name === name && p.active) ?? null;
    },
    async savePromptVersion(_o, name, system) {
      const v = Math.max(0, ...prompts.filter((p) => p.name === name).map((p) => p.version)) + 1;
      for (const p of prompts) if (p.name === name) p.active = false;
      const r = { id: `p${++seq}`, name, version: v, system, active: true, createdAt: new Date() };
      prompts.push(r);
      return r;
    },
    async seedPrompts(_o, list) {
      for (const p of list) {
        if (!prompts.some((x) => x.name === p.name)) prompts.push({ id: `p${++seq}`, name: p.name, version: 1, system: p.system, active: true, createdAt: new Date() });
      }
    },
    async listHooks() {
      return hooks.map((h, i) => ({ id: `h${i}`, formula: h.formula, template: 't', example: 'e', pillar: 'educar', origin: 'referencia', score: 50, uses: h.uses }));
    },
    async seedHooks(_o, list) {
      for (const h of list) if (!hooks.some((x) => x.formula === h.formula)) hooks.push({ formula: h.formula, uses: 0 });
    },
    async bumpHookUse(_o, formula) {
      const h = hooks.find((x) => x.formula === formula);
      if (h) h.uses++;
    },
    async createPiece(orgId, d) {
      if ([...pieces.values()].some((p) => p.orgId === orgId && p.keyword === d.keyword)) throw new Error('unique keyword');
      const p: ContentPieceRecord = {
        id: `piece-${++seq}`, orgId, status: 'ideia', ...d, script: null, caption: '', hashtags: [], media: [], review: null, feedback: [],
        attempts: 0, postGroupId: null, publishedAt: null, permalink: null, costUsd: 0, error: null, lockedUntil: null, createdAt: new Date(), updatedAt: new Date(),
      };
      pieces.set(p.id, p);
      events.push({ id: `e${++seq}`, pieceId: p.id, stage: 'criacao', fromStatus: null, toStatus: 'ideia', detail: {}, createdAt: new Date() });
      return p;
    },
    async listPieces(orgId, opts) {
      return [...pieces.values()].filter((p) => p.orgId === orgId && (!opts?.statuses || opts.statuses.includes(p.status)));
    },
    async getPiece(orgId, id) {
      const p = pieces.get(id);
      return p && p.orgId === orgId ? structuredClone(p) : null;
    },
    async keywordsWithPrefix(orgId, prefix) {
      return [...pieces.values()].filter((p) => p.orgId === orgId && p.keyword.startsWith(prefix)).map((p) => p.keyword);
    },
    async hooksSince() {
      return [...pieces.values()].map((p) => p.hook);
    },
    async claim(orgId, id, status, leaseSec) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId || p.status !== status) return null;
      if (p.lockedUntil && p.lockedUntil > new Date()) return null;
      p.lockedUntil = new Date(Date.now() + leaseSec * 1000);
      return structuredClone(p);
    },
    async release(orgId, id, patch) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId) return;
      aplicar(p, patch ?? {});
      p.lockedUntil = null;
    },
    async transition(orgId, id, from, to, patch, event) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId || p.status !== from) return null;
      aplicar(p, patch);
      p.status = to;
      p.lockedUntil = null;
      events.push({ id: `e${++seq}`, pieceId: id, stage: event.stage, fromStatus: from, toStatus: to, detail: event.detail ?? {}, createdAt: new Date() });
      return structuredClone(p);
    },
    async update(orgId, id, patch, onlyIn) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId || (onlyIn && !onlyIn.includes(p.status))) return null;
      aplicar(p, patch);
      return structuredClone(p);
    },
    async events(orgId, pieceId) {
      return events.filter((e) => e.pieceId === pieceId && pieces.get(pieceId)?.orgId === orgId);
    },
    async stalled() {
      return [];
    },
    async scheduled() {
      return [...pieces.values()].filter((p) => p.status === 'agendado').map((p) => ({ orgId: p.orgId, id: p.id, postGroupId: p.postGroupId }));
    },
    async addSpend(d) {
      if (spend.some((s) => s.orgId === d.orgId && s.externalId === d.externalId)) return false;
      spend.push({ ...d });
      if (d.pieceId) pieces.get(d.pieceId)!.costUsd += d.costUsd;
      return true;
    },
    async spendSummary(orgId) {
      const minhas = spend.filter((s) => s.orgId === orgId);
      return { totalUsd: minhas.reduce((t, s) => t + s.costUsd, 0), byService: [], pieces: [] };
    },
  };
  return { repo, pieces, events, spend, prompts, hooks, get brand() { return brand; } };
}

/** modelo de texto roteirizado por prompt: responde conforme a instrução de sistema */
function fakeAi(respostas: Partial<Record<'pauta' | 'roteiro' | 'legenda' | 'revisor', (entrada: string) => unknown>>) {
  const chamadas: Array<{ system: string; prompt: string }> = [];
  const ai: AiProvider = {
    async generateText({ system, prompt }) {
      chamadas.push({ system, prompt });
      const nome = system.includes('revisor de conformidade') ? 'revisor' : system.includes('estrategista') ? 'pauta' : system.includes('roteirista') ? 'roteiro' : 'legenda';
      const r = respostas[nome]?.(prompt);
      return { text: typeof r === 'string' ? r : JSON.stringify(r ?? {}), usage: { inputTokens: 1000, outputTokens: 500 } };
    },
  };
  return { ai, chamadas };
}

const budget: BudgetGuard = {
  reserve: async () => ({ grantId: 'g' }),
  commit: async () => {},
  release: async () => {},
  balance: async () => ({ granted: 0, used: 0, reserved: 0, remaining: 0, periodEnd: new Date(), enforced: false }),
};

const roteiroCarrossel = {
  hook: 'Onde fica o seu PS?', story: 'História curta.', offer: 'Manda a palavra no direct.',
  slides: [
    { ordem: 1, tipo: 'capa', titulo: 'Onde fica o seu PS?', texto: '', itens: [] },
    { ordem: 2, tipo: 'cta', titulo: 'A gente te mostra.', texto: 'Manda no direct.', itens: [] },
  ],
  cenas: [], alt_capa: 'Capa', pendencias: [],
};
const roteiroReels = {
  hook: 'Servidor, este é pra você.', story: 'Seu vínculo pode dar acesso.', offer: 'Chama no direct.',
  slides: [],
  cenas: [
    { ordem: 1, duracao_s: 6, locucao: 'Fala um.', texto_tela: 'um', visual: 'Orla ao entardecer.' },
    { ordem: 2, duracao_s: 6, locucao: 'Fala dois.', texto_tela: 'dois', visual: 'Mesa com café.' },
  ],
  alt_capa: 'Reels', pendencias: [],
};

function montar(opts: { revisor?: unknown; lintErro?: boolean; videoFalha?: 'uma' | 'sempre' } = {}) {
  const f = fakeRepo();
  const { ai, chamadas } = fakeAi({
    pauta: () => ({
      pautas: [
        { slot_data: '2026-10-05', formato: 'carrossel', pilar: 'educar', icp: 'familia', praca: 'manaus', consciencia: 'problema', formula: 'Ninguém te conta', gancho: 'Ninguém te conta onde fica o PS.', angulo: 'rede de urgência' },
        { slot_data: '2026-10-07', formato: 'reels', pilar: 'dor_objecao', icp: 'empresario', praca: 'manaus', consciencia: 'solucao', formula: 'A objeção', gancho: '"Plano PME é caro." Veja.', angulo: 'MEI' },
      ],
    }),
    roteiro: (entrada) => (entrada.includes('"formato":"reels"') ? roteiroReels : roteiroCarrossel),
    legenda: () => ({ legenda: 'Primeira linha.\n\nCorpo.', hashtags: ['#planodesaudemanaus', 'saude'], cta: 'x' }),
    revisor: () => opts.revisor ?? { aprovado: true, flags: [], motivo: '' },
  });
  const media: MediaRecord[] = [];
  let lintChamadas = 0;
  const renderer: ContentRenderer = {
    async render(req) {
      return (req.format === 'carrossel' ? req.slides : [1]).map(() => ({ bytes: PNG, width: 1080, height: 1350 }));
    },
    async lint(req) {
      lintChamadas++;
      const erro = opts.lintErro && lintChamadas === 1;
      return { script: req.script, caption: req.caption, hashtags: req.hashtags.slice(0, 5), findings: erro ? [{ nivel: 'erro', codigo: 'SEM_CTA', msg: 'sem palavra-chave' }] : [], hasError: erro };
    },
    async palette() {
      return { colors: ['#0073ca', '#231f20', '#zzzzzz'], suggestion: { primaria: '#0073CA', fundoEscuro: '#231f20', texto: 'azul' } };
    },
    async assembleReel(req) {
      return { bytes: MP4, durationSec: req.clipUrls.length * 6 + 3.5 };
    },
  };
  const pedidos: string[] = [];
  const video: VideoGenerationProvider = {
    model: 'modelo-video-teste',
    estimate: async (r) => r.durationSec * 0.4622,
    async submit() {
      const id = `req-${pedidos.length + 1}`;
      pedidos.push(id);
      return { requestId: id };
    },
    status: async (id) =>
      (opts.videoFalha === 'uma' && id === 'req-2') || (opts.videoFalha === 'sempre' && id !== 'req-1')
        ? { state: 'failed', reason: 'moderado' }
        : { state: 'done', videoUrl: `https://cdn.exemplo/${id}.mp4` },
  };
  const enfileirados: Array<{ queue: string; payload: { pieceId: string }; opts?: { startAfter?: Date } }> = [];
  const agendados: Array<Record<string, unknown>> = [];
  const grupos = new Map<string, { state: string; pubState: string; url: string | null }>();
  const deps: ContentMachineDeps = {
    repo: f.repo,
    ai,
    budget,
    renderer,
    video,
    media: {
      async create(d) {
        const m = { ...d, id: `m${media.length + 1}`, createdAt: new Date(), durationSec: null, thumbnailPath: null, blurhash: null, source: d.source ?? 'upload', generationPrompt: d.generationPrompt ?? null, generationModel: d.generationModel ?? null } as MediaRecord;
        media.push(m);
        return m;
      },
      list: async () => media,
      findMany: async (orgId, ids) => media.filter((m) => m.orgId === orgId && ids.includes(m.id)),
      setAlt: async () => true,
      softDelete: async () => true,
    },
    storage: { put: async () => {}, read: async () => null, delete: async () => {}, publicUrl: (k) => `https://post.exemplo/uploads/${k}` },
    channels: {
      findMany: async (orgId, ids) => (orgId === ORG ? ids.filter((i) => i === 'canal-ig').map((id) => ({ id, provider: 'instagram-standalone', name: '@teste' })) : []),
    } as unknown as ContentMachineDeps['channels'],
    publishing: {
      getGroup: async (_o, id) => {
        const g = grupos.get(id);
        return g ? ({ id, state: g.state, publishAt: null, timezone: 'UTC', baseContent: {}, publications: [{ state: g.pubState, releaseUrl: g.url, errorMessage: null }] } as never) : null;
      },
    },
    schedulePost: (async (input: Record<string, unknown>) => {
      agendados.push(input);
      const id = `grupo-${agendados.length}`;
      grupos.set(id, { state: 'SCHEDULED', pubState: 'SCHEDULED', url: null });
      return { id } as never;
    }) as never,
    scheduler: {
      enqueue: async (queue, payload, o) => {
        enfileirados.push({ queue, payload: payload as { pieceId: string }, ...(o ? { opts: o } : {}) });
        return 'job';
      },
      cancelBySingletonKey: async () => {},
      schedule: async () => {},
    },
    audit: { append: async () => {} },
    prices: { textUsdIn: 0.25, textUsdOut: 2 },
    textModel: 'modelo-texto-teste',
    videoMaxBytes: 50 * 1024 * 1024,
    sleep: async () => {},
    now: () => new Date('2026-10-01T12:00:00Z'),
  };
  return { f, deps, chamadas, media, pedidos, enfileirados, agendados, grupos, run: makeRunContentStage(deps) };
}

const actor = { orgId: ORG, userId: 'u1' };

async function pronto(opts?: Parameters<typeof montar>[0]) {
  const m = montar(opts);
  await makeContentSetup(m.deps)(ORG, { brandName: 'Invista' });
  await m.deps.repo.upsertBrand(ORG, { defaultChannelId: 'canal-ig' });
  return m;
}

async function avancarAte(m: Awaited<ReturnType<typeof pronto>>, id: string, parar: ContentPieceStatus[]) {
  for (let i = 0; i < 8; i++) {
    const p = await m.deps.repo.getPiece(ORG, id);
    if (!p || parar.includes(p.status)) return p;
    await m.run(ORG, id);
  }
  return m.deps.repo.getPiece(ORG, id);
}

describe('máquina de conteúdo: configuração', () => {
  it('setup é idempotente e não sobrescreve prompt editado', async () => {
    const m = montar();
    await makeContentSetup(m.deps)(ORG, { brandName: 'Invista' });
    await m.deps.repo.savePromptVersion(ORG, 'roteiro', 'meu roteiro próprio com mais de vinte letras');
    await makeContentSetup(m.deps)(ORG, { brandName: 'Outro nome' });
    expect(m.f.brand?.name).toBe('Invista');
    expect(m.f.prompts.filter((p) => p.name === 'roteiro')).toHaveLength(2);
    expect((await m.deps.repo.activePrompt(ORG, 'roteiro'))?.version).toBe(2);
    expect(m.f.hooks.length).toBeGreaterThan(5);
  });

  it('extrai a paleta da logo e descarta cor inválida', async () => {
    const m = await pronto();
    const logo = await m.deps.media.create({ orgId: ORG, path: `${ORG}/logo.png`, mime: 'image/png', byteSize: 10, width: 10, height: 10, alt: null });
    const brand = await makeExtractPalette(m.deps)(ORG, logo.id);
    expect(brand.logoMediaId).toBe(logo.id);
    expect(brand.palette.primaria).toBe('#0073ca');
    expect(brand.palette.texto).toBeUndefined();
    expect(brand.palette.extraidas).toEqual(['#0073ca', '#231f20']);
  });

  it('logo de outra organização não é aceita', async () => {
    const m = await pronto();
    const alheia = await m.deps.media.create({ orgId: OUTRA, path: 'x.png', mime: 'image/png', byteSize: 1, width: 1, height: 1, alt: null });
    await expect(makeExtractPalette(m.deps)(ORG, alheia.id)).rejects.toThrow('imagem não encontrada');
  });
});

describe('máquina de conteúdo: pauta e etapas', () => {
  it('pauta cria as peças com palavra-chave única, data no fuso da marca e enfileira', async () => {
    const m = await pronto();
    const pecas = await makePlanContentWeek(m.deps)(actor, {
      weekStart: '2026-10-05',
      slots: [
        { date: '2026-10-05', format: 'carrossel', pillar: 'educar' },
        { date: '2026-10-07', format: 'reels', pillar: 'dor_objecao' },
      ],
    });
    expect(pecas.map((p) => p.keyword)).toEqual(['PLANO-1005-A', 'PME-1007-A']);
    // 18h em Manaus (UTC-4) = 22h UTC
    expect(pecas[0]!.scheduledFor?.toISOString()).toBe('2026-10-05T22:00:00.000Z');
    expect(pecas[0]!.channelId).toBe('canal-ig');
    expect(m.enfileirados.map((e) => e.payload.pieceId)).toEqual(pecas.map((p) => p.id));
    expect(m.f.hooks.find((h) => h.formula === 'Ninguém te conta')?.uses).toBe(1);
    expect(m.f.spend.filter((s) => s.pieceId === null)).toHaveLength(1);
  });

  it('carrossel percorre roteiro → arte → revisão → agendamento → publicado', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'carrossel', hook: 'Onde fica o seu PS?' });
    const final = await avancarAte(m, p.id, ['agendado', 'erro', 'revisao']);
    expect(final?.status).toBe('agendado');
    expect(final?.media).toHaveLength(2);
    expect(final?.hashtags).toEqual(['planodesaudemanaus', 'saude']);
    expect(m.agendados[0]).toMatchObject({ channelIds: ['canal-ig'], origin: 'AUTOMATION', settingsByChannel: { 'canal-ig': { postType: 'feed' } } });
    expect(String(m.agendados[0]!.text)).toContain('#planodesaudemanaus #saude');
    // o prompt de sistema recebeu o nome da marca
    expect(m.chamadas.some((c) => c.system.includes('roteirista de Invista'))).toBe(true);

    m.grupos.set(final!.postGroupId!, { state: 'DONE', pubState: 'PUBLISHED', url: 'https://instagram.com/p/x' });
    const sweep = await makeSweepContent(m.deps)();
    expect(sweep.published).toBe(1);
    const publicada = await m.deps.repo.getPiece(ORG, p.id);
    expect(publicada?.status).toBe('publicado');
    expect(publicada?.permalink).toBe('https://instagram.com/p/x');
    const etapas = (await m.deps.repo.events(ORG, p.id)).map((e) => e.toStatus);
    expect(etapas).toEqual(['ideia', 'roteiro', 'producao', 'aprovado', 'agendado', 'publicado']);
  });

  it('achado de erro no lint gera uma correção com os achados', async () => {
    const m = await pronto({ lintErro: true });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await m.run(ORG, p.id);
    const roteiros = m.chamadas.filter((c) => c.system.includes('roteirista'));
    expect(roteiros).toHaveLength(2);
    expect(roteiros[1]!.prompt).toContain('CORRIJA');
    expect((await m.deps.repo.getPiece(ORG, p.id))?.status).toBe('roteiro');
  });

  it('flag do revisor para a peça em revisão humana', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'PROMESSA_INDEVIDA', trecho: 'sem reajuste', motivo: 'x' }], motivo: '1 flag' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'carrossel', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['revisao', 'agendado', 'erro']);
    expect(final?.status).toBe('revisao');
    expect(final?.review?.flags[0]?.codigo).toBe('PROMESSA_INDEVIDA');
    expect(m.agendados).toHaveLength(0);
  });

  it('revisor que responde lixo não aprova sozinho', async () => {
    const m = await pronto({ revisor: 'não sei' });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['revisao', 'agendado', 'erro']);
    expect(final?.status).toBe('revisao');
  });

  it('sem aprovação automática, até peça limpa espera uma pessoa', async () => {
    const m = await pronto();
    await m.deps.repo.upsertBrand(ORG, { autoApprove: false });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    expect((await avancarAte(m, p.id, ['revisao', 'agendado', 'erro']))?.status).toBe('revisao');
  });

  it('reels gera um clipe por cena, registra o custo e monta o vídeo final', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Servidor, este é pra você.' });
    const final = await avancarAte(m, p.id, ['agendado', 'erro', 'revisao']);
    expect(final?.status).toBe('agendado');
    expect(m.pedidos).toEqual(['req-1', 'req-2']);
    expect(final?.media).toEqual([{ mediaId: expect.any(String), kind: 'video', order: 1 }]);
    const video = m.f.spend.filter((s) => s.service === 'video');
    expect(video.map((s) => s.externalId)).toEqual(['req-1', 'req-2']);
    expect(final!.costUsd).toBeGreaterThan(5.5);
  });

  it('reels retomado não paga de novo o clipe já pedido', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    await m.run(ORG, p.id); // roteiro
    // simula queda: o primeiro clipe já tinha sido pedido e gravado
    await m.deps.repo.update(ORG, p.id, { plan: { video: { clipes: [{ ordem: 1, requestId: 'req-antigo', estado: 'pending', custoUsd: 2.77 }] } } });
    await m.run(ORG, p.id);
    expect(m.pedidos).toEqual(['req-1']); // só a cena 2
    expect((await m.deps.repo.getPiece(ORG, p.id))?.status).toBe('producao');
  });

  it('clipe moderado estorna o custo e a nova tentativa pede só aquela cena', async () => {
    const m = await pronto({ videoFalha: 'uma' });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['erro', 'producao']);
    expect(final?.status).toBe('producao');
    expect(m.pedidos).toEqual(['req-1', 'req-2', 'req-3']);
    expect(m.f.spend.some((s) => s.externalId === 'req-2:estorno' && s.costUsd < 0)).toBe(true);
  });

  it('clipe que falha sempre vira erro depois das tentativas automáticas', async () => {
    const m = await pronto({ videoFalha: 'sempre' });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['erro', 'producao']);
    expect(final?.status).toBe('erro');
    expect(final?.error).toContain('moderado');
  });

  it('peça sem canal padrão cai em erro no agendamento, com mensagem clara', async () => {
    const m = await pronto();
    await m.deps.repo.upsertBrand(ORG, { defaultChannelId: null });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['erro', 'agendado']);
    expect(final?.status).toBe('erro');
    expect(final?.error).toContain('canal padrão');
  });

  it('execução concorrente desiste quando a peça já está travada', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await m.deps.repo.claim(ORG, p.id, 'ideia', 600);
    await m.run(ORG, p.id);
    expect(m.chamadas).toHaveLength(0);
  });

  it('org alheia não executa nem enxerga a peça', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await m.run(OUTRA, p.id);
    expect(m.chamadas).toHaveLength(0);
    await expect(makeDecidePiece(m.deps)({ orgId: OUTRA, userId: 'x' }, p.id, { action: 'approve' })).rejects.toThrow('peça não encontrada');
  });
});

describe('máquina de conteúdo: decisões humanas e gasto', () => {
  it('aprovar em revisão segue para o agendamento', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'PORTUGUES_TOM', trecho: 'x', motivo: 'y' }], motivo: '' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await avancarAte(m, p.id, ['revisao']);
    const aprovada = await makeDecidePiece(m.deps)(actor, p.id, { action: 'approve' });
    expect(aprovada.status).toBe('aprovado');
    await m.run(ORG, p.id);
    expect((await m.deps.repo.getPiece(ORG, p.id))?.status).toBe('agendado');
  });

  it('refazer roteiro volta para ideia com o pedido de ajuste no prompt', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'PORTUGUES_TOM', trecho: 'x', motivo: 'y' }], motivo: '' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await avancarAte(m, p.id, ['revisao']);
    const r = await makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'roteiro', feedback: 'tirar a palavra garantido' });
    expect(r.status).toBe('ideia');
    await m.run(ORG, p.id);
    const ultimo = m.chamadas.filter((c) => c.system.includes('roteirista')).at(-1)!;
    expect(ultimo.prompt).toContain('tirar a palavra garantido');
  });

  it('decisão fora da tabela de transições é 409', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await expect(makeDecidePiece(m.deps)(actor, p.id, { action: 'approve' })).rejects.toMatchObject({ code: 'content.invalid_transition' });
    await expect(makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' })).rejects.toMatchObject({ code: 'content.invalid_transition' });
  });

  it('tentar de novo depois de falha na publicação volta para aprovado', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'PARTIAL', pubState: 'FAILED', url: null });
    expect((await makeSweepContent(m.deps)()).failed).toBe(1);
    const r = await makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' });
    expect(r.status).toBe('aprovado');
  });

  it('gasto de texto usa tokens × preço configurado', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await m.run(ORG, p.id);
    // 2 chamadas (roteiro + legenda) × (1000 × 0,25 + 500 × 2) / 1e6
    expect((await m.deps.repo.getPiece(ORG, p.id))?.costUsd).toBeCloseTo(0.0025, 6);
    expect((await makeSpendSummary(m.deps)(ORG, '2026-10')).month).toBe('2026-10');
  });
});

describe('zonedDate', () => {
  it('converte hora local para UTC', () => {
    expect(zonedDate('2026-10-05', 18, 'America/Manaus').toISOString()).toBe('2026-10-05T22:00:00.000Z');
    expect(zonedDate('2026-01-15', 9, 'America/Sao_Paulo').toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });
});
