/**
 * Regras puras da área Máquina (sem React, sem rede) — o que os testes cobrem.
 *
 * O vocabulário fechado (status, formatos, chaves) vem dos tipos do cliente OpenAPI; os valores
 * em runtime são repetidos aqui porque `apps/web` não carrega `@manypost/contracts` no bundle.
 * A paridade com o contrato é assertada em `logic.test.ts`.
 */
import { addDays, dayKey, startOfWeek, toLocalInput } from '@/lib/datetime';
import type {
  BrandPatch,
  ContentBrand,
  ContentPalette,
  ContentPiece,
  ContentPrompt,
  ContentSpend,
  FoundationKey,
  PaletteRole,
  PieceFormat,
  PieceMedia,
  PieceStatus,
  PromptName,
} from './types';

export const STATUSES = [
  'ideia',
  'roteiro',
  'producao',
  'revisao',
  'aprovado',
  'agendado',
  'publicado',
  'reprovado',
  'erro',
] as const satisfies readonly PieceStatus[];

/** colunas do quadro, na ordem da esteira */
export const BOARD_COLUMNS = [
  'ideia',
  'roteiro',
  'producao',
  'revisao',
  'aprovado',
  'agendado',
  'publicado',
] as const satisfies readonly PieceStatus[];
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** fora da esteira: ficam numa seção recolhível abaixo do quadro */
export const SIDE_GROUPS = ['erro', 'reprovado'] as const satisfies readonly PieceStatus[];
export type SideGroup = (typeof SIDE_GROUPS)[number];

export const FORMATS = ['carrossel', 'post', 'story', 'reels'] as const satisfies readonly PieceFormat[];

export const FOUNDATION_KEYS = [
  'produtos',
  'icp',
  'personagem',
  'marca',
  'escada',
  'pilares',
] as const satisfies readonly FoundationKey[];

export const PROMPT_NAMES = ['pauta', 'roteiro', 'legenda', 'revisor'] as const satisfies readonly PromptName[];

/** mercados aceitos pela pauta (espelho de `ContentMarkets` do contrato) */
export const MARKETS = ['manaus', 'boa_vista', 'belem', 'nacional'] as const;
export type Market = (typeof MARKETS)[number];

export const PALETTE_ROLES = [
  'primaria',
  'destaque',
  'fundoEscuro',
  'fundoClaro',
  'texto',
  'textoSuave',
] as const satisfies readonly PaletteRole[];

/** seções da área, cada uma com a sua rota em `app/(app)/maquina` */
export const SECTIONS = [
  { key: 'board', href: '/maquina' },
  { key: 'identity', href: '/maquina/identidade' },
  { key: 'foundation', href: '/maquina/fundacao' },
  { key: 'prompts', href: '/maquina/prompts' },
  { key: 'spend', href: '/maquina/gastos' },
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];

/** seção ativa pelo pathname; `/maquina` e qualquer rota desconhecida caem no quadro */
export function sectionFor(pathname: string): SectionKey {
  const path = pathname.replace(/\/+$/, '');
  const hit = SECTIONS.find((s) => s.key !== 'board' && (path === s.href || path.startsWith(`${s.href}/`)));
  return hit?.key ?? 'board';
}

/** status com etapa automática: a fila executa sozinha, então a tela precisa acompanhar */
const AUTOMATIC: ReadonlySet<PieceStatus> = new Set(['ideia', 'roteiro', 'producao', 'aprovado']);

export const isAutomatic = (status: PieceStatus): boolean => AUTOMATIC.has(status);

export const POLL_ACTIVE_MS = 5_000;
export const POLL_IDLE_MS = 60_000;

/** a pauta é gerada na fila: depois do pedido, o quadro acompanha de perto por ~2 min */
export const PLAN_POLL_WINDOW_MS = 2 * 60_000;

/**
 * Intervalo de polling do quadro: rápido enquanto alguma peça anda sozinha (ou tem etapa
 * rodando), lento quando tudo espera uma pessoa — o agendado→publicado ainda muda no servidor.
 * `fastUntil` (epoch ms) força o rápido até lá — a pauta pedida ainda não virou peça nenhuma.
 */
