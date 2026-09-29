import {
  ContentFoundationKeys,
  ErrorCodes,
  type ContentFormat,
  type ContentFoundationKey,
  type ContentPieceStatus,
  type ContentPromptName,
} from '@manypost/contracts';
import { z } from 'zod';
import { canContentTransition, isAutomatic } from '../../domain/content-machine/content-piece-state';
import { DomainError } from '../../domain/shared/result';
import { parseStructured } from '../ai/structured';
import type { AiProvider, BudgetGuard, TokenUsage } from '../ports/ai-provider';
import type { AuditLogRepository, NotificationRepository } from '../ports/approvals';
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
export const CONTENT_PLAN_QUEUE = 'content-machine-plan';

/** limite de texto do Instagram — legenda + hashtags precisam caber juntas */
export const CAPTION_TOTAL_MAX = 2200;

export interface ContentMachineDeps {
  repo: ContentMachineRepository;
  ai: AiProvider | null;
  budget: BudgetGuard;
  renderer: ContentRenderer | null;
  video: VideoGenerationProvider | null;
  media: MediaRepository;
  storage: MediaStorage;
  channels: ChannelRepository;
  publishing: Pick<PublishingRepository, 'getGroup' | 'transition' | 'refreshGroupState'>;
  schedulePost: ReturnType<typeof makeSchedulePost>;
  scheduler: JobScheduler;
  audit: AuditLogRepository;
  /** sininho do app: avisa o que falhou fora da requisição (ex.: pauta na fila) */
  notifications?: Pick<NotificationRepository, 'create'>;
  /** preço por milhão de tokens do modelo de texto (design D5) */
  prices: { textUsdIn: number; textUsdOut: number };
  /** rótulo do modelo de texto, só para o registro de gasto */
  textModel: string;
  videoMaxBytes: number;
  /** resolução pedida ao gerador de vídeo (padrão 720p) */
  videoResolution?: '480p' | '720p';
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
      // uma execução por peça e etapa; reenvio adiado não usa a chave, porque o job atual
      // (que ainda está ativo) a seguraria e o reenvio seria descartado
      startAfter ? { startAfter } : { singletonKey: `${piece.id}:${piece.status}` },
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

/** estados de publicação que ainda podem ser tirados do ar (nada saiu na rede) */
const DESCARTAVEIS = ['DRAFT', 'SCHEDULED', 'RETRYING', 'TOKEN_REFRESH', 'FAILED'] as const;

/**
 * Tira do ar o post anterior da peça (conteúdo refeito ou reprovado). Publicação em voo ou com
 * resultado incerto não pode ser desfeita: devolve quais sobraram para quem chamou decidir.
 */
export async function descartarPost(
  deps: Pick<ContentMachineDeps, 'publishing' | 'scheduler'>,
  orgId: string,
  groupId: string,
): Promise<{ pendentes: string[] }> {
  const grupo = await deps.publishing.getGroup(orgId, groupId);
  if (!grupo) return { pendentes: [] };
  const pendentes: string[] = [];
  let mudou = false;
  for (const pub of grupo.publications) {
    if ((DESCARTAVEIS as readonly string[]).includes(pub.state)) {
      // o worker pode ter pegado a publicação entre a leitura e aqui: a transição condicional perde
      const ok = await deps.publishing.transition(pub.id, [...DESCARTAVEIS], 'CANCELLED', { bumpJobVersion: true });
      if (ok) {
        mudou = true;
        await deps.scheduler.cancelBySingletonKey('publish', pub.id).catch(() => {});
      } else pendentes.push('PUBLISHING');
    } else if (pub.state === 'PUBLISHING' || pub.state === 'NEEDS_REVIEW') {
      pendentes.push(pub.state);
    }
  }
  // o estado do grupo (Quadro, calendário, alerta de parcial na home) sai das publicações
  if (mudou) await deps.publishing.refreshGroupState(grupo.id);
  return { pendentes };
}

/** id do post que a peça criou ou vai criar */
export const postDaPeca = (piece: Pick<ContentPieceRecord, 'plan' | 'postGroupId'>): string | null =>
  ((piece.plan as { agendamentoId?: string }).agendamentoId ?? piece.postGroupId) || null;

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

/** `AAAA-MM-DD` que existe no calendário (a regex sozinha aceita 2026-13-40) */
export const isCalendarDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // ano fora de 2000–2100 é erro de digitação (o Postgres recusa o ano 0; 1900 publicaria agora)
  const ano = d.getUTCFullYear();
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && ano >= 2000 && ano <= 2100;
};

