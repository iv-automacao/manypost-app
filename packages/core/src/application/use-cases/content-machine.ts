import {
  ContentFoundationKeys,
  ErrorCodes,
  type ContentFormat,
  type ContentFoundationKey,
  type ContentPieceStatus,
  type ContentPromptName,
} from '@manypost/contracts';
import { z } from 'zod';
import { canContentTransition, isAutomatic, keywordFor } from '../../domain/content-machine/content-piece-state';
import { DomainError } from '../../domain/shared/result';
import { parseStructured } from '../ai/structured';
import type { AiProvider, BudgetGuard, TokenUsage } from '../ports/ai-provider';
import type { AuditLogRepository } from '../ports/approvals';
import type {
  BrandPalette,
  ContentBrandPatch,
  ContentBrandRecord,
  ContentMachineRepository,
  ContentPieceRecord,
  ContentRenderer,
  RenderBrand,
  VideoGenerationProvider,
} from '../ports/content-machine';
import type { JobScheduler } from '../ports/job-scheduler';
import type { MediaRepository, MediaStorage } from '../ports/media';
import type { ChannelRepository, PublishingRepository } from '../ports/publishing';
import { withBudget } from './ai-budget';
import { DEFAULT_HOOKS, DEFAULT_PROMPTS, DEFAULT_WEEK } from './content-machine-defaults';
import type { makeSchedulePost } from './publishing';

/**
 * Máquina de conteúdo (openspec add-content-machine): gestão — configuração inicial, identidade
 * visual, fundação, prompts, pauta, decisões humanas e gasto. A execução das etapas fica em
 * `content-machine-stages.ts`.
 */

export const CONTENT_MACHINE_QUEUE = 'content-machine';
export const CONTENT_SWEEP_QUEUE = 'content-machine-sweep';

export interface ContentMachineDeps {
  repo: ContentMachineRepository;
  ai: AiProvider | null;
  budget: BudgetGuard;
  renderer: ContentRenderer | null;
  video: VideoGenerationProvider | null;
  media: MediaRepository;
  storage: MediaStorage;
  channels: ChannelRepository;
  publishing: Pick<PublishingRepository, 'getGroup'>;
  schedulePost: ReturnType<typeof makeSchedulePost>;
  scheduler: JobScheduler;
  audit: AuditLogRepository;
  /** preço por milhão de tokens do modelo de texto (design D5) */
  prices: { textUsdIn: number; textUsdOut: number };
  /** rótulo do modelo de texto, só para o registro de gasto */
  textModel: string;
  videoMaxBytes: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** quanto uma execução espera o vídeo antes de soltar a peça e voltar depois */
  videoWaitMs?: number;
  log?: (level: string, msg: string, data?: object) => void;
}

export interface ContentActor {
  orgId: string;
  userId: string | null;
}

// ------------------------------------------------------------------ utilidades compartilhadas

export const agora = (deps: Pick<ContentMachineDeps, 'now'>) => deps.now?.() ?? new Date();

export const enqueuePiece = async (
  deps: Pick<ContentMachineDeps, 'scheduler' | 'log'>,
  orgId: string,
  piece: Pick<ContentPieceRecord, 'id' | 'status'>,
  startAfter?: Date,
) => {
  if (!isAutomatic(piece.status)) return;
  try {
    await deps.scheduler.enqueue(
      CONTENT_MACHINE_QUEUE,
      { orgId, pieceId: piece.id },
      {
        // uma execução por peça e etapa; o sweeper recupera o que se perder
        singletonKey: `${piece.id}:${piece.status}`,
        ...(startAfter ? { startAfter } : {}),
      },
    );
  } catch (err) {
    deps.log?.('warn', 'content-machine: enqueue falhou, o sweeper recupera', { pieceId: piece.id, err: String(err) });
  }
};

export const requireAi = (deps: Pick<ContentMachineDeps, 'ai'>): AiProvider => {
  if (!deps.ai) {
    throw new DomainError(ErrorCodes.CapabilityDisabled, 'Esta instalação não tem IA de texto configurada.');
  }
  return deps.ai;
};

