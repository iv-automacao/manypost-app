import type {
  AccountInsights,
  EngagementComment,
  EngagementMedia,
  EngagementPage,
  ErrorClass,
  MediaInsights,
  MetricPoint,
  MetricValues,
  ProviderContext,
  ProviderFailure,
} from '@manypost/contracts';
import { igForm } from './instagram-graph';
import { metaFetch } from './meta-graph';

// Engajamento do Instagram (comentários e métricas) — change add-instagram-engagement.
// Referência funcional: instagram-mcp (MIT), que expõe os mesmos endpoints públicos da Graph
// (`/{media}/comments`, `/{comment}/replies`, `hide`, `/{ig-user}/insights`, `/{media}/insights`).
// Nenhum código foi portado; os caminhos e campos vêm da documentação da Meta (verificada em
// 12/10/2026 contra a v21.0). Parametrizado pelo host como o `makeInstagramGraph`: o Instagram Login
// usa `graph.instagram.com`, o Facebook Login poderá usar `graph.facebook.com` resolvendo a conta
// pela Página.

/** Conta que assina e é dona da mídia. `userId` ausente = `me`. */
export interface IgEngagementAccount {
  userId?: string | undefined;
  username?: string | undefined;
  accessToken: string;
}

/** Totais da conta pedidos com `metric_type=total_value` — nomes vigentes da Graph (v22 tirou impressions/plays). */
export const ACCOUNT_METRICS = [
  'reach',
  'views',
  'accounts_engaged',
  'total_interactions',
  'likes',
  'comments',
  'shares',
  'saves',
] as const;

/** Métricas vitalícias por post — o conjunto vale para feed e reels (story não aparece em /media). */
export const MEDIA_METRICS = [
  'reach',
  'views',
  'likes',
  'comments',
  'shares',
  'saved',
  'total_interactions',
] as const;

const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count';
const COMMENT_FIELDS = 'id,text,timestamp,like_count,hidden,username,from{id,username}';
const MEDIA_INSIGHTS_CONCURRENCY = 4;

/**
 * Classificação própria do engajamento, guiada pelo `code` da Meta e não pelo `type`: a Meta manda
 * `OAuthException` também em erro de parâmetro (#100), que não se resolve reconectando.
 * - 190 (token inválido/expirado) e 200–299 (permissão não concedida) → reconectar;
 * - 1, 2, 4, 17, 32, 341, 613, 429 e 5xx → instabilidade/limite;
 * - o resto (100, 10 "Not enough viewers", 803 id inexistente…) → recusa permanente.
 */
export function classifyEngagementError(status: number, body: string): ErrorClass {
  const code = metaCode(body);
  if (status === 401 || code === 190 || (code !== undefined && code >= 200 && code <= 299)) {
    return 'refresh-token';
  }
  if (
    status === 429 ||
    status >= 500 ||
    (code !== undefined && [1, 2, 4, 17, 32, 341, 613].includes(code))
  ) {
    return 'transient';
  }
  return 'permanent';
}

function metaCode(body: string): number | undefined {
  const m = /"code":\s*(\d+)/.exec(body);
  return m ? Number(m[1]) : undefined;
}

/** mensagem da Meta sem URL nem nada além do texto, cortada — segura para mostrar e logar */
export function metaMessage(body: string): string {
  try {
    const msg = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.replace(/https?:\/\/\S+/g, '').trim().slice(0, 200);
  } catch {
    // corpo não-JSON (gateway) — cai no genérico
  }
  return 'a rede recusou o pedido';
}

const isFailure = (e: unknown): e is ProviderFailure =>
  typeof e === 'object' && e !== null && typeof (e as ProviderFailure).status === 'number';

/** chama a Graph e, em falha da rede, lança `ProviderFailure` já classificado; transporte passa direto */
async function call<T>(ctx: ProviderContext, url: string, init?: RequestInit): Promise<T> {
  try {
    return await metaFetch<T>(ctx, url, init);
  } catch (e) {
    if (isFailure(e)) {
      const failure: ProviderFailure = {
        status: e.status,
        body: e.body,
        errorClass: classifyEngagementError(e.status, e.body),
      };
      throw failure;
    }
    throw e;
  }
}

const isParamError = (e: unknown) =>
  isFailure(e) && e.errorClass === 'permanent' && metaCode(e.body) === 100;

interface GraphPaging {
  cursors?: { after?: string };
  next?: string;
}

interface GraphMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

interface GraphComment {
  id: string;
  text?: string;
  timestamp?: string;
  like_count?: number;
  hidden?: boolean;
  username?: string;
  from?: { id?: string; username?: string };
  replies?: { data?: GraphComment[] };
}