/** texto que vai ao ar: legenda + hashtags, como o agendamento monta */
export const publishedText = (caption: string, hashtags: readonly string[]): string =>
  [caption.trim(), hashtags.map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n');

/**
 * Provedores em que a conta/página é escolhida por post (Instagram via Facebook Business,
 * Facebook): a máquina ainda não guarda essa escolha, então recusa antes de qualquer etapa paga.
 */
const CANAIS_SEM_SUPORTE = new Set(['instagram', 'facebook']);

export async function assertMachineChannel(deps: Pick<ContentMachineDeps, 'channels'>, orgId: string, channelId: string) {
  const [canal] = await deps.channels.findMany(orgId, [channelId]);
  if (!canal) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');
  if (CANAIS_SEM_SUPORTE.has(canal.provider)) {
    throw new DomainError(
      ErrorCodes.PostInvalidSettings,
      'A máquina ainda não publica em canais ligados pelo Facebook (a página é escolhida por post). Conecte o Instagram direto.',
      { provider: canal.provider },
    );
  }
  return canal;
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
    if (patch.defaultChannelId) await assertMachineChannel(deps, orgId, patch.defaultChannelId);
    for (const id of [patch.logoMediaId, patch.logoDarkMediaId]) {
      if (!id) continue;
      const [m] = await deps.media.findMany(orgId, [id]);
      if (!m || !m.mime.startsWith('image/')) throw new DomainError(ErrorCodes.NotFound, 'logo não encontrada na biblioteca');
    }
    for (const palavra of [patch.ctaWord, patch.ctaWordBusiness]) {
      if (palavra !== undefined && !PALAVRA_CTA.test(palavra)) {
        throw new DomainError(ErrorCodes.PostInvalidSettings, 'A palavra do CTA precisa ser uma palavra só, em maiúsculas e sem acento (ex.: PLANO).');
      }
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
    // leitura vazia (logo quase transparente) não pode apagar a paleta que a org já tem
    const papeis = Object.keys(limparPaleta(lida.suggestion)).filter((k) => k !== 'extraidas');
    if (papeis.length === 0) {
      throw new DomainError(ErrorCodes.ContentGenerationFailed, 'Não consegui ler as cores dessa imagem. Use uma logo com cores sólidas.', {
        retryable: false,
      });
    }
    return deps.repo.upsertBrand(orgId, {
      palette: limparPaleta({ ...lida.suggestion, extraidas: lida.colors }),
      ...(brand.logoMediaId ? {} : { logoMediaId: alvo }),
    });
  };

export const makeUpdateFoundation =
  (deps: Pick<ContentMachineDeps, 'repo' | 'audit'>) =>
  async (actor: ContentActor, key: ContentFoundationKey, body: string, validUntil: string | null) => {
    if (validUntil !== null && !isCalendarDate(validUntil)) {
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
  icp?: string | undefined;
  market?: string | undefined;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** públicos de empresa (CNPJ/MEI) usam a palavra de empresa; o resto, a palavra padrão */
const PUBLICOS_EMPRESA = new Set(['empresario', 'empresa', 'mei', 'pme', 'cnpj']);

/**
 * Palavra do CTA da peça ("Comenta PLANO"): simples e repetida entre peças de propósito — é o
 * gatilho que a pessoa digita e que a automação de conversa reconhece. Não identifica a peça.
 */
export const palavraDoCta = (brand: Pick<ContentBrandRecord, 'ctaWord' | 'ctaWordBusiness'>, icp: string): string =>
  PUBLICOS_EMPRESA.has(icp.toLowerCase()) ? brand.ctaWordBusiness : brand.ctaWord;

/** palavra de CTA válida: uma palavra, letras sem acento, de 3 a 15 caracteres */
export const PALAVRA_CTA = /^[A-Z]{3,15}$/;

export interface PlanWeekInput {
  weekStart: string;
  slots?: PlanSlot[] | undefined;
  market?: string | undefined;
  channelId?: string | undefined;
}

/** valida o pedido e resolve os slots (padrão da semana quando não vêm) */
async function planSlots(deps: Pick<ContentMachineDeps, 'channels'>, orgId: string, input: PlanWeekInput): Promise<PlanSlot[]> {
  if (!isCalendarDate(input.weekStart)) {
    throw new DomainError(ErrorCodes.PostInvalidSettings, 'início da semana no formato AAAA-MM-DD');
  }
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
  if (slots.some((s) => !isCalendarDate(s.date))) throw new DomainError(ErrorCodes.PostInvalidSettings, 'data de slot inválida');
  if (input.channelId) await assertMachineChannel(deps, orgId, input.channelId);
  return slots;
}

const janelaDosSlots = (slots: PlanSlot[]) => {
  const datas = slots.map((s) => s.date).sort();
  return { from: datas[0]!, to: datas[datas.length - 1]! };
};

/** slots do pedido que ainda não têm peça (mesma data e formato, fora as reprovadas) */
async function slotsQueFaltam(deps: Pick<ContentMachineDeps, 'repo'>, orgId: string, slots: PlanSlot[]) {
  const { from, to } = janelaDosSlots(slots);
  const ocupados = await deps.repo.plannedSlots(orgId, from, to);
  const restantes = [...ocupados];
  return slots.filter((s) => {
    const i = restantes.findIndex((o) => o.slot === s.date && o.format === s.format);
    if (i === -1) return true;
    restantes.splice(i, 1);
    return false;
  });
}

/**
 * Pede a pauta da semana: valida, recusa semana já planejada e enfileira. A geração roda na fila
 * (o modelo de raciocínio passa do tempo de uma requisição HTTP, e reenviar duplicaria a semana).
 */
export const makeRequestPlan =
  (deps: ContentMachineDeps) =>
  async (actor: ContentActor, input: PlanWeekInput): Promise<{ queued: true; weekStart: string }> => {
    await loadBrand(deps, actor.orgId);
    // sem modelo de texto a pauta nunca sai: recusa já, em vez de prometer e falhar na fila
    requireAi(deps);
    const slots = await planSlots(deps, actor.orgId, input);
    const { from, to } = janelaDosSlots(slots);
    if ((await slotsQueFaltam(deps, actor.orgId, slots)).length === 0) {
      throw new DomainError(ErrorCodes.ContentInvalidTransition, 'Essa semana já tem pauta. Reprove as peças que quiser refazer e peça de novo.');
    }
    await deps.scheduler.enqueue(
      CONTENT_PLAN_QUEUE,
      { orgId: actor.orgId, userId: actor.userId, input },
      // o job tenta de novo e avisa no sininho sozinho (nunca lança); a retentativa da fila só age se
      // o processo cair no meio (deploy) — seguro, porque o job só gera os slots que faltam
      { singletonKey: `${actor.orgId}:${from}:${to}`, retryLimit: 1 },
    );
    return { queued: true, weekStart: input.weekStart };
  };

export const makePlanContentWeek =
  (deps: ContentMachineDeps) =>
  async (actor: ContentActor, input: PlanWeekInput): Promise<ContentPieceRecord[]> => {
    const brand = await loadBrand(deps, actor.orgId);
    const pedidos = await planSlots(deps, actor.orgId, input);
    // idempotente: gera só os slots que ainda não têm peça (reenvio não duplica; semana parcial se completa)
    const slots = await slotsQueFaltam(deps, actor.orgId, pedidos);
    if (slots.length === 0) {
      deps.log?.('info', 'content-machine: semana já planejada, pedido ignorado', { orgId: actor.orgId, weekStart: input.weekStart });
      return [];
    }

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
        keyword: palavraDoCta(brand, icp),
        scheduledFor,
        channelId: input.channelId ?? brand.defaultChannelId,
      });
      if (p.formula) await deps.repo.bumpHookUse(actor.orgId, p.formula).catch(() => {});
      criadas.push(piece);
      await enqueuePiece(deps, actor.orgId, piece);
    }
    return criadas;
  };

/**
 * Job da pauta: uma nova tentativa para falha momentânea; se ainda assim não sair, avisa no sininho
 * (a pessoa recebeu 202 e está esperando as peças aparecerem no quadro).
 */
export const makeRunPlanJob =
  (deps: ContentMachineDeps) =>
  async (actor: ContentActor, input: PlanWeekInput): Promise<ContentPieceRecord[]> => {
    const planWeek = makePlanContentWeek(deps);
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await planWeek(actor, input);
      } catch (err) {
        const retentavel = !(err instanceof DomainError) || err.detail?.retryable === true;
        if (retentavel && tentativa < 2) continue;
        const motivo = err instanceof Error ? err.message : String(err);
        deps.log?.('warn', 'content-machine: pauta falhou', { orgId: actor.orgId, weekStart: input.weekStart, code: err instanceof DomainError ? err.code : 'unexpected' });
        await deps.notifications
          ?.create({
            orgId: actor.orgId,
            ...(actor.userId ? { userId: actor.userId } : {}),
            kind: 'content.plan_failed',
            title: `A pauta da semana de ${input.weekStart} não foi gerada`,
            body: motivo.slice(0, 500),
            link: '/maquina',
          })
          .catch(() => {});
        return [];
      }
    }
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
    if (input.channelId) await assertMachineChannel(deps, actor.orgId, input.channelId);
    const icp = (input.icp ?? '').toLowerCase();
    const piece = await deps.repo.createPiece(actor.orgId, {
      format: input.format,
      pillar: input.pillar ?? 'educar',
      icp,
      market: input.market ?? 'manaus',
      awareness: '',
      hook,
      plan: { angulo: input.angle ?? '', origem: 'manual' },
      keyword: palavraDoCta(brand, icp),
      scheduledFor: input.scheduledFor ?? null,
      channelId: input.channelId ?? brand.defaultChannelId,
    });
    await enqueuePiece(deps, actor.orgId, piece);
    return piece;
  };