export function pollInterval(
  pieces: readonly Pick<ContentPiece, 'status' | 'running'>[] | undefined,
  fastUntil = 0,
  now = Date.now(),
): number {
  if (now < fastUntil) return POLL_ACTIVE_MS;
  if (!pieces) return POLL_IDLE_MS;
  return pieces.some((p) => p.running || isAutomatic(p.status)) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/** peças agrupadas por status; cada grupo mantém a ordem da API (mais recentes primeiro) */
export function groupByStatus<T extends Pick<ContentPiece, 'status' | 'scheduledFor'>>(
  pieces: readonly T[],
): Record<PieceStatus, T[]> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, [] as T[]])) as Record<PieceStatus, T[]>;
  for (const p of pieces) out[p.status].push(p);
  // agendado lê melhor na ordem em que vai ao ar
  out.agendado.sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''));
  return out;
}

export type PieceAction = 'approve' | 'reject' | 'redoScript' | 'redoProduction' | 'retry';

function actionsByStatus(status: PieceStatus): PieceAction[] {
  switch (status) {
    case 'revisao':
      return ['approve', 'redoScript', 'redoProduction', 'reject'];
    case 'erro':
      return ['retry', 'redoScript', 'redoProduction', 'reject'];
    case 'reprovado':
      return ['redoScript'];
    case 'ideia':
    case 'roteiro':
    case 'producao':
      return ['reject'];
    default:
      return [];
  }
}

/**
 * Ações humanas da peça. Espelha a tabela de transições do domínio: aprovar e refazer só onde
 * a transição existe; reprovar descarta o que ainda não foi agendado; reprovada só reabre pelo
 * roteiro. Agendado e publicado não têm ação aqui. Refazer arte/vídeo produz de novo a partir do
 * roteiro gravado: peça que falhou antes de ter roteiro não oferece (o backend também recusa).
 */
export function actionsFor(piece: Pick<ContentPiece, 'status' | 'script'>, publicationState?: string | null): PieceAction[] {
  // publicação incerta: antes de qualquer decisão a pessoa diz se o post saiu (o backend recusa o resto)
  if (needsPublicationCheck(piece, publicationState)) return [];
  const actions = actionsByStatus(piece.status);
  return piece.script ? actions : actions.filter((a) => a !== 'redoProduction');
}

/** a rede não confirmou a publicação: só uma pessoa, olhando o perfil, sabe se saiu */
export function needsPublicationCheck(piece: Pick<ContentPiece, 'status'>, publicationState?: string | null): boolean {
  return piece.status === 'erro' && publicationState === 'NEEDS_REVIEW';
}

/**
 * Por que legenda, hashtags e data não podem ser editadas agora (`null` = podem). Espelha a
 * recusa do backend (409 `content.invalid_transition`):
 * - `closed`: agendada ou publicada — o texto já está no post;
 * - `running`: uma etapa está rodando e vai ler ou reescrever a peça;
 * - `ideia`: a etapa Roteiro ainda vai escrever a legenda;
 * - `aprovado`: o agendamento já leu o texto.
 */
export type CaptionLock = 'closed' | 'running' | 'ideia' | 'aprovado';

export function captionLock(piece: Pick<ContentPiece, 'status' | 'running'>): CaptionLock | null {
  if (piece.status === 'agendado' || piece.status === 'publicado') return 'closed';
  if (piece.running) return 'running';
  if (piece.status === 'ideia' || piece.status === 'aprovado') return piece.status;
  return null;
}

/** mídias com URL, na ordem do carrossel */
export function orderedMedia(media: readonly PieceMedia[]): (PieceMedia & { url: string })[] {
  return [...media]
    .filter((m): m is PieceMedia & { url: string } => typeof m.url === 'string' && m.url.length > 0)
    .sort((a, b) => a.order - b.order);
}

/** capa do card: a primeira mídia (imagem ou vídeo) */
export function coverOf(piece: Pick<ContentPiece, 'media'>): (PieceMedia & { url: string }) | null {
  return orderedMedia(piece.media)[0] ?? null;
}

export const flagsCount = (piece: Pick<ContentPiece, 'review'>): number => piece.review?.flags.length ?? 0;