export const requireRenderer = (deps: Pick<ContentMachineDeps, 'renderer'>): ContentRenderer => {
  if (!deps.renderer) {
    throw new DomainError(ErrorCodes.ContentNotConfigured, 'Renderizador de artes não configurado (CONTENT_RENDERER_URL).');
  }
  return deps.renderer;
};

export const loadBrand = async (deps: Pick<ContentMachineDeps, 'repo'>, orgId: string): Promise<ContentBrandRecord> => {
  const brand = await deps.repo.getBrand(orgId);
  if (!brand) {
    throw new DomainError(ErrorCodes.ContentNotConfigured, 'A máquina ainda não foi configurada nesta organização.');
  }
  return brand;
};

/** URLs públicas das logos: o renderizador baixa de lá */
export const renderBrandFor = async (
  deps: Pick<ContentMachineDeps, 'media' | 'storage'>,
  brand: ContentBrandRecord,
): Promise<RenderBrand> => {
  const ids = [brand.logoMediaId, brand.logoDarkMediaId].filter((x): x is string => Boolean(x));
  const registros = ids.length ? await deps.media.findMany(brand.orgId, ids) : [];
  const url = (id: string | null) => {
    const m = registros.find((r) => r.id === id);
    return m ? deps.storage.publicUrl(m.path) : null;
  };
  return {
    name: brand.name,
    logoUrl: url(brand.logoMediaId),
    logoDarkUrl: url(brand.logoDarkMediaId),
    palette: brand.palette,
    slogan: brand.slogan,
    signature: brand.signature,
  };
};

/** blocos da fundação no formato que os prompts esperam */
export const foundationText = async (
  deps: Pick<ContentMachineDeps, 'repo'>,
  orgId: string,
  keys: readonly ContentFoundationKey[],
): Promise<string> => {
  const docs = await deps.repo.listFoundations(orgId);
  return keys
    .map((k) => {
      const d = docs.find((x) => x.key === k);
      const corpo = d?.body.trim() || '(vazio)';
      const validade = k === 'produtos' && d?.validUntil ? `\n(validade da tabela: ${d.validUntil})` : '';
      return `### ${k}\n${corpo}${validade}`;
    })
    .join('\n\n');
};

/** custo de texto = tokens × preço por milhão configurado (design D5) */
export const textCost = (deps: Pick<ContentMachineDeps, 'prices'>, usage: TokenUsage): number =>
  (usage.inputTokens * deps.prices.textUsdIn + usage.outputTokens * deps.prices.textUsdOut) / 1_000_000;

/**
 * Uma chamada de texto com prompt versionado, franquia e registro de gasto. Devolve o JSON lido;
 * leitura impossível vira erro retentável — o chamador decide se tenta de novo.
 */
export async function generateJson(
  deps: ContentMachineDeps,
  ctx: { orgId: string; pieceId: string | null; brandName: string },
  name: ContentPromptName,
  input: string,
): Promise<unknown> {
  const ai = requireAi(deps);
  const prompt = await deps.repo.activePrompt(ctx.orgId, name);
  if (!prompt) {
    throw new DomainError(ErrorCodes.ContentNotConfigured, `O prompt "${name}" não existe. Rode a configuração inicial.`);
  }
  const system = prompt.system.replaceAll('{{marca}}', ctx.brandName || 'a marca');
  const resposta = await withBudget(deps.budget, { orgId: ctx.orgId, operation: `content.${name}`, credits: 1 }, async () => {
    const r = await ai.generateText({ system, prompt: input, maxTokens: 16_000, temperature: 0.7 });
    return { result: r, usage: r.usage };
  });
  await deps.repo.addSpend({
    orgId: ctx.orgId,
    pieceId: ctx.pieceId,
    service: 'texto',
    model: deps.textModel,
    externalId: crypto.randomUUID(),
    costUsd: textCost(deps, resposta.usage),
    detail: { prompt: name, versao: prompt.version, ...resposta.usage },
  });
  const lido = parseStructured(resposta.text);
  if (!lido.ok) {
    throw new DomainError(ErrorCodes.ContentGenerationFailed, `O modelo não devolveu JSON válido (${name}).`, {
      retryable: true,
    });
  }
  return lido.value;
}