interface GraphInsight {
  name: string;
  values?: Array<{ value?: unknown; end_time?: string }>;
  total_value?: { value?: unknown };
}

const nextCursor = (paging?: GraphPaging) =>
  paging?.next && paging.cursors?.after ? paging.cursors.after : undefined;

const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** valor de uma métrica: `total_value.value` (totais) ou o último `values[].value` (vitalícias) */
const insightValue = (i: GraphInsight) =>
  i.total_value ? numOrNull(i.total_value.value) : numOrNull(i.values?.at(-1)?.value);

const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

/** executa `fn` sobre `items` com no máximo `limit` em voo, preservando a ordem */
async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const makeInstagramEngagement = (apiBase: string) => {
  const get = <T>(ctx: ProviderContext, path: string, acc: IgEngagementAccount, params: Record<string, string | undefined>) => {
    const q = new URLSearchParams(
      Object.entries({ ...params, access_token: acc.accessToken }).filter(
        ([, v]) => v !== undefined && v !== '',
      ) as Array<[string, string]>,
    );
    return call<T>(ctx, `${apiBase}${path}?${q}`);
  };
  const post = <T>(ctx: ProviderContext, path: string, acc: IgEngagementAccount, params: Record<string, string>) =>
    call<T>(ctx, `${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: igForm({ ...params, access_token: acc.accessToken }),
    });
  const owner = (acc: IgEngagementAccount) => acc.userId ?? 'me';

  const toComment = (acc: IgEngagementAccount, c: GraphComment, withReplies: boolean): EngagementComment => {
    const username = c.username ?? c.from?.username;
    return {
      id: c.id,
      text: c.text ?? '',
      ...(username ? { username } : {}),
      timestamp: c.timestamp ?? '',
      ...(typeof c.like_count === 'number' ? { likeCount: c.like_count } : {}),
      hidden: c.hidden === true,
      fromOwner:
        (acc.userId !== undefined && c.from?.id === acc.userId) ||
        (acc.username !== undefined && username === acc.username),
      replies: withReplies ? (c.replies?.data ?? []).map((r) => toComment(acc, r, false)) : [],
    };
  };

  /** totais da conta: tudo num pedido; se a Meta recusar um nome (#100), uma métrica por chamada */
  const accountTotals = async (ctx: ProviderContext, acc: IgEngagementAccount, base: Record<string, string>) => {
    const ask = async (metrics: readonly string[]) => {
      const res = await get<{ data?: GraphInsight[] }>(ctx, `/${owner(acc)}/insights`, acc, {
        ...base,
        metric: metrics.join(','),
      });
      return res.data ?? [];
    };
    const totals: MetricValues = Object.fromEntries(ACCOUNT_METRICS.map((m) => [m, null]));
    try {
      for (const i of await ask(ACCOUNT_METRICS)) totals[i.name] = insightValue(i);
      return totals;
    } catch (e) {
      if (!isParamError(e)) throw e;
    }
    for (const metric of ACCOUNT_METRICS) {
      try {
        for (const i of await ask([metric])) totals[i.name] = insightValue(i);
      } catch (e) {
        // só a recusa permanente degrada; token revogado ou limite sobem
        if (!isFailure(e) || e.errorClass !== 'permanent') throw e;
        ctx.log('warn', 'engagement.metric_unavailable', { metric, reason: metaMessage(e.body) });
      }
    }
    return totals;
  };

  const mediaInsights = async (ctx: ProviderContext, acc: IgEngagementAccount, mediaId: string): Promise<MediaInsights> => {
    const metrics: MetricValues = Object.fromEntries(MEDIA_METRICS.map((m) => [m, null]));
    const ask = async (list: readonly string[]) => {
      const res = await get<{ data?: GraphInsight[] }>(ctx, `/${mediaId}/insights`, acc, {
        metric: list.join(','),
      });
      for (const i of res.data ?? []) metrics[i.name] = insightValue(i);
    };
    try {
      await ask(MEDIA_METRICS);
      return { mediaId, metrics };
    } catch (e) {
      // reconectar derruba tudo; o resto fica isolado neste post
      if (!isFailure(e) || e.errorClass === 'refresh-token') throw e;
      if (!isParamError(e)) return { mediaId, metrics, unavailableReason: metaMessage(e.body) };
    }
    // #100: alguma métrica não vale para o tipo deste post — refaz uma a uma
    for (const metric of MEDIA_METRICS) {
      try {
        await ask([metric]);
      } catch (e) {
        if (!isFailure(e) || e.errorClass === 'refresh-token') throw e;
      }
    }
    return { mediaId, metrics };
  };

  return {
    async listRecentMedia(
      ctx: ProviderContext,
      acc: IgEngagementAccount,
      page: { cursor?: string | undefined; limit: number },
    ): Promise<EngagementPage<EngagementMedia>> {
      const res = await get<{ data?: GraphMedia[]; paging?: GraphPaging }>(ctx, `/${owner(acc)}/media`, acc, {
        fields: MEDIA_FIELDS,
        limit: String(page.limit),
        after: page.cursor,
      });
      const items = (res.data ?? []).map((m): EngagementMedia => {
        const preview = m.thumbnail_url ?? (m.media_type === 'VIDEO' ? undefined : m.media_url);
        return {
          id: m.id,
          mediaType: m.media_type ?? 'IMAGE',
          ...(m.media_product_type ? { productType: m.media_product_type } : {}),
          ...(m.caption ? { caption: m.caption } : {}),
          ...(m.permalink ? { permalink: m.permalink } : {}),
          ...(preview ? { previewUrl: preview } : {}),
          timestamp: m.timestamp ?? '',
          ...(typeof m.like_count === 'number' ? { likeCount: m.like_count } : {}),
          ...(typeof m.comments_count === 'number' ? { commentsCount: m.comments_count } : {}),
        };
      });
      const cursor = nextCursor(res.paging);
      return { items, ...(cursor ? { nextCursor: cursor } : {}) };
    },

    async listComments(
      ctx: ProviderContext,
      acc: IgEngagementAccount,
      mediaId: string,
      page: { cursor?: string | undefined; limit: number },
    ): Promise<EngagementPage<EngagementComment>> {
      const res = await get<{ data?: GraphComment[]; paging?: GraphPaging }>(ctx, `/${mediaId}/comments`, acc, {
        fields: `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`,
        limit: String(page.limit),
        after: page.cursor,
      });
      const cursor = nextCursor(res.paging);
      return {
        items: (res.data ?? []).map((c) => toComment(acc, c, true)),
        ...(cursor ? { nextCursor: cursor } : {}),
      };
    },

    async replyToComment(ctx: ProviderContext, acc: IgEngagementAccount, commentId: string, message: string) {
      const { id } = await post<{ id: string }>(ctx, `/${commentId}/replies`, acc, { message });
      return { id };
    },

    async setCommentHidden(ctx: ProviderContext, acc: IgEngagementAccount, commentId: string, hidden: boolean) {
      await post(ctx, `/${commentId}`, acc, { hide: String(hidden) });
    },

    async fetchAccountInsights(
      ctx: ProviderContext,
      acc: IgEngagementAccount,
      range: { since: Date; until: Date },
    ): Promise<AccountInsights> {
      const window = { period: 'day', since: unix(range.since), until: unix(range.until) };
      const totals = await accountTotals(ctx, acc, { ...window, metric_type: 'total_value' });

      // série e contagem são complemento: falha aqui não apaga os totais (mas token revogado já
      // teria derrubado os totais acima)
      let dailyReach: MetricPoint[] = [];
      try {
        const res = await get<{ data?: GraphInsight[] }>(ctx, `/${owner(acc)}/insights`, acc, {
          ...window,
          metric: 'reach',
        });
        dailyReach = (res.data?.[0]?.values ?? []).flatMap((v) =>
          typeof v.value === 'number' && v.end_time ? [{ date: v.end_time.slice(0, 10), value: v.value }] : [],
        );
      } catch (e) {
        ctx.log('warn', 'engagement.daily_reach_unavailable', {
          reason: isFailure(e) ? metaMessage(e.body) : 'transporte',
        });
      }

      let followersCount: number | null = null;
      let mediaCount: number | null = null;
      try {
        const me = await get<{ followers_count?: unknown; media_count?: unknown }>(ctx, `/${owner(acc)}`, acc, {
          fields: 'followers_count,media_count',
        });
        followersCount = numOrNull(me.followers_count);
        mediaCount = numOrNull(me.media_count);
      } catch (e) {
        ctx.log('warn', 'engagement.followers_unavailable', {
          reason: isFailure(e) ? metaMessage(e.body) : 'transporte',
        });
      }

      return {
        since: range.since.toISOString(),
        until: range.until.toISOString(),
        totals,
        followersCount,
        mediaCount,
        dailyReach,
      };
    },

    fetchMediaInsights(ctx: ProviderContext, acc: IgEngagementAccount, mediaIds: string[]) {
      return mapLimited(mediaIds, MEDIA_INSIGHTS_CONCURRENCY, (id) => mediaInsights(ctx, acc, id));
    },
  };
};
