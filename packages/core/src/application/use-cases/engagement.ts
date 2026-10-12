import type {
  ActorType,
  ChannelProvider,
  EngagementMedia,
  ErrorClass,
  MetricValues,
  ProviderContext,
  ProviderFailure,
  TokenSet,
} from '@manypost/contracts';
import { ErrorCodes } from '@manypost/contracts';
import { DomainError } from '../../domain/shared/result';
import type { AuditLogRepository } from '../ports/approvals';
import type { CryptoService } from '../ports/crypto';
import type { ChannelRecord, ChannelRepository } from '../ports/publishing';
import { channelAad } from './channels';

/**
 * Comentários e métricas de um canal conectado (change add-instagram-engagement).
 *
 * Toda operação: canal resolvido pela organização → canal ativo → escopo concedido → token
 * decifrado → provider. Nada é persistido; só as escritas deixam rastro na auditoria. A leitura
 * nunca muda o status do canal (renovação é do worker).
 */

/** limite de uma resposta de comentário no Instagram */
export const COMMENT_MAX_LEN = 2200;
/** janela máxima de métricas da conta que a Graph aceita num pedido */
export const INSIGHTS_MAX_DAYS = 30;

export interface EngagementDeps {
  channels: Pick<ChannelRepository, 'findMany'>;
  crypto: CryptoService;
  audit: AuditLogRepository;
  /** provider disponível nesta instalação + contexto (secrets, fetch, log); null = indisponível */
  providerFor: (providerId: string) => { provider: ChannelProvider; ctx: ProviderContext } | null;
  now?: () => Date;
}

export interface EngagementTarget {
  orgId: string;
  channelId: string;
}

export interface EngagementActor {
  type: ActorType;
  id: string | null;
  ip?: string | null;
}

type ScopeGroup = 'comments' | 'insights';

export interface MediaWithInsights {
  media: EngagementMedia;
  metrics: MetricValues;
  unavailableReason?: string;
}

const invalid = (message: string) => new DomainError(ErrorCodes.ValidationInvalidRequest, message);

/** só o texto da Meta (`error.message`), sem URL, cortado — o corpo cru nunca sai daqui */
function sanitizedMessage(body: string): string {
  try {
    const msg = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof msg === 'string' && msg.trim()) {
      return msg.replace(/https?:\/\/\S+/g, '').trim().slice(0, 200);
    }
  } catch {
    // corpo não-JSON
  }
  return 'a rede recusou o pedido';
}

const isFailure = (e: unknown): e is ProviderFailure =>
  typeof e === 'object' && e !== null && typeof (e as ProviderFailure).status === 'number';