/** `YYYY-MM-DD` + hora local da marca → instante UTC (sem biblioteca de fuso) */
export function zonedDate(day: string, hour: number, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const palpite = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(palpite);
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  const comoLocal = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'));
  return new Date(palpite.getTime() - (comoLocal - palpite.getTime()));
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const limparPaleta = (p: BrandPalette): BrandPalette => {
  const out: BrandPalette = {};
  for (const k of ['primaria', 'destaque', 'fundoEscuro', 'fundoClaro', 'texto', 'textoSuave'] as const) {
    const v = p[k];
    if (typeof v === 'string' && HEX.test(v)) out[k] = v.toLowerCase();
  }
  if (Array.isArray(p.extraidas)) out.extraidas = p.extraidas.filter((c) => HEX.test(c)).slice(0, 12);
  return out;
};

// ------------------------------------------------------------------ configuração e identidade

export const makeContentSetup =
  (deps: Pick<ContentMachineDeps, 'repo'>) =>
  async (orgId: string, opts?: { brandName?: string }): Promise<ContentBrandRecord> => {
    // idempotente: cada seed só cria o que falta, nunca sobrescreve o que a org editou
    const existente = await deps.repo.getBrand(orgId);
    const brand = existente ?? (await deps.repo.upsertBrand(orgId, { name: opts?.brandName ?? '' }));
    await deps.repo.seedFoundations(orgId, ContentFoundationKeys);
    await deps.repo.seedPrompts(orgId, DEFAULT_PROMPTS);
    await deps.repo.seedHooks(orgId, DEFAULT_HOOKS);
    return brand;
  };

export const makeUpdateBrand =
  (deps: Pick<ContentMachineDeps, 'repo' | 'channels' | 'media'>) =>
  async (orgId: string, patch: ContentBrandPatch): Promise<ContentBrandRecord> => {
    await loadBrand(deps, orgId);
    if (patch.defaultChannelId) {
      const [canal] = await deps.channels.findMany(orgId, [patch.defaultChannelId]);
      if (!canal) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');
    }
    for (const id of [patch.logoMediaId, patch.logoDarkMediaId]) {
      if (!id) continue;
      const [m] = await deps.media.findMany(orgId, [id]);
      if (!m || !m.mime.startsWith('image/')) throw new DomainError(ErrorCodes.NotFound, 'logo não encontrada na biblioteca');
    }
    if (patch.publishHour !== undefined && (patch.publishHour < 0 || patch.publishHour > 23)) {
      throw new DomainError(ErrorCodes.PostInvalidSettings, 'hora de publicação entre 0 e 23');
    }
    if (patch.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone });
      } catch {
        throw new DomainError(ErrorCodes.PostInvalidSettings, `fuso horário inválido: ${patch.timezone}`);
      }
    }
    return deps.repo.upsertBrand(orgId, {
      ...patch,
      ...(patch.palette ? { palette: limparPaleta(patch.palette) } : {}),
    });
  };

/** lê as cores da logo e grava como paleta sugerida (a pessoa ajusta depois) */
export const makeExtractPalette =
  (deps: Pick<ContentMachineDeps, 'repo' | 'renderer' | 'media' | 'storage'>) =>
  async (orgId: string, mediaId?: string): Promise<ContentBrandRecord> => {
    const brand = await loadBrand(deps, orgId);
    const alvo = mediaId ?? brand.logoMediaId;
    if (!alvo) throw new DomainError(ErrorCodes.PostInvalidSettings, 'envie a logo antes de extrair a paleta');
    const [m] = await deps.media.findMany(orgId, [alvo]);
    if (!m || !m.mime.startsWith('image/')) throw new DomainError(ErrorCodes.NotFound, 'imagem não encontrada');
    const lida = await requireRenderer(deps).palette({ imageUrl: deps.storage.publicUrl(m.path) });
    return deps.repo.upsertBrand(orgId, {
      palette: limparPaleta({ ...lida.suggestion, extraidas: lida.colors }),
      ...(brand.logoMediaId ? {} : { logoMediaId: alvo }),
    });
  };

