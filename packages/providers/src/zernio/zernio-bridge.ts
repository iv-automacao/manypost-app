import type {
  CommentTransport,
  DirectMessage,
  DirectTransport,
  EngagementComment,
  ErrorClass,
  ProviderContext,
  ProviderFailure,
} from '@manypost/contracts';

/**
 * Ponte de comentários pela Zernio (change add-zernio-comment-bridge).
 *
 * O app próprio tem só acesso padrão à Meta, que conta os comentários mas não entrega o conteúdo.
 * A Zernio (app aprovado) já tem a conta conectada, então lemos, respondemos e ocultamos por ela
 * até o App Review sair. Endpoints da documentação pública (docs.zernio.com, OpenAPI v1.262):
 * `GET /v1/accounts`, `GET|POST /v1/inbox/comments/{postId}`,
 * `POST|DELETE /v1/inbox/comments/{postId}/{commentId}/hide`.
 *
 * Direct (change add-comment-automation): `POST /v1/inbox/comments/{postId}/{commentId}/private-reply`
 * (uma por comentário, sem chave de idempotência) e `POST /v1/inbox/conversations/{id}/messages`
 * (com `Idempotency-Key`, guardada 24 h pela Zernio).
 */

const DEFAULT_BASE = 'https://zernio.com/api/v1';
/** a lista de contas muda raramente; 10 min evita uma chamada extra por tela aberta */
const ACCOUNTS_TTL_MS = 10 * 60_000;
const MAX_PAGE = 50;

export interface ZernioBridgeDeps {
  apiKey: string;
  fetch: typeof fetch;
  log: ProviderContext['log'];
  now?: () => Date;
  baseUrl?: string;
}

export interface ZernioAccountRef {
  /** id da conta na rede (Instagram user id) — chave estável entre reconexões */
  platformUserId?: string | undefined;
  username?: string | undefined;
}

interface ZernioAccount {
  _id: string;
  platform: string;
  platformUserId?: string;
  username?: string;
  isActive?: boolean;
}

interface ZernioComment {
  id: string;
  message?: string;
  createdTime?: string;
  from?: { username?: string; isOwner?: boolean };
  likeCount?: number;
  isHidden?: boolean;
  replies?: ZernioComment[];
}

/** 401/403 são da chave da instalação, não do token do canal — nunca pedem reconexão */
function classify(status: number): ErrorClass {
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

type BridgeFailure = ProviderFailure & { consumed?: boolean; uncertain?: boolean };

/**
 * falha no formato que o caso de uso já sabe sanear (`error.message`); `consumed`/`uncertain` vêm
 * dos `details` da resposta privada (`privateReplyConsumed`, `privateReplyOutcome: "unknown"`)
 */
async function failure(res: Response): Promise<BridgeFailure> {
  const raw = await res.text().catch(() => '');
  let message = '';
  let details: { privateReplyConsumed?: unknown; privateReplyOutcome?: unknown } = {};
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown; details?: typeof details };
    if (parsed.details && typeof parsed.details === 'object') details = parsed.details;
    const e = parsed.error ?? parsed.message;
    if (typeof e === 'string') message = e;
    else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      message = (e as { message: string }).message;
    }
  } catch {
    // corpo não-JSON
  }
  return {
    status: res.status,
    body: JSON.stringify({ error: { message: message || `zernio respondeu ${res.status}` } }),
    errorClass: details.privateReplyConsumed === true ? 'permanent' : classify(res.status),
    ...(details.privateReplyConsumed === true ? { consumed: true } : {}),
    ...(details.privateReplyOutcome === 'unknown' ? { uncertain: true } : {}),
  };
}

/** corpo de mensagem da Zernio: botões viram postback/url; respostas rápidas passam direto */
function messageBody(accountId: string, msg: DirectMessage) {
  return {
    accountId,
    message: msg.text,
    ...(msg.buttons?.length
      ? {
          buttons: msg.buttons.map((b) =>
            b.url ? { type: 'url', title: b.title, url: b.url } : { type: 'postback', title: b.title, payload: b.payload ?? '' },
          ),
        }
      : {}),
    ...(msg.quickReplies?.length ? { quickReplies: msg.quickReplies } : {}),
  };
}

function toComment(c: ZernioComment, nested: boolean): EngagementComment {
  const username = c.from?.username;
  return {
    id: c.id,
    text: c.message ?? '',
    ...(username ? { username } : {}),
    timestamp: c.createdTime ?? '',
    ...(typeof c.likeCount === 'number' ? { likeCount: c.likeCount } : {}),
    hidden: c.isHidden === true,
    fromOwner: c.from?.isOwner === true,
    replies: nested ? [] : (c.replies ?? []).map((r) => toComment(r, true)),
  };
}