export const makeEngagement = (deps: EngagementDeps) => {
  const now = deps.now ?? (() => new Date());

  /** canal da org + provider com a operação + escopo; só então decifra o token */
  async function open<K extends keyof ChannelProvider>(
    target: EngagementTarget,
    op: K,
    group: ScopeGroup,
  ) {
    const [row] = await deps.channels.findMany(target.orgId, [target.channelId]);
    if (!row) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');

    const resolved = deps.providerFor(row.provider);
    const method = resolved?.provider[op];
    if (!resolved || typeof method !== 'function') {
      throw new DomainError(
        ErrorCodes.CapabilityDisabled,
        'esta rede não oferece comentários e métricas por aqui',
      );
    }
    if (row.status !== 'ACTIVE') {
      throw new DomainError(ErrorCodes.ChannelRefreshRequired, 'reconecte o canal para continuar', {
        channelId: row.id,
      });
    }
    const required = resolved.provider.engagementScopes?.[group];
    if (required && !row.scopes.includes(required)) {
      throw new DomainError(
        ErrorCodes.ChannelMissingScopes,
        'a conexão não concedeu a permissão necessária — reconecte marcando todas as permissões',
        { missing: [required] },
      );
    }

    const token = await decryptToken(row);
    return { row, provider: resolved.provider, ctx: resolved.ctx, token };
  }

  async function decryptToken(row: ChannelRecord): Promise<TokenSet> {
    const aad = channelAad(row.orgId, row.provider, row.externalId);
    const accessToken = await deps.crypto.decrypt(row.tokenEnc, aad, row.tokenKeyVersion);
    return { accessToken, scopes: row.scopes };
  }

  /** falha da rede → erro de domínio estável; `write` marca transporte como desfecho incerto */
  async function guarded<T>(
    provider: ChannelProvider,
    ctx: ProviderContext,
    op: string,
    write: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const out = await run();
      ctx.log('info', `engagement.${op}`, { provider: provider.id, ms: Date.now() - started });
      return out;
    } catch (e) {
      if (!isFailure(e)) {
        ctx.log('warn', `engagement.${op}.transport`, { provider: provider.id });
        throw new DomainError(
          ErrorCodes.ChannelProviderFailed,
          write
            ? 'a rede não confirmou — confira na lista antes de tentar de novo'
            : 'a rede não respondeu — tente de novo em instantes',
          write ? { uncertain: true } : undefined,
        );
      }
      const cls: ErrorClass = e.errorClass ?? provider.classifyError(e.status, e.body);
      ctx.log('warn', `engagement.${op}.failed`, { provider: provider.id, status: e.status, class: cls });
      if (cls === 'refresh-token') {
        throw new DomainError(ErrorCodes.ChannelRefreshRequired, 'reconecte o canal para continuar');
      }
      if (cls === 'transient') {
        throw new DomainError(
          ErrorCodes.ChannelProviderFailed,
          'a rede está instável ou limitou as chamadas — tente de novo em instantes',
        );
      }
      throw new DomainError(ErrorCodes.ChannelProviderRejected, sanitizedMessage(e.body));
    }
  }

  return {
    async listMedia(input: EngagementTarget & { cursor?: string; limit: number }) {
      const c = await open(input, 'listRecentMedia', 'comments');
      return guarded(c.provider, c.ctx, 'list_media', false, () =>
        c.provider.listRecentMedia!(c.ctx, c.token, c.row.settings, {
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: input.limit,
        }),
      );
    },

    async listComments(input: EngagementTarget & { mediaId: string; cursor?: string; limit?: number }) {
      const c = await open(input, 'listComments', 'comments');
      return guarded(c.provider, c.ctx, 'list_comments', false, () =>
        c.provider.listComments!(c.ctx, c.token, c.row.settings, input.mediaId, {
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: input.limit ?? 50,
        }),
      );
    },

    async reply(input: EngagementTarget & { commentId: string; message: string; actor: EngagementActor }) {
      const message = input.message.trim();
      if (!message) throw invalid('escreva a resposta antes de enviar');
      if (message.length > COMMENT_MAX_LEN) {
        throw invalid(`a resposta passa de ${COMMENT_MAX_LEN} caracteres`);
      }
      const c = await open(input, 'replyToComment', 'comments');
      const out = await guarded(c.provider, c.ctx, 'reply', true, () =>
        c.provider.replyToComment!(c.ctx, c.token, c.row.settings, input.commentId, message),
      );
      await deps.audit.append({
        orgId: input.orgId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'comment.replied',
        targetType: 'channel',
        targetId: c.row.id,
        detail: { commentId: input.commentId, replyId: out.id },
        ip: input.actor.ip ?? null,
      });
      return out;
    },

    async setHidden(input: EngagementTarget & { commentId: string; hidden: boolean; actor: EngagementActor }) {
      const c = await open(input, 'setCommentHidden', 'comments');
      await guarded(c.provider, c.ctx, input.hidden ? 'hide' : 'unhide', true, () =>
        c.provider.setCommentHidden!(c.ctx, c.token, c.row.settings, input.commentId, input.hidden),
      );
      await deps.audit.append({
        orgId: input.orgId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: input.hidden ? 'comment.hidden' : 'comment.unhidden',
        targetType: 'channel',
        targetId: c.row.id,
        detail: { commentId: input.commentId },
        ip: input.actor.ip ?? null,
      });
    },

    async accountInsights(input: EngagementTarget & { days: number }) {
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > INSIGHTS_MAX_DAYS) {
        throw invalid(`escolha um período de 1 a ${INSIGHTS_MAX_DAYS} dias`);
      }
      const c = await open(input, 'fetchAccountInsights', 'insights');
      const until = now();
      const since = new Date(until.getTime() - input.days * 86_400_000);
      return guarded(c.provider, c.ctx, 'account_insights', false, () =>
        c.provider.fetchAccountInsights!(c.ctx, c.token, c.row.settings, { since, until }),
      );
    },

    async mediaInsights(input: EngagementTarget & { cursor?: string; limit: number }) {
      const c = await open(input, 'fetchMediaInsights', 'insights');
      if (typeof c.provider.listRecentMedia !== 'function') {
        throw new DomainError(ErrorCodes.CapabilityDisabled, 'esta rede não lista os posts por aqui');
      }
      const page = await guarded(c.provider, c.ctx, 'list_media', false, () =>
        c.provider.listRecentMedia!(c.ctx, c.token, c.row.settings, {
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: input.limit,
        }),
      );
      const insights = await guarded(c.provider, c.ctx, 'media_insights', false, () =>
        c.provider.fetchMediaInsights!(
          c.ctx,
          c.token,
          c.row.settings,
          page.items.map((m) => m.id),
        ),
      );
      const byId = new Map(insights.map((i) => [i.mediaId, i]));
      const items: MediaWithInsights[] = page.items.map((media) => {
        const found = byId.get(media.id);
        return {
          media,
          metrics: found?.metrics ?? {},
          ...(found?.unavailableReason ? { unavailableReason: found.unavailableReason } : {}),
        };
      });
      return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
  };
};

export type Engagement = ReturnType<typeof makeEngagement>;
