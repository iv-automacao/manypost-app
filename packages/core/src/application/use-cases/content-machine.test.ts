import { describe, expect, it } from 'bun:test';
import type { ContentPieceStatus } from '@manypost/contracts';
import type { AiProvider, BudgetGuard } from '../ports/ai-provider';
import type {
  ContentBrandRecord,
  ContentLintFinding,
  ContentMachineRepository,
  ContentPieceEventRecord,
  ContentPieceRecord,
  ContentPromptRecord,
  ContentRenderer,
  VideoGenerationProvider,
} from '../ports/content-machine';
import type { MediaRecord } from '../ports/media';
import { DomainError } from '../../domain/shared/result';
import {
  makeContentSetup,
  makeCreatePiece,
  makeDecidePiece,
  makeEditPiece,
  makeExtractPalette,
  makePlanContentWeek,
  makeRequestPlan,
  makeRunPlanJob,
  makeSpendSummary,
  makeUpdateBrand,
  zonedDate,
  type ContentMachineDeps,
} from './content-machine';
import { makeRunContentStage, makeSweepContent, normalizeHashtag } from './content-machine-stages';

const ORG = 'org-1';
const OUTRA = 'org-2';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 56, 0, 0, 5, 70, 8, 6, 0, 0, 0]);
// ftyp mp4 mínimo reconhecido pelo sniff
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]);