export function makeZernioBridge(deps: ZernioBridgeDeps) {
  const base = deps.baseUrl ?? DEFAULT_BASE;
  const now = deps.now ?? (() => new Date());
  let cache: { at: number; accounts: ZernioAccount[] } | null = null;

  async function call(
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await deps.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw await failure(res);
    return res.json().catch(() => ({})) as Promise<unknown>;
  }

  async function instagramAccounts(): Promise<ZernioAccount[]> {
    const t = now().getTime();
    if (cache && t - cache.at < ACCOUNTS_TTL_MS) return cache.accounts;
    const out = (await call('GET', '/accounts', { query: { platform: 'instagram' } })) as {
      accounts?: ZernioAccount[];
    };
    const accounts = (out.accounts ?? []).filter((a) => a.platform === 'instagram');
    cache = { at: t, accounts };
    return accounts;
  }

  function transport(accountId: string): CommentTransport & DirectTransport {
    const enc = encodeURIComponent;
    return {
      id: 'zernio',
      async listComments(mediaId, page) {
        const out = (await call('GET', `/inbox/comments/${enc(mediaId)}`, {
          query: {
            accountId,
            limit: String(Math.min(Math.max(page.limit, 1), MAX_PAGE)),
            ...(page.cursor ? { cursor: page.cursor } : {}),
          },
        })) as { comments?: ZernioComment[]; pagination?: { hasMore?: boolean; cursor?: string | null } };
        const next = out.pagination?.hasMore ? out.pagination.cursor : undefined;
        return {
          items: (out.comments ?? []).map((c) => toComment(c, false)),
          ...(next ? { nextCursor: next } : {}),
        };
      },
      async replyToComment(mediaId, commentId, message) {
        const out = (await call('POST', `/inbox/comments/${enc(mediaId)}`, {
          body: { accountId, message, commentId },
        })) as { data?: { commentId?: string } };
        const id = out.data?.commentId;
        if (!id) throw { status: 502, body: '{"error":{"message":"a zernio não devolveu o id da resposta"}}', errorClass: 'transient' } satisfies ProviderFailure;
        return { id };
      },
      async setCommentHidden(mediaId, commentId, hidden) {
        const path = `/inbox/comments/${enc(mediaId)}/${enc(commentId)}/hide`;
        if (hidden) await call('POST', path, { body: { accountId } });
        else await call('DELETE', path, { query: { accountId } });
      },
      async privateReply(mediaId, commentId, msg) {
        const out = (await call('POST', `/inbox/comments/${enc(mediaId)}/${enc(commentId)}/private-reply`, {
          body: messageBody(accountId, msg),
        })) as { messageId?: string };
        return { messageId: out.messageId ?? null };
      },
      async sendMessage(conversationId, msg, idempotencyKey) {
        const out = (await call('POST', `/inbox/conversations/${enc(conversationId)}/messages`, {
          body: messageBody(accountId, msg),
          headers: { 'idempotency-key': idempotencyKey },
        })) as { data?: { messageId?: string } };
        return { messageId: out.data?.messageId ?? null };
      },
    };
  }

  /** id da conta na Zernio para a conta do canal, ou `null` (chave não enxerga / Zernio falhou) */
  async function resolve(ref: ZernioAccountRef): Promise<string | null> {
    let accounts: ZernioAccount[];
    try {
      accounts = await instagramAccounts();
    } catch (e) {
      const status = typeof (e as ProviderFailure)?.status === 'number' ? (e as ProviderFailure).status : null;
      deps.log('warn', 'zernio.accounts.failed', { status });
      return null;
    }
    const active = accounts.filter((a) => a.isActive !== false);
    const byId = ref.platformUserId ? active.find((a) => a.platformUserId === ref.platformUserId) : undefined;
    const uname = ref.username?.toLowerCase();
    const found = byId ?? (uname ? active.find((a) => a.username?.toLowerCase() === uname) : undefined);
    return found?._id ?? null;
  }

  return {
    /** ponte para a conta, ou `null` quando a chave não enxerga a conta (ou a Zernio falhou) */
    async forAccount(ref: ZernioAccountRef): Promise<CommentTransport | null> {
      const id = await resolve(ref);
      return id ? transport(id) : null;
    },
    /** envio no direct (resposta privada + mensagem na conversa) para a conta do canal */
    async directFor(ref: ZernioAccountRef): Promise<DirectTransport | null> {
      const id = await resolve(ref);
      return id ? transport(id) : null;
    },
    /** transportes já fechados sobre uma conta da Zernio conhecida (vinda de `accountById`) */
    bind(zernioAccountId: string): CommentTransport & DirectTransport {
      return transport(zernioAccountId);
    },
    /** conta Instagram de um evento do webhook (`account.accountId`) → identidade na rede */
    async accountById(zernioAccountId: string): Promise<{ platformUserId: string | null; username: string | null } | null> {
      let accounts: ZernioAccount[];
      try {
        accounts = await instagramAccounts();
      } catch (e) {
        const status = typeof (e as ProviderFailure)?.status === 'number' ? (e as ProviderFailure).status : null;
        deps.log('warn', 'zernio.accounts.failed', { status });
        return null;
      }
      const a = accounts.find((x) => x._id === zernioAccountId);
      return a ? { platformUserId: a.platformUserId ?? null, username: a.username ?? null } : null;
    },
  };
}

export type ZernioBridge = ReturnType<typeof makeZernioBridge>;