// ------------------------------------------------------------------ decisões humanas

export type ContentDecision =
  | { action: 'approve' }
  | { action: 'reject'; reason?: string | undefined }
  | { action: 'redo'; stage: 'roteiro' | 'producao'; feedback: string }
  | { action: 'retry' }
  /** publicação com resultado incerto: a pessoa conferiu na rede se saiu ou não */
  | { action: 'resolvePublication'; published: boolean; permalink?: string | undefined };

export const makeDecidePiece =
  (deps: ContentMachineDeps) =>
  async (actor: ContentActor, pieceId: string, decision: ContentDecision): Promise<ContentPieceRecord> => {
    const piece = await deps.repo.getPiece(actor.orgId, pieceId);
    if (!piece) throw new DomainError(ErrorCodes.NotFound, 'peça não encontrada');

    if (decision.action === 'resolvePublication') return resolverPublicacao(deps, actor, piece, decision);

    // reprovar ou refazer tira do ar o post anterior; em voo ou incerto, resolve-se isso antes
    const postAnterior = decision.action === 'reject' || decision.action === 'redo' ? postDaPeca(piece) : null;
    // o post da peça saiu por outro caminho (ex.: "tentar novamente" no Quadro de publicações): a
    // peça é marcada como publicada, e nenhuma decisão gera uma segunda publicação
    const gidAtual = postDaPeca(piece);
    if (piece.status === 'erro' && gidAtual) {
      const pub = (await deps.publishing.getGroup(actor.orgId, gidAtual))?.publications[0];
      if (pub?.state === 'PUBLISHED') {
        await deps.repo.transition(actor.orgId, pieceId, 'erro', 'publicado', { publishedAt: agora(deps), permalink: pub.releaseUrl, error: null }, {
          stage: 'publicacao',
          detail: { conciliado: true },
        });
        throw new DomainError(ErrorCodes.ContentInvalidTransition, 'O post desta peça já saiu no Instagram. A peça foi marcada como publicada.');
      }
    }

    if (postAnterior) {
      const grupo = await deps.publishing.getGroup(actor.orgId, postAnterior);
      const pub = grupo?.publications[0];
      if (pub && (pub.state === 'PUBLISHING' || pub.state === 'NEEDS_REVIEW')) {
        throw new DomainError(
          ErrorCodes.ContentInvalidTransition,
          pub.state === 'NEEDS_REVIEW'
            ? 'A publicação anterior ficou com resultado incerto. Diga se ela saiu no Instagram antes de refazer ou reprovar.'
            : 'A publicação anterior está saindo agora. Espere terminar para decidir.',
        );
      }
    }

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
        if (decision.stage === 'producao' && !piece.script) {
          throw new DomainError(ErrorCodes.ContentInvalidTransition, 'A peça ainda não tem roteiro. Refaça o roteiro.');
        }
        patch.feedback = [...piece.feedback, { at: agora(deps).toISOString(), stage: decision.stage, text: texto, by: actor.userId }];
        // conteúdo novo: clipes, mídia e agendamento anteriores não valem mais; refazer o roteiro
        // descarta também o roteiro recusado (senão "refazer arte" produziria a partir dele)
        patch.plan = { ...piece.plan, video: undefined, agendamentoId: undefined };
        patch.postGroupId = null;
        patch.media = [];
        if (decision.stage === 'roteiro') patch.script = null;
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
        // pedido de vídeo sem confirmação: a pessoa conferiu no painel e decidiu reenviar
        const video = piece.plan.video as { clipes?: Array<{ estado: string }> } | undefined;
        if (video?.clipes?.some((c) => c.estado === 'enviando')) {
          patch.plan = { ...piece.plan, video: { ...video, clipes: video.clipes.filter((c) => c.estado !== 'enviando') } };
        }
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
    if (postAnterior) {
      const { pendentes } = await descartarPost(deps, actor.orgId, postAnterior);
      if (pendentes.length) {
        deps.log?.('warn', 'content-machine: post anterior não pôde ser descartado', { pieceId, pendentes });
      }
    }
    await deps.audit
      .append({ orgId: actor.orgId, actorType: 'USER', actorId: actor.userId, action: `content.piece.${decision.action}`, targetType: 'content_piece', targetId: pieceId })
      .catch(() => {});
    await enqueuePiece(deps, actor.orgId, atualizada);
    return atualizada;
  };