/** repositório em memória com as mesmas regras de posse e condição do real */
function fakeRepo(relogio: () => Date = () => new Date()) {
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
          defaultChannelId: null, ctaChannel: 'direct', whatsappNumber: '', ctaWord: 'PLANO', ctaWordBusiness: 'EMPRESA', publishHour: 18, timezone: 'America/Manaus', autoApprove: true, updatedAt: new Date(),
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
      if (p.lockedUntil && p.lockedUntil > relogio()) return null;
      // token único por claim, como o valor de locked_until do banco
      p.lockedUntil = new Date(relogio().getTime() + leaseSec * 1000 + ++seq);
      return structuredClone(p);
    },
    async release(orgId, id, opts) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId) return false;
      if (opts.fence && p.lockedUntil?.getTime() !== opts.fence.getTime()) return false;
      aplicar(p, opts.patch ?? {});
      p.lockedUntil = opts.holdUntil ?? null;
      return true;
    },
    async transition(orgId, id, from, to, patch, event, fence) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId || p.status !== from) return null;
      if (fence && p.lockedUntil?.getTime() !== fence.getTime()) return null;
      aplicar(p, patch);
      p.status = to;
      p.lockedUntil = null;
      events.push({ id: `e${++seq}`, pieceId: id, stage: event.stage, fromStatus: from, toStatus: to, detail: event.detail ?? {}, createdAt: new Date() });
      return structuredClone(p);
    },
    async update(orgId, id, patch, opts) {
      const p = pieces.get(id);
      if (!p || p.orgId !== orgId || (opts?.onlyIn && !opts.onlyIn.includes(p.status))) return null;
      if (opts?.fence && p.lockedUntil?.getTime() !== opts.fence.getTime()) return null;
      if (opts?.unlocked && p.lockedUntil && p.lockedUntil > relogio()) return null;
      aplicar(p, patch);
      return structuredClone(p);
    },
    async plannedSlots(orgId, from, to) {
      return [...pieces.values()]
        .filter((p) => p.orgId === orgId && p.plan.origem === 'pauta' && String(p.plan.slot) >= from && String(p.plan.slot) <= to && p.status !== 'reprovado')
        .map((p) => ({ slot: String(p.plan.slot), format: p.format }));
    },
    async events(orgId, pieceId) {
      return events.filter((e) => e.pieceId === pieceId && pieces.get(pieceId)?.orgId === orgId);
    },
    async stalled() {
      return [];
    },
    async erroredWithPost() {
      return [...pieces.values()]
        .filter((p) => p.status === 'erro' && ((p.plan as { agendamentoId?: string }).agendamentoId ?? p.postGroupId))
        .map((p) => ({ orgId: p.orgId, id: p.id, postGroupId: ((p.plan as { agendamentoId?: string }).agendamentoId ?? p.postGroupId)! }));
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

function montar(
  opts: {
    revisor?: unknown;
    lintErro?: boolean;
    videoFalha?: 'uma' | 'sempre';
    /** erro lançado pelo submit do vídeo na N-ésima chamada (1 = primeira) */
    submitErro?: { chamada: number; erro: Error };
    slides?: number;
    agendarFalhaDepoisDeCriar?: boolean;
  } = {},
) {
  const relogio = { agora: new Date('2026-10-01T12:00:00Z') };
  const f = fakeRepo(() => relogio.agora);
  const { ai, chamadas } = fakeAi({
    pauta: () => ({
      pautas: [
        { slot_data: '2026-10-05', formato: 'carrossel', pilar: 'educar', icp: 'familia', praca: 'manaus', consciencia: 'problema', formula: 'Ninguém te conta', gancho: 'Ninguém te conta onde fica o PS.', angulo: 'rede de urgência' },
        { slot_data: '2026-10-07', formato: 'reels', pilar: 'dor_objecao', icp: 'empresario', praca: 'manaus', consciencia: 'solucao', formula: 'A objeção', gancho: '"Plano PME é caro." Veja.', angulo: 'MEI' },
      ],
    }),
    roteiro: (entrada) =>
      entrada.includes('"formato":"reels"')
        ? roteiroReels
        : opts.slides
          ? { ...roteiroCarrossel, slides: Array.from({ length: opts.slides }, (_, i) => ({ ordem: i + 1, tipo: i === 0 ? 'capa' : 'ideia', titulo: `S${i + 1}`, texto: '', itens: [] })) }
          : roteiroCarrossel,
    legenda: () => ({ legenda: 'Primeira linha.\n\nCorpo.', hashtags: ['#planodesaudemanaus', 'saude'], cta: 'x' }),
    revisor: (entrada) =>
      typeof opts.revisor === 'function' ? (opts.revisor as (e: string) => unknown)(entrada) : (opts.revisor ?? { aprovado: true, flags: [], motivo: '' }),
  });
  const media: MediaRecord[] = [];
  let lintChamadas = 0;
  const renderer: ContentRenderer = {
    async render(req) {
      return (req.format === 'carrossel' ? req.slides : [1]).map(() => ({ bytes: PNG, width: 1080, height: 1350 }));
    },
    async lint(req) {
      lintChamadas++;
      const erro = Boolean(opts.lintErro) && lintChamadas === 1;
      const findings: ContentLintFinding[] = erro ? [{ nivel: 'erro', codigo: 'SEM_CTA', msg: 'sem palavra-chave' }] : [];
      return { script: req.script, caption: req.caption, hashtags: req.hashtags.slice(0, 5), findings, hasError: erro };
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
      if (opts.submitErro && pedidos.length === opts.submitErro.chamada) throw opts.submitErro.erro;
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
  const refreshs: string[] = [];
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
      findMany: async (orgId: string, ids: string[]) =>
        orgId === ORG
          ? ids
              .filter((i) => i === 'canal-ig' || i === 'canal-fb')
              .map((id) => ({ id, provider: id === 'canal-fb' ? 'instagram' : 'instagram-standalone', name: '@teste' }))
          : [],
    } as unknown as ContentMachineDeps['channels'],
    publishing: {
      getGroup: async (_o, id) => {
        const g = grupos.get(id);
        // id da publicação = id do grupo (um canal por post na máquina)
        return g ? ({ id, state: g.state, publishAt: null, timezone: 'UTC', baseContent: {}, publications: [{ id, state: g.pubState, releaseUrl: g.url, errorMessage: null }] } as never) : null;
      },
      // como no repositório real: a transição mexe só na publicação; o grupo muda no refresh
      transition: async (pubId, from, to, patch) => {
        const g = grupos.get(pubId);
        if (!g || !(from as string[]).includes(g.pubState)) return false;
        g.pubState = to;
        if (patch?.releaseUrl) g.url = patch.releaseUrl;
        return true;
      },
      refreshGroupState: async (groupId) => {
        const g = grupos.get(groupId);
        if (!g) return;
        refreshs.push(groupId);
        g.state = g.pubState === 'CANCELLED' ? 'CANCELLED' : g.pubState === 'PUBLISHED' ? 'DONE' : g.pubState === 'FAILED' || g.pubState === 'NEEDS_REVIEW' ? 'PARTIAL' : 'SCHEDULED';
      },
    },
    schedulePost: (async (input: Record<string, unknown>) => {
      agendados.push(input);
      const id = (input.groupId as string | undefined) ?? `grupo-${agendados.length}`;
      grupos.set(id, { state: 'SCHEDULED', pubState: 'SCHEDULED', url: null });
      // simula queda depois do commit do post (aviso/getGroup falhando)
      if (opts.agendarFalhaDepoisDeCriar && agendados.length === 1) throw new Error('conexão caiu depois do commit');
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
    now: () => relogio.agora,
  };
  return { f, deps, chamadas, media, pedidos, enfileirados, agendados, grupos, refreshs, relogio, run: makeRunContentStage(deps) };
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
    // passa das esperas de retentativa (a trava fica no banco até lá)
    m.relogio.agora = new Date(m.relogio.agora.getTime() + 10 * 60_000);
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
    // palavra simples por público: repetida entre peças, empresa tem a sua
    expect(pecas.map((p) => p.keyword)).toEqual(['PLANO', 'EMPRESA']);
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

  it('SEM_CTA do revisor é descartado quando a legenda tem a palavra-chave exata', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'SEM_CTA', trecho: 'x', motivo: 'não se aplica' }], motivo: '' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await m.run(ORG, p.id);
    await m.deps.repo.update(ORG, p.id, { caption: `Manda ${p.keyword} no direct` });
    const final = await avancarAte(m, p.id, ['revisao', 'agendado', 'erro']);
    expect(final?.status).toBe('agendado');
  });

  it('revisor que responde lixo não aprova sozinho', async () => {
    const m = await pronto({ revisor: 'não sei' });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['revisao', 'agendado', 'erro']);
    expect(final?.status).toBe('revisao');
  });

  it('JSON quebrado do revisor ganha uma segunda chamada na hora', async () => {
    let chamadas = 0;
    const m = await pronto({
      revisor: () => (++chamadas === 1 ? '{"aprovado": true, "flags": [], "motivo": "trecho "citado""}' : { aprovado: true, flags: [], motivo: '' }),
    });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['revisao', 'agendado', 'erro']);
    expect(chamadas).toBe(2);
    expect(final?.status).toBe('agendado');
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

  it('agendamento retentado reaproveita o post já criado', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await avancarAte(m, p.id, ['aprovado']);
    // simula a queda: o post foi criado e o id gravado, mas o status não mudou
    m.grupos.set('grupo-existente', { state: 'SCHEDULED', pubState: 'SCHEDULED', url: null });
    await m.deps.repo.update(ORG, p.id, { postGroupId: 'grupo-existente' });
    await m.run(ORG, p.id);
    const final = await m.deps.repo.getPiece(ORG, p.id);
    expect(final?.status).toBe('agendado');
    expect(final?.postGroupId).toBe('grupo-existente');
    expect(m.agendados).toHaveLength(0);
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


describe('máquina de conteúdo: regressões da revisão adversarial', () => {
  it('refazer roteiro de reels descarta os clipes antigos e gera vídeo novo', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'PORTUGUES_TOM', trecho: 'x', motivo: 'y' }], motivo: '' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    await avancarAte(m, p.id, ['revisao']);
    expect(m.pedidos).toEqual(['req-1', 'req-2']);
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'roteiro', feedback: 'narração mais calma' });
    expect((await m.deps.repo.getPiece(ORG, p.id))?.plan.video).toBeUndefined();
    await avancarAte(m, p.id, ['revisao', 'erro']);
    expect(m.pedidos).toEqual(['req-1', 'req-2', 'req-3', 'req-4']);
  });

  it('tentar de novo depois de publicação que falhou cria um post novo (não reusa o que falhou)', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'PARTIAL', pubState: 'FAILED', url: null });
    await makeSweepContent(m.deps)();
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' });
    const final = await avancarAte(m, p.id, ['agendado', 'erro']);
    expect(final?.status).toBe('agendado');
    expect(m.agendados).toHaveLength(2);
    expect(final?.postGroupId).not.toBe(ag!.postGroupId);
  });

  it('publicação com resultado incerto vai para erro e não é reenviada sozinha', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'SCHEDULED', pubState: 'NEEDS_REVIEW', url: null });
    expect((await makeSweepContent(m.deps)()).failed).toBe(1);
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' });
    const final = await avancarAte(m, p.id, ['agendado', 'erro']);
    expect(final?.status).toBe('erro');
    expect(final?.error).toContain('resultado incerto');
    expect(m.agendados).toHaveLength(1);
  });

  it('queda depois de criar o post: a retentativa encontra o mesmo post pelo id escolhido antes', async () => {
    const m = await pronto({ agendarFalhaDepoisDeCriar: true });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['agendado', 'erro']);
    expect(final?.status).toBe('agendado');
    expect(m.agendados).toHaveLength(1);
    expect(final?.postGroupId).toBe(m.agendados[0]!.groupId as string);
  });

  it('execução velha que perdeu a posse (reprovar + refazer no meio) não grava por cima', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const velha = await m.deps.repo.claim(ORG, p.id, 'ideia', 600);
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'reject' });
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'roteiro', feedback: 'outro ângulo' });
    // a execução velha tenta concluir com o token antigo
    const r = await m.deps.repo.transition(ORG, p.id, 'ideia', 'roteiro', { caption: 'velha' }, { stage: 'roteiro' }, velha!.lockedUntil);
    expect(r).toBeNull();
    expect(await m.deps.repo.release(ORG, p.id, { fence: velha!.lockedUntil })).toBe(false);
    expect((await m.deps.repo.getPiece(ORG, p.id))?.caption).toBe('');
  });

  it('retentativa espera no banco: job duplicado não pega a peça antes da hora', async () => {
    const m = await pronto({ videoFalha: 'sempre' });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    await m.run(ORG, p.id); // roteiro
    await m.run(ORG, p.id); // vídeo: cena 2 falha → espera
    const antes = m.pedidos.length;
    await m.run(ORG, p.id); // duplicado imediato
    expect(m.pedidos.length).toBe(antes);
    expect((await m.deps.repo.getPiece(ORG, p.id))?.lockedUntil?.getTime()).toBeGreaterThan(m.relogio.agora.getTime());
  });

  it('envio de vídeo sem confirmação para a peça em vez de pagar de novo', async () => {
    const m = await pronto({ submitErro: { chamada: 2, erro: new DomainError('ai.provider_failed', 'tempo esgotado', { retryable: true }) } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['erro', 'producao']);
    expect(final?.status).toBe('erro');
    expect(final?.error).toContain('não teve confirmação');
    expect(m.pedidos).toEqual(['req-1', 'req-2']);
    // a pessoa conferiu e mandou tentar de novo: só a cena incerta é reenviada
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' });
    const depois = await avancarAte(m, p.id, ['producao', 'erro']);
    expect(depois?.status).toBe('producao');
    expect(m.pedidos).toEqual(['req-1', 'req-2', 'req-3']);
  });

  it('recusa definitiva no envio (saldo) vai direto para erro, sem retentativas', async () => {
    const m = await pronto({ submitErro: { chamada: 1, erro: new DomainError('ai.provider_failed', 'status 402', { retryable: false }) } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    await m.run(ORG, p.id);
    await m.run(ORG, p.id);
    const final = await m.deps.repo.getPiece(ORG, p.id);
    expect(final?.status).toBe('erro');
    expect((final?.plan.video as { clipes: unknown[] }).clipes).toHaveLength(0);
  });

  it('gasto de clipe salvo sem registro é conciliado na execução seguinte', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'reels', hook: 'Gancho' });
    await m.run(ORG, p.id);
    await m.deps.repo.update(ORG, p.id, { plan: { video: { clipes: [{ ordem: 1, requestId: 'req-perdido', estado: 'pending', custoUsd: 2.77 }] } } });
    await m.run(ORG, p.id);
    expect(m.f.spend.some((s) => s.externalId === 'req-perdido' && s.costUsd === 2.77)).toBe(true);
  });

  it('carrossel com mais de 10 slides sai com 10 (9 primeiros + o final)', async () => {
    const m = await pronto({ slides: 12 });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'carrossel', hook: 'Gancho' });
    const final = await avancarAte(m, p.id, ['producao', 'revisao', 'agendado', 'erro']);
    expect(final?.media.length).toBeLessThanOrEqual(10);
  });

  it('canal de outra org ou via Facebook é recusado antes de qualquer etapa paga', async () => {
    const m = await pronto();
    await expect(makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'G', channelId: 'canal-de-outra-org' })).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'G', channelId: 'canal-fb' })).rejects.toThrow('Facebook');
    expect(m.chamadas).toHaveLength(0);
  });

  it('edição recusada em ideia, durante etapa e acima de 2200 caracteres', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'X', trecho: '', motivo: '' }], motivo: '' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await expect(makeEditPiece(m.deps)(actor, p.id, { caption: 'minha' })).rejects.toMatchObject({ code: 'content.invalid_transition' });
    await avancarAte(m, p.id, ['revisao']);
    await expect(makeEditPiece(m.deps)(actor, p.id, { caption: 'x'.repeat(2190), hashtags: ['umahashtaglonga'] })).rejects.toThrow('2200');
    await m.deps.repo.claim(ORG, p.id, 'revisao', 600);
    await expect(makeEditPiece(m.deps)(actor, p.id, { caption: 'ok' })).rejects.toThrow('etapa está rodando');
  });

  it('refazer arte sem roteiro é recusado', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await m.deps.repo.transition(ORG, p.id, 'ideia', 'erro', { error: 'x' }, { stage: 'roteiro' });
    await expect(makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'producao', feedback: 'arte' })).rejects.toThrow('roteiro');
  });

  it('pauta vai para a fila e semana já planejada é recusada; o job é idempotente', async () => {
    const m = await pronto();
    const pedido = { weekStart: '2026-10-05' };
    expect(await makeRequestPlan(m.deps)(actor, pedido)).toEqual({ queued: true, weekStart: '2026-10-05' });
    expect(m.enfileirados.at(-1)?.queue).toBe('content-machine-plan');
    // o modelo devolveu só 2 pautas para os 4 slots: a semana fica parcial...
    expect(await makePlanContentWeek(m.deps)(actor, pedido)).toHaveLength(2);
    // ...e um novo pedido completa só o que falta, sem duplicar
    expect(await makeRequestPlan(m.deps)(actor, pedido)).toEqual({ queued: true, weekStart: '2026-10-05' });
    expect(await makePlanContentWeek(m.deps)(actor, pedido)).toHaveLength(2);
    expect(await makePlanContentWeek(m.deps)(actor, pedido)).toEqual([]);
    await expect(makeRequestPlan(m.deps)(actor, pedido)).rejects.toMatchObject({ code: 'content.invalid_transition' });
    const slots = [...m.f.pieces.values()].map((p) => `${p.plan.slot}:${p.format}`).sort();
    expect(slots).toEqual(['2026-10-05:carrossel', '2026-10-07:reels', '2026-10-08:carrossel', '2026-10-10:post']);
    await expect(makeRequestPlan(m.deps)(actor, { weekStart: '2026-13-40' })).rejects.toThrow('AAAA-MM-DD');
  });

  it('pauta sem modelo de texto é recusada na hora; falha no job vira aviso no sininho', async () => {
    const m = await pronto();
    const avisos: Array<{ title: string }> = [];
    m.deps.notifications = { create: async (n) => void avisos.push(n) };
    const semAi = { ...m.deps, ai: null };
    await expect(makeRequestPlan(semAi)(actor, { weekStart: '2026-10-05' })).rejects.toMatchObject({ code: 'capability.disabled' });
    await makeRunPlanJob(semAi)(actor, { weekStart: '2026-10-05' });
    expect(avisos[0]?.title).toContain('não foi gerada');
  });

  it('refazer roteiro descarta o roteiro e a mídia recusados', async () => {
    const m = await pronto({ revisor: { aprovado: false, flags: [{ codigo: 'X', trecho: '', motivo: '' }], motivo: '' } });
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    await avancarAte(m, p.id, ['revisao']);
    const r = await makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'roteiro', feedback: 'outro ângulo' });
    expect(r.script).toBeNull();
    expect(r.media).toEqual([]);
  });

  it('data fora de 2000–2100 é recusada', async () => {
    const m = await pronto();
    await expect(makeRequestPlan(m.deps)(actor, { weekStart: '0000-01-03' })).rejects.toThrow('AAAA-MM-DD');
  });

  it('post que falhou é descartado quando a máquina cria o novo (nada para "tentar de novo" no Quadro)', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'PARTIAL', pubState: 'FAILED', url: null });
    await makeSweepContent(m.deps)();
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' });
    await avancarAte(m, p.id, ['agendado', 'erro']);
    expect(m.grupos.get(ag!.postGroupId!)?.pubState).toBe('CANCELLED');
    // o grupo é recalculado: o Quadro não mostra o post descartado como publicado
    expect(m.refreshs).toContain(ag!.postGroupId!);
    expect(m.grupos.get(ag!.postGroupId!)?.state).toBe('CANCELLED');
  });

  it('peça em erro cujo post saiu pelo Quadro é conciliada como publicada (sweeper e decisão)', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'PARTIAL', pubState: 'FAILED', url: null });
    await makeSweepContent(m.deps)();
    // alguém clicou "tentar novamente" no Quadro e o post saiu
    m.grupos.set(ag!.postGroupId!, { state: 'DONE', pubState: 'PUBLISHED', url: 'https://www.instagram.com/p/xyz/' });
    await expect(makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'producao', feedback: 'x' })).rejects.toThrow('já saiu');
    const r = await m.deps.repo.getPiece(ORG, p.id);
    expect(r?.status).toBe('publicado');
    expect(r?.permalink).toBe('https://www.instagram.com/p/xyz/');
    expect(m.agendados).toHaveLength(1);
  });

  it('sweeper concilia sozinho a peça em erro cujo post saiu', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'PARTIAL', pubState: 'FAILED', url: null });
    await makeSweepContent(m.deps)();
    m.grupos.set(ag!.postGroupId!, { state: 'DONE', pubState: 'PUBLISHED', url: 'https://www.instagram.com/p/abc/' });
    expect((await makeSweepContent(m.deps)()).published).toBe(1);
    expect((await m.deps.repo.getPiece(ORG, p.id))?.status).toBe('publicado');
  });

  it('reprovar peça em erro com post ainda agendado tira o post do ar', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    // a transição para agendado se perdeu: peça em erro, post vivo
    await m.deps.repo.transition(ORG, p.id, 'agendado', 'erro', { error: 'x' }, { stage: 'teste' });
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'reject' });
    expect(m.grupos.get(ag!.postGroupId!)?.pubState).toBe('CANCELLED');
  });

  it('publicação incerta: confirmar que saiu fecha a peça como publicada, com o link', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'SCHEDULED', pubState: 'NEEDS_REVIEW', url: null });
    await makeSweepContent(m.deps)();
    await expect(makeDecidePiece(m.deps)(actor, p.id, { action: 'redo', stage: 'roteiro', feedback: 'x' })).rejects.toThrow('resultado incerto');
    await expect(
      makeDecidePiece(m.deps)(actor, p.id, { action: 'resolvePublication', published: true, permalink: 'https://instagr.am/p/abc' }),
    ).rejects.toMatchObject({ code: 'content.invalid_input' });
    const r = await makeDecidePiece(m.deps)(actor, p.id, { action: 'resolvePublication', published: true, permalink: 'https://www.instagram.com/p/abc/' });
    expect(r.status).toBe('publicado');
    expect(m.grupos.get(ag!.postGroupId!)?.state).toBe('DONE');
    expect(r.permalink).toBe('https://www.instagram.com/p/abc/');
    expect(m.grupos.get(ag!.postGroupId!)?.pubState).toBe('PUBLISHED');
  });

  it('publicação incerta: "não saiu" permite tentar de novo em um post novo', async () => {
    const m = await pronto();
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho' });
    const ag = await avancarAte(m, p.id, ['agendado']);
    m.grupos.set(ag!.postGroupId!, { state: 'SCHEDULED', pubState: 'NEEDS_REVIEW', url: null });
    await makeSweepContent(m.deps)();
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'resolvePublication', published: false });
    expect(m.grupos.get(ag!.postGroupId!)?.pubState).toBe('FAILED');
    await makeDecidePiece(m.deps)(actor, p.id, { action: 'retry' });
    const final = await avancarAte(m, p.id, ['agendado', 'erro']);
    expect(final?.status).toBe('agendado');
    expect(final?.postGroupId).not.toBe(ag!.postGroupId);
    expect(m.grupos.get(ag!.postGroupId!)?.pubState).toBe('CANCELLED');
  });

  it('CTA de comentário: o roteiro recebe a mecânica e a arte recebe a palavra para destacar', async () => {
    const m = await pronto();
    await m.deps.repo.upsertBrand(ORG, { ctaChannel: 'comentario', ctaWord: 'SAUDE' });
    let renderPedido: { keyword?: string; cta: string } | null = null;
    const original = m.deps.renderer!.render;
    m.deps.renderer = { ...m.deps.renderer!, render: async (req) => ((renderPedido = req), original(req)) };
    const p = await makeCreatePiece(m.deps)(actor, { format: 'post', hook: 'Gancho', icp: 'familia' });
    expect(p.keyword).toBe('SAUDE');
    await avancarAte(m, p.id, ['producao', 'revisao', 'agendado']);
    expect(m.chamadas.find((c) => c.system.includes('roteirista'))?.prompt).toContain('comentario (a pessoa comenta');
    expect(renderPedido!.keyword).toBe('SAUDE');
  });

  it('palavra do CTA inválida é recusada na identidade', async () => {
    const m = await pronto();
    await expect(makeUpdateBrand(m.deps)(ORG, { ctaWord: 'SAÚDE' })).rejects.toThrow('sem acento');
    await expect(makeUpdateBrand(m.deps)(ORG, { ctaWord: 'plano de saude' })).rejects.toThrow('uma palavra');
    expect((await makeUpdateBrand(m.deps)(ORG, { ctaWord: 'SAUDE' })).ctaWord).toBe('SAUDE');
  });

  it('extração de paleta vazia não apaga a paleta salva', async () => {
    const m = await pronto();
    await m.deps.repo.upsertBrand(ORG, { palette: { primaria: '#0073ca' } });
    const logo = await m.deps.media.create({ orgId: ORG, path: `${ORG}/l.png`, mime: 'image/png', byteSize: 1, width: 1, height: 1, alt: null });
    m.deps.renderer = { ...m.deps.renderer!, palette: async () => ({ colors: [], suggestion: {} }) };
    await expect(makeExtractPalette(m.deps)(ORG, logo.id)).rejects.toThrow('cores');
    expect(m.f.brand?.palette.primaria).toBe('#0073ca');
  });
});

describe('normalizeHashtag', () => {
  it('tira espaço, acento e pontuação', () => {
    expect(normalizeHashtag('#Rede de Urgência')).toBe('rededeurgencia');
    expect(normalizeHashtag('plano-de-saúde!')).toBe('planodesaude');
  });
});

describe('zonedDate', () => {
  it('converte hora local para UTC', () => {
    expect(zonedDate('2026-10-05', 18, 'America/Manaus').toISOString()).toBe('2026-10-05T22:00:00.000Z');
    expect(zonedDate('2026-01-15', 9, 'America/Sao_Paulo').toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });
});
