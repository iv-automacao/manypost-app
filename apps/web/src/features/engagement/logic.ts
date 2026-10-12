import { errorCode, type ApiProblem } from '@/lib/api/client';

/** limite de uma resposta de comentário no Instagram (o mesmo do caso de uso) */
export const REPLY_MAX = 2200;

/** totais da conta na ordem em que a tela mostra (mesmos nomes da API) */
export const ACCOUNT_METRIC_KEYS = [
  'reach',
  'views',
  'accounts_engaged',
  'total_interactions',
  'likes',
  'comments',
  'shares',
  'saves',
] as const;

/** colunas da tabela por post */
export const MEDIA_METRIC_KEYS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved'] as const;

/** janelas oferecidas (a Graph aceita até 30 dias) */
export const PERIODS = [7, 14, 28] as const;
export type Period = (typeof PERIODS)[number];

interface ChannelLike {
  id: string;
  provider: string;
  status: string;
}
interface ProviderLike {
  id: string;
  engagement?: { comments: boolean; insights: boolean };
}

/**
 * Canais que aparecem no seletor: rede com a capacidade e canal não desativado. Quem precisa
 * reconectar continua na lista — a tela explica e oferece o caminho, em vez de sumir com a conta.
 */
export function eligibleChannels<C extends ChannelLike>(
  channels: C[] | undefined,
  providers: ProviderLike[] | undefined,
  kind: 'comments' | 'insights',
): C[] {
  if (!channels || !providers) return [];
  const supported = new Set(providers.filter((p) => p.engagement?.[kind]).map((p) => p.id));
  return channels.filter((c) => supported.has(c.provider) && c.status !== 'DISABLED');
}

/** erro que se resolve reconectando o canal (token vencido ou permissão não concedida) */
export function needsReconnect(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('title' in error)) return false;
  const code = errorCode(error as ApiProblem);
  return code === 'channel.refresh_required' || code === 'channel.missing_scopes';
}

/** `null` = a rede não devolveu: mostra travessão, nunca zero */
export function formatMetric(value: number | null | undefined, locale: string): string {
  return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : '—';
}

export function replyState(draft: string) {
  const length = draft.trim().length;
  const over = length > REPLY_MAX;
  return { length, canSend: length > 0 && !over, over };
}

/** primeira linha da legenda, cortada */
export function captionPreview(caption: string | undefined, max = 80): string {
  const first = (caption ?? '').split('\n')[0]?.trim() ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** barras da série diária: porcentagem do maior dia, com piso de 2% para valores > 0 */
export function reachBars(points: Array<{ date: string; value: number }>) {
  const max = Math.max(0, ...points.map((p) => p.value));
  return points.map((p) => ({
    ...p,
    pct: max === 0 || p.value === 0 ? 0 : Math.max(2, Math.round((p.value / max) * 100)),
  }));
}

/** chave de tradução do tipo do post: reels/story pelo productType; carrossel vem como FEED, então o resto usa o mediaType */
export function mediaKindKey(media: { mediaType: string; productType?: string }): string {
  return media.productType === 'REELS' || media.productType === 'STORY' ? media.productType : media.mediaType;
}

/** a Meta devolve totais líquidos no período (curtida/salvamento desfeito desconta) — pode dar negativo */
export function hasNegativeTotal(totals: Record<string, number | null>): boolean {
  return Object.values(totals).some((v) => typeof v === 'number' && v < 0);
}

/** comentários que a rede conta no post mas não devolveu na listagem */
export function hiddenComments(counted: number | undefined, returned: number): number {
  return Math.max(0, (counted ?? 0) - returned);
}