export const makeUpdateFoundation =
  (deps: Pick<ContentMachineDeps, 'repo' | 'audit'>) =>
  async (actor: ContentActor, key: ContentFoundationKey, body: string, validUntil: string | null) => {
    if (validUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      throw new DomainError(ErrorCodes.PostInvalidSettings, 'validade no formato AAAA-MM-DD');
    }
    const doc = await deps.repo.upsertFoundation(actor.orgId, key, body, validUntil);
    await deps.audit
      .append({ orgId: actor.orgId, actorType: 'USER', actorId: actor.userId, action: 'content.foundation.update', targetType: 'content_foundation', targetId: key })
      .catch(() => {});
    return doc;
  };

export const makeSavePrompt =
  (deps: Pick<ContentMachineDeps, 'repo' | 'audit'>) =>
  async (actor: ContentActor, name: ContentPromptName, system: string) => {
    const texto = system.trim();
    if (texto.length < 20) throw new DomainError(ErrorCodes.PostEmptyContent, 'prompt vazio ou curto demais');
    const p = await deps.repo.savePromptVersion(actor.orgId, name, texto);
    await deps.audit
      .append({ orgId: actor.orgId, actorType: 'USER', actorId: actor.userId, action: 'content.prompt.version', targetType: 'content_prompt', targetId: `${name}@${p.version}` })
      .catch(() => {});
    return p;
  };

// ------------------------------------------------------------------ pauta e peças

const PautaSchema = z.object({
  pautas: z.array(
    z.object({
      slot_data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      formato: z.string(),
      pilar: z.string().default(''),
      icp: z.string().default(''),
      praca: z.string().default(''),
      consciencia: z.string().default(''),
      formula: z.string().default(''),
      gancho: z.string().min(1),
      angulo: z.string().default(''),
    }),
  ),
});

export interface PlanSlot {
  date: string;
  format: ContentFormat;
  pillar: string;
  icp?: string;
  market?: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** palavra-chave nova, única na org (o índice único é a garantia final) */
async function novaKeyword(deps: Pick<ContentMachineDeps, 'repo'>, orgId: string, icp: string, dia: Date, reservadas: string[]) {
  const linha = icp === 'empresario' ? 'PME' : 'PLANO';
  const mmdd = `${String(dia.getUTCMonth() + 1).padStart(2, '0')}${String(dia.getUTCDate()).padStart(2, '0')}`;
  const usadas = await deps.repo.keywordsWithPrefix(orgId, `${linha}-${mmdd}`);
  const k = keywordFor(icp, dia, [...usadas, ...reservadas]);
  reservadas.push(k);
  return k;
}

export const makePlanContentWeek =
  (deps: ContentMachineDeps) =>
  async (
    actor: ContentActor,
    input: { weekStart: string; slots?: PlanSlot[]; market?: string; channelId?: string },
  ): Promise<ContentPieceRecord[]> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)) {
      throw new DomainError(ErrorCodes.PostInvalidSettings, 'início da semana no formato AAAA-MM-DD');
    }
    const brand = await loadBrand(deps, actor.orgId);
    const slots: PlanSlot[] =
      input.slots && input.slots.length > 0
        ? input.slots
        : DEFAULT_WEEK.map((s) => ({
            date: addDays(input.weekStart, s.dayOffset),
            format: s.format,
            pillar: s.pillar,
            ...(input.market ? { market: input.market } : {}),
          }));
    if (slots.length > 14) throw new DomainError(ErrorCodes.PostInvalidSettings, 'no máximo 14 peças por pauta');

    const hooks = await deps.repo.listHooks(actor.orgId);
    const quatroSemanas = new Date(agora(deps).getTime() - 28 * 86_400_000);
    const usados = await deps.repo.hooksSince(actor.orgId, quatroSemanas);
    const entrada = [
      `FUNDAÇÃO:\n${await foundationText(deps, actor.orgId, ['icp', 'pilares', 'produtos'])}`,
      `SLOTS DA SEMANA: ${JSON.stringify(slots.map((s) => ({ slot_data: s.date, formato: s.format, pilar: s.pillar, icp: s.icp ?? '', praca: s.market ?? '' })))}`,
      `FÓRMULAS: ${JSON.stringify(hooks.map((h) => ({ nome: h.formula, molde: h.template, exemplo: h.example, pilar: h.pillar })))}`,
      `GANCHOS USADOS NAS ÚLTIMAS 4 SEMANAS: ${JSON.stringify(usados)}`,
    ].join('\n\n');

    const bruto = await generateJson(deps, { orgId: actor.orgId, pieceId: null, brandName: brand.name }, 'pauta', entrada);
    const lido = PautaSchema.safeParse(bruto);
    if (!lido.success) {
      throw new DomainError(ErrorCodes.ContentGenerationFailed, 'A pauta veio fora do formato esperado.', { retryable: true });
    }

    const criadas: ContentPieceRecord[] = [];
    const reservadas: string[] = [];
    for (const [i, slot] of slots.entries()) {
      const p = lido.data.pautas[i];
      if (!p) break;
      const icp = (slot.icp || p.icp || '').toLowerCase();
      const scheduledFor = zonedDate(slot.date, brand.publishHour, brand.timezone);
      const piece = await deps.repo.createPiece(actor.orgId, {
        format: slot.format,
        pillar: slot.pillar || p.pilar,
        icp,
        market: slot.market || p.praca || 'manaus',
        awareness: p.consciencia,
        hook: p.gancho,
        plan: { angulo: p.angulo, formula: p.formula, slot: slot.date, origem: 'pauta' },
        keyword: await novaKeyword(deps, actor.orgId, icp, new Date(`${slot.date}T12:00:00Z`), reservadas),
        scheduledFor,
        channelId: input.channelId ?? brand.defaultChannelId,
      });
      if (p.formula) await deps.repo.bumpHookUse(actor.orgId, p.formula).catch(() => {});
      criadas.push(piece);
      await enqueuePiece(deps, actor.orgId, piece);
    }
    return criadas;
  };