/**
 * Publicação incerta (a rede não confirmou): a pessoa diz se saiu. Saiu → publicação e peça viram
 * publicadas (com o link, se houver). Não saiu → a publicação vira falha e "tentar de novo" cria
 * um post novo, descartando este.
 */
async function resolverPublicacao(
  deps: ContentMachineDeps,
  actor: ContentActor,
  piece: ContentPieceRecord,
  d: { published: boolean; permalink?: string | undefined },
): Promise<ContentPieceRecord> {
  const gid = postDaPeca(piece);
  const grupo = gid ? await deps.publishing.getGroup(actor.orgId, gid) : null;
  const pub = grupo?.publications[0];
  if (piece.status !== 'erro' || !pub || pub.state !== 'NEEDS_REVIEW') {
    throw new DomainError(ErrorCodes.ContentInvalidTransition, 'Esta peça não tem publicação com resultado incerto.');
  }
  const link = d.permalink?.trim() || null;
  if (link && !/^https:\/\/(www\.|m\.)?instagram\.com\//.test(link)) {
    throw new DomainError(ErrorCodes.ContentInvalidInput, 'O link precisa ser de um post do Instagram (https://www.instagram.com/…).');
  }
  const agora_ = agora(deps);
  if (d.published) {
    await deps.publishing.transition(pub.id, ['NEEDS_REVIEW'], 'PUBLISHED', { publishedAt: agora_, ...(link ? { releaseUrl: link } : {}) });
    await deps.publishing.refreshGroupState(grupo!.id);
    const r = await deps.repo.transition(actor.orgId, piece.id, 'erro', 'publicado', { publishedAt: agora_, permalink: link, error: null }, {
      stage: 'humano.publicacao_confirmada',
      detail: { por: actor.userId },
    });
    if (!r) throw new DomainError(ErrorCodes.ContentInvalidTransition, 'a peça mudou de etapa enquanto você decidia; recarregue');
    return r;
  }
  await deps.publishing.transition(pub.id, ['NEEDS_REVIEW'], 'FAILED', { errorMessage: 'confirmado que não saiu na rede' });
  await deps.publishing.refreshGroupState(grupo!.id);
  const r = await deps.repo.update(actor.orgId, piece.id, { error: 'Confirmado que não saiu. Use "Tentar de novo" para publicar em um post novo.' });
  if (!r) throw new DomainError(ErrorCodes.NotFound, 'peça não encontrada');
  return r;
}