/** "#a #b, c" → ["a","b","c"]: sem #, sem repetição, no máximo 5 (limite da API) */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 5);
}

export const formatHashtags = (tags: readonly string[]): string => tags.map((t) => `#${t}`).join(' ');

/** limite do Instagram para o texto publicado inteiro — legenda e hashtags contam juntas */
export const CAPTION_TOTAL_MAX = 2200;

/** texto que vai ao ar, montado como o agendamento monta (espelho de `publishedText` do core) */
export const publishedText = (caption: string, hashtags: readonly string[]): string =>
  [caption.trim(), formatHashtags(hashtags)].filter(Boolean).join('\n\n');

// ------------------------------------------------------------------ rascunho da legenda

export const CAPTION_FIELDS = ['caption', 'hashtags', 'date'] as const;
export type CaptionField = (typeof CAPTION_FIELDS)[number];
/** os três campos no formato dos inputs (hashtags como texto, data como datetime-local) */
export type CaptionValues = Record<CaptionField, string>;
/** campo em edição: o valor digitado e o que o servidor tinha quando a edição começou */
export interface FieldDraft {
  value: string;
  base: string;
}
/** só os campos que a pessoa mexeu; os demais mostram (e acompanham) o servidor */
export type CaptionDrafts = Partial<Record<CaptionField, FieldDraft>>;

export function captionValues(piece: Pick<ContentPiece, 'caption' | 'hashtags' | 'scheduledFor'>): CaptionValues {
  return {
    caption: piece.caption,
    hashtags: formatHashtags(piece.hashtags),
    date: piece.scheduledFor ? toLocalInput(new Date(piece.scheduledFor)) : '',
  };
}

/** o que a tela mostra: rascunho onde houver, servidor no resto */
export const shownValues = (drafts: CaptionDrafts, server: CaptionValues): CaptionValues => ({
  caption: drafts.caption?.value ?? server.caption,
  hashtags: drafts.hashtags?.value ?? server.hashtags,
  date: drafts.date?.value ?? server.date,
});

/** digitar num campo guarda valor + base; voltar ao que o servidor tem descarta o rascunho do campo */
export function editDraft(
  drafts: CaptionDrafts,
  field: CaptionField,
  value: string,
  server: CaptionValues,
): CaptionDrafts {
  const { [field]: current, ...rest } = drafts;
  if (value === server[field]) return rest;
  return { ...rest, [field]: { value, base: current?.base ?? server[field] } };
}

/** campos em edição cujo valor no servidor mudou desde que a edição começou */
export const staleFields = (drafts: CaptionDrafts, server: CaptionValues): CaptionField[] =>
  CAPTION_FIELDS.filter((f) => {
    const d = drafts[f];
    return d !== undefined && d.base !== server[f];
  });

/** descarta o rascunho dos campos (a tela volta a mostrar o servidor) */
export function dropFields(drafts: CaptionDrafts, fields: readonly CaptionField[]): CaptionDrafts {
  const out: CaptionDrafts = { ...drafts };
  for (const f of fields) delete out[f];
  return out;
}

/** mantém o texto da pessoa e reancora a base na versão nova do servidor (o aviso some) */
export function rebaseFields(
  drafts: CaptionDrafts,
  fields: readonly CaptionField[],
  server: CaptionValues,
): CaptionDrafts {
  const out: CaptionDrafts = { ...drafts };
  for (const f of fields) {
    const d = out[f];
    if (d) out[f] = { value: d.value, base: server[f] };
  }
  return out;
}

/** corpo do PATCH: só os campos mexidos — o que a pessoa não tocou não volta ao valor antigo */
export function captionPatch(drafts: CaptionDrafts): {
  caption?: string;
  hashtags?: string[];
  scheduledFor?: string | null;
} {
  return {
    ...(drafts.caption ? { caption: drafts.caption.value } : {}),
    ...(drafts.hashtags ? { hashtags: parseHashtags(drafts.hashtags.value) } : {}),
    ...(drafts.date ? { scheduledFor: isoFromLocalInput(drafts.date.value) ?? null } : {}),
  };
}