export const makeCreatePiece =
  (deps: ContentMachineDeps) =>
  async (
    actor: ContentActor,
    input: {
      format: ContentFormat;
      hook: string;
      angle?: string;
      pillar?: string;
      icp?: string;
      market?: string;
      scheduledFor?: Date;
      channelId?: string;
    },
  ): Promise<ContentPieceRecord> => {
    const brand = await loadBrand(deps, actor.orgId);
    const hook = input.hook.trim();
    if (!hook) throw new DomainError(ErrorCodes.PostEmptyContent, 'escreva a ideia ou o gancho da peça');
    const icp = (input.icp ?? '').toLowerCase();
    const dia = input.scheduledFor ?? agora(deps);
    const piece = await deps.repo.createPiece(actor.orgId, {
      format: input.format,
      pillar: input.pillar ?? 'educar',
      icp,
      market: input.market ?? 'manaus',
      awareness: '',
      hook,
      plan: { angulo: input.angle ?? '', origem: 'manual' },
      keyword: await novaKeyword(deps, actor.orgId, icp, dia, []),
      scheduledFor: input.scheduledFor ?? null,
      channelId: input.channelId ?? brand.defaultChannelId,
    });
    await enqueuePiece(deps, actor.orgId, piece);
    return piece;
  };

// ------------------------------------------------------------------ decisões humanas

export type ContentDecision =
  | { action: 'approve' }
  | { action: 'reject'; reason?: string }
  | { action: 'redo'; stage: 'roteiro' | 'producao'; feedback: string }
  | { action: 'retry' };