/** ajuste manual de legenda, hashtags, data ou canal — só antes de agendar */
export const makeEditPiece =
  (deps: Pick<ContentMachineDeps, 'repo' | 'channels'>) =>
  async (
    actor: ContentActor,
    pieceId: string,
    input: { caption?: string; hashtags?: string[]; scheduledFor?: Date | null; channelId?: string | null },
  ): Promise<ContentPieceRecord> => {
    const atual = await deps.repo.getPiece(actor.orgId, pieceId);
    if (!atual) throw new DomainError(ErrorCodes.NotFound, 'peça não encontrada');
    if (input.channelId) await assertMachineChannel(deps, actor.orgId, input.channelId);
    const hashtags =
      input.hashtags !== undefined
        ? [...new Set(input.hashtags.map((h) => h.replace(/^#/, '').trim()).filter(Boolean))].slice(0, 5)
        : undefined;
    const total = publishedText(input.caption ?? atual.caption, hashtags ?? atual.hashtags).length;
    if (total > CAPTION_TOTAL_MAX) {
      throw new DomainError(ErrorCodes.PostInvalidSettings, `Legenda e hashtags somam ${total} caracteres; o limite do Instagram é ${CAPTION_TOTAL_MAX}.`);
    }
    // `ideia`: o roteiro ainda vai escrever a legenda; `aprovado`: o agendamento já leu o texto
    // `reprovado` só sai para `ideia`, e o roteiro reescreve a legenda: editar ali se perderia
    const editaveis: ContentPieceStatus[] = ['roteiro', 'producao', 'revisao', 'erro'];
    const r = await deps.repo.update(
      actor.orgId,
      pieceId,
      {
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(hashtags !== undefined ? { hashtags } : {}),
        ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      },
      { onlyIn: editaveis, unlocked: true },
    );
    if (!r) {
      throw new DomainError(
        ErrorCodes.ContentInvalidTransition,
        editaveis.includes(atual.status)
          ? 'Uma etapa está rodando nesta peça. Espere terminar para ajustar.'
          : atual.status === 'reprovado'
            ? 'Peça reprovada: ao refazer o roteiro, a legenda é escrita de novo.'
            : 'Nesta etapa a peça não pode ser editada (a legenda está sendo escrita ou já foi para o agendamento).',
      );
    }
    return r;
  };

/** `YYYY-MM` → janela do mês em UTC */
export const makeSpendSummary =
  (deps: Pick<ContentMachineDeps, 'repo' | 'now'>) =>
  async (orgId: string, month?: string) => {
    const base = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? new Date(`${month}-01T00:00:00Z`) : agora(deps);
    const from = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const to = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
    return { month: from.toISOString().slice(0, 7), ...(await deps.repo.spendSummary(orgId, from, to)) };
  };