/**
 * Depois de salvar: sai o rascunho do que foi enviado. O que a pessoa digitou durante o envio fica,
 * reancorado no valor salvo (`saved`), para não aparecer como "mudou no servidor".
 */
export function clearSaved(drafts: CaptionDrafts, sent: CaptionDrafts, saved: CaptionValues): CaptionDrafts {
  const out: CaptionDrafts = {};
  for (const f of CAPTION_FIELDS) {
    const d = drafts[f];
    const s = sent[f];
    if (!d) continue;
    if (!s) out[f] = d;
    else if (d.value !== s.value) out[f] = { value: d.value, base: saved[f] };
  }
  return out;
}

/** próxima segunda-feira (estritamente depois de hoje) no fuso local, como YYYY-MM-DD */
export function nextMonday(from: Date): string {
  return dayKey(addDays(startOfWeek(from), 7));
}

/** YYYY-MM-DD é uma segunda-feira? (a pauta semanal começa na segunda) */
export function isMonday(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() === 1;
}

/** mês local como YYYY-MM */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** soma meses a um YYYY-MM (virada de ano incluída) */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y ?? 1970, (m ?? 1) - 1 + delta, 1));
}

/** cotação de referência para o valor aproximado em reais; não é câmbio do dia */
export const USD_TO_BRL = 5.19;

/** custo em dólar; frações de centavo (texto custa isso) ganham casas extras */
export function formatUsd(value: number, locale = 'pt-BR'): string {
  const small = value !== 0 && Math.abs(value) < 0.01;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(value);
}

export function formatBrl(value: number, locale = 'pt-BR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'BRL' }).format(value);
}

export const usdToBrl = (usd: number, rate = USD_TO_BRL): number => usd * rate;

/** peças mais caras do mês, maior custo primeiro */
export function topPieces(pieces: ContentSpend['pieces'], limit = 10): ContentSpend['pieces'] {
  return [...pieces].sort((a, b) => b.costUsd - a.costUsd).slice(0, limit);
}

/** serviços por custo, maior primeiro */
export function servicesByCost(rows: ContentSpend['byService']): ContentSpend['byService'] {
  return [...rows].sort((a, b) => b.costUsd - a.costUsd);
}

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

/** validade (YYYY-MM-DD) anterior a hoje, no fuso local */
export function isExpired(validUntil: string | null, today: Date): boolean {
  return validUntil !== null && validUntil < dayKey(today);
}

export const isFilled = (body: string | undefined): boolean => (body ?? '').trim().length > 0;

export interface PromptGroup {
  active: ContentPrompt | null;
  /** versões não ativas, mais nova primeiro */
  history: ContentPrompt[];
}

/** versões por nome; sem versão marcada como ativa, a mais nova assume */
export function groupPrompts(prompts: readonly ContentPrompt[]): Record<PromptName, PromptGroup> {
  const group = (name: PromptName): PromptGroup => {
    const versions = prompts.filter((p) => p.name === name).sort((a, b) => b.version - a.version);
    const active = versions.find((p) => p.active) ?? versions[0] ?? null;
    return { active, history: versions.filter((p) => p !== active) };
  };
  return { pauta: group('pauta'), roteiro: group('roteiro'), legenda: group('legenda'), revisor: group('revisor') };
}

/** com ou sem `#`, seis dígitos hexadecimais → `#` + minúsculas; o resto → null (a API só aceita #RRGGBB) */
export function normalizeHex(value: string): string | null {
  const v = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : null;
}

/** paleta pronta para a API: papéis vazios ou inválidos saem, as cores extraídas ficam */
export function cleanPalette(palette: ContentPalette): ContentPalette {
  const out: ContentPalette = {};
  for (const role of PALETTE_ROLES) {
    const hex = palette[role] ? normalizeHex(palette[role]) : null;
    if (hex) out[role] = hex;
  }
  if (palette.extraidas?.length) out.extraidas = [...palette.extraidas];
  return out;
}

/** nenhum papel definido e nada extraído: a paleta nunca foi configurada */
export function isPaletteEmpty(palette: ContentPalette): boolean {
  return PALETTE_ROLES.every((r) => !palette[r]) && !palette.extraidas?.length;
}