export const makeDecidePiece =
  (deps: ContentMachineDeps) =>
  async (actor: ContentActor, pieceId: string, decision: ContentDecision): Promise<ContentPieceRecord> => {
    const piece = await deps.repo.getPiece(actor.orgId, pieceId);
    if (!piece) throw new DomainError(ErrorCodes.NotFound, 'peça não encontrada');

    let destino: ContentPieceStatus;
    const patch: Parameters<ContentMachineRepository['transition']>[4] = {};
    switch (decision.action) {
      case 'approve':
        destino = 'aprovado';
        break;
      case 'reject':
        destino = 'reprovado';
        break;
      case 'redo': {
        // refazer o roteiro volta para `ideia`; refazer só a arte/vídeo volta para `roteiro`
        destino = decision.stage === 'roteiro' ? 'ideia' : 'roteiro';
        const texto = decision.feedback.trim();
        if (!texto) throw new DomainError(ErrorCodes.PostEmptyContent, 'diga o que precisa mudar');
        patch.feedback = [...piece.feedback, { at: agora(deps).toISOString(), stage: decision.stage, text: texto, by: actor.userId }];
        if (decision.stage === 'producao') patch.plan = { ...piece.plan, video: undefined };
        patch.resetAttempts = true;
        break;
      }
      case 'retry': {
        if (piece.status !== 'erro') {
          throw new DomainError(ErrorCodes.ContentInvalidTransition, 'só peças com erro podem ser tentadas de novo');
        }
        const eventos = await deps.repo.events(actor.orgId, pieceId);
        const falha = [...eventos].reverse().find((e) => e.toStatus === 'erro');
        // publicação que falhou volta para `aprovado`: reagendar não exige refazer arte nem texto
        const origem = falha?.fromStatus;
        destino = !origem || origem === 'erro' ? 'ideia' : origem === 'agendado' ? 'aprovado' : origem;
        patch.resetAttempts = true;
        break;
      }
    }
    if (!canContentTransition(piece.status, destino)) {
      throw new DomainError(ErrorCodes.ContentInvalidTransition, `a peça está em "${piece.status}" e não pode ir para "${destino}"`, {
        status: piece.status,
      });
    }
    const atualizada = await deps.repo.transition(actor.orgId, pieceId, piece.status, destino, { ...patch, error: null }, {
      stage: `humano.${decision.action}`,
      detail: { por: actor.userId, ...(decision.action === 'reject' && decision.reason ? { motivo: decision.reason } : {}) },
    });
    if (!atualizada) {
      throw new DomainError(ErrorCodes.ContentInvalidTransition, 'a peça mudou de etapa enquanto você decidia; recarregue');
    }
    await deps.audit
      .append({ orgId: actor.orgId, actorType: 'USER', actorId: actor.userId, action: `content.piece.${decision.action}`, targetType: 'content_piece', targetId: pieceId })
      .catch(() => {});
    await enqueuePiece(deps, actor.orgId, atualizada);
    return atualizada;
  };

/** ajuste manual de legenda, hashtags, data ou canal — só antes de agendar */
export const makeEditPiece =
  (deps: Pick<ContentMachineDeps, 'repo' | 'channels'>) =>
  async (
    actor: ContentActor,
    pieceId: string,
    input: { caption?: string; hashtags?: string[]; scheduledFor?: Date | null; channelId?: string | null },
  ): Promise<ContentPieceRecord> => {
    if (input.channelId) {
      const [canal] = await deps.channels.findMany(actor.orgId, [input.channelId]);
      if (!canal) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');
    }
    const editaveis: ContentPieceStatus[] = ['ideia', 'roteiro', 'producao', 'revisao', 'aprovado', 'erro', 'reprovado'];
    const r = await deps.repo.update(
      actor.orgId,
      pieceId,
      {
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.hashtags !== undefined ? { hashtags: input.hashtags.map((h) => h.replace(/^#/, '').trim()).filter(Boolean).slice(0, 5) } : {}),
        ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      },
      editaveis,
    );
    if (!r) {
      const existe = await deps.repo.getPiece(actor.orgId, pieceId);
      if (!existe) throw new DomainError(ErrorCodes.NotFound, 'peça não encontrada');
      throw new DomainError(ErrorCodes.ContentInvalidTransition, 'peça já agendada ou publicada não pode ser editada aqui');
    }
    return r;
  };

/** `YYYY-MM` → janela do mês em UTC */
export const makeSpendSummary =
  (deps: Pick<ContentMachineDeps, 'repo' | 'now'>) =>
  async (orgId: string, month?: string) => {
    const base = month && /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-01T00:00:00Z`) : agora(deps);
    const from = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const to = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
    return { month: from.toISOString().slice(0, 7), ...(await deps.repo.spendSummary(orgId, from, to)) };
  };