/** papéis preenchidos com algo que a API recusaria (bloqueia o salvar) */
export function invalidPaletteRoles(palette: ContentPalette): PaletteRole[] {
  return PALETTE_ROLES.filter((r) => {
    const v = palette[r];
    return Boolean(v && v.trim()) && normalizeHex(v ?? '') === null;
  });
}

/** o que o formulário de identidade edita; logos são ações imediatas e ficam fora do rascunho */
export type BrandDraft = Pick<
  ContentBrand,
  | 'name'
  | 'palette'
  | 'slogan'
  | 'signature'
  | 'tone'
  | 'defaultChannelId'
  | 'ctaChannel'
  | 'whatsappNumber'
  | 'publishHour'
  | 'timezone'
  | 'autoApprove'
>;

export function brandDraft(b: ContentBrand): BrandDraft {
  return {
    name: b.name,
    palette: { ...b.palette, ...(b.palette.extraidas ? { extraidas: [...b.palette.extraidas] } : {}) },
    slogan: b.slogan,
    signature: b.signature,
    tone: b.tone,
    defaultChannelId: b.defaultChannelId,
    ctaChannel: b.ctaChannel,
    whatsappNumber: b.whatsappNumber,
    publishHour: b.publishHour,
    timezone: b.timezone,
    autoApprove: b.autoApprove,
  };
}

/** rascunho → corpo do PUT: textos aparados, paleta limpa, WhatsApp só com dígitos */
export function brandPatchFrom(d: BrandDraft): BrandPatch {
  return {
    name: d.name.trim(),
    palette: cleanPalette(d.palette),
    slogan: d.slogan.trim(),
    signature: d.signature.trim(),
    tone: d.tone.trim(),
    defaultChannelId: d.defaultChannelId,
    ctaChannel: d.ctaChannel,
    whatsappNumber: d.whatsappNumber.replace(/\D/g, ''),
    publishHour: d.publishHour,
    timezone: d.timezone.trim(),
    autoApprove: d.autoApprove,
  };
}

/** comparação estrutural do rascunho com o que o servidor tem */
export const sameDraft = (a: BrandDraft, b: BrandDraft): boolean =>
  JSON.stringify(brandPatchFrom(a)) === JSON.stringify(brandPatchFrom(b));

// ------------------------------------------------------------------ roteiro

export interface ScriptSlide {
  ordem: number;
  tipo: string;
  titulo: string;
  texto: string;
  itens: string[];
}

export interface ScriptScene {
  ordem: number;
  duracao: number;
  locucao: string;
  textoTela: string;
  visual: string;
}

export interface ScriptView {
  hook: string;
  story: string;
  offer: string;
  slides: ScriptSlide[];
  cenas: ScriptScene[];
  pendencias: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Lê o roteiro gravado pela etapa 1. O contrato OpenAPI o expõe como objeto livre, então a leitura
 * é defensiva: campo ausente vira vazio, e slides/cenas saem ordenados.
 */
export function readScript(script: Record<string, unknown> | null): ScriptView | null {
  if (!script) return null;
  const slides = list(script.slides)
    .map(obj)
    .map((s, i) => ({
      ordem: num(s.ordem, i + 1),
      tipo: str(s.tipo),
      titulo: str(s.titulo),
      texto: str(s.texto),
      itens: list(s.itens).filter((x): x is string => typeof x === 'string'),
    }))
    .sort((a, b) => a.ordem - b.ordem);
  const cenas = list(script.cenas)
    .map(obj)
    .map((c, i) => ({
      ordem: num(c.ordem, i + 1),
      duracao: num(c.duracao_s, 6),
      locucao: str(c.locucao),
      textoTela: str(c.texto_tela),
      visual: str(c.visual),
    }))
    .sort((a, b) => a.ordem - b.ordem);
  return {
    hook: str(script.hook),
    story: str(script.story),
    offer: str(script.offer),
    slides,
    cenas,
    pendencias: list(script.pendencias).filter((x): x is string => typeof x === 'string'),
  };
}

/** Date → ISO; vazio ou inválido → undefined */
export function isoFromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
