import { describe, expect, test } from 'bun:test';
import type { ChannelProvider, ProviderContext } from '@manypost/contracts';
import { DomainError } from '../../domain/shared/result';
import type { ChannelRecord } from '../ports/publishing';
import { makeEngagement, type EngagementDeps } from './engagement';

const ESCOPOS = {
  comments: 'instagram_business_manage_comments',
  insights: 'instagram_business_manage_insights',
};

const canal = (over: Partial<ChannelRecord> = {}): ChannelRecord => ({
  id: 'ch-1',
  orgId: 'org-1',
  provider: 'instagram-standalone',
  externalId: '17841',
  name: 'Invista',
  username: 'invista',
  avatarUrl: null,
  status: 'ACTIVE',
  scopes: [ESCOPOS.comments, ESCOPOS.insights],
  settings: { userId: '17841' },
  tokenEnc: new Uint8Array([1]),
  refreshTokenEnc: null,
  tokenKeyVersion: 1,
  tokenExpiresAt: null,
  ...over,
});

const ctx: ProviderContext = {
  fetch: (() => {
    throw new Error('rede não deve ser chamada diretamente no core');
  }) as unknown as typeof fetch,
  log: () => {},
  now: () => new Date('2026-10-12T12:00:00Z'),
  secrets: {},
};

/** sobrescritas do provider falso — `undefined` remove o método (provider sem a capacidade) */
type ProviderOverrides = { [K in keyof ChannelProvider]?: ChannelProvider[K] | undefined };

function harness(opts: { canais?: ChannelRecord[]; provider?: ProviderOverrides } = {}) {
  const chamadas: string[] = [];
  const decifrados: string[] = [];
  const auditoria: Array<Record<string, unknown>> = [];
  const provider = {
    id: 'instagram-standalone',
    classifyError: () => 'permanent',
    engagementScopes: ESCOPOS,
    async listRecentMedia(_c, token, settings, page) {
      chamadas.push(`media:${token.accessToken}:${(settings as { userId: string }).userId}:${page.limit}`);
      return { items: [{ id: '9', mediaType: 'IMAGE', timestamp: 't' }], nextCursor: 'C2' };
    },
    async listComments(_c, _t, _s, mediaId) {
      chamadas.push(`comments:${mediaId}`);
      return { items: [] };
    },
    async replyToComment(_c, _t, _s, commentId, message) {
      chamadas.push(`reply:${commentId}:${message}`);
      return { id: 'r1' };
    },
    async setCommentHidden(_c, _t, _s, commentId, hidden) {
      chamadas.push(`hide:${commentId}:${hidden}`);
    },
    async fetchAccountInsights(_c, _t, _s, range) {
      chamadas.push(`account:${range.since.toISOString()}:${range.until.toISOString()}`);
      return {
        since: range.since.toISOString(),
        until: range.until.toISOString(),
        totals: { reach: 1 },
        followersCount: 10,
        mediaCount: 2,
        dailyReach: [],
      };
    },
    async fetchMediaInsights(_c, _t, _s, ids) {
      chamadas.push(`media-insights:${ids.join(',')}`);
      return ids.map((mediaId) => ({ mediaId, metrics: { reach: 5 } }));
    },
    ...opts.provider,
  } as ChannelProvider;

  const deps: EngagementDeps = {
    channels: {
      async findMany(orgId, ids) {
        return (opts.canais ?? [canal()]).filter((c) => c.orgId === orgId && ids.includes(c.id));
      },
    },
    crypto: {
      async encrypt() {
        throw new Error('não usado');
      },
      async decrypt(_ct, aad) {
        decifrados.push(aad);
        return 'TOKEN-PLANO';
      },
    },
    audit: {
      async append(e) {
        auditoria.push(e);
      },
    },
    providerFor: (id) => (id === provider.id ? { provider, ctx } : null),
    now: () => new Date('2026-10-12T12:00:00Z'),
  };
  return { eng: makeEngagement(deps), chamadas, decifrados, auditoria };
}

const ALVO = { orgId: 'org-1', channelId: 'ch-1' };
const ATOR = { type: 'USER' as const, id: 'u-1', ip: '10.0.0.1' };

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return { code: e.code, detail: e.detail, message: e.message };
    throw e;
  }
  throw new Error('esperava DomainError');
};

describe('resolução do canal', () => {
  test('canal de outra organização: not_found e o token nunca é decifrado', async () => {
    const h = harness({ canais: [canal({ orgId: 'org-2' })] });
    expect((await codigo(h.eng.listMedia({ ...ALVO, limit: 12 }))).code).toBe('common.not_found');
    expect(h.decifrados).toEqual([]);
    expect(h.chamadas).toEqual([]);
  });

  test('canal esperando reconexão: refresh_required sem rede', async () => {
    const h = harness({ canais: [canal({ status: 'REFRESH_REQUIRED' })] });
    expect((await codigo(h.eng.accountInsights({ ...ALVO, days: 7 }))).code).toBe(
      'channel.refresh_required',
    );
    expect(h.chamadas).toEqual([]);
  });

  test('provider sem engajamento: capability.disabled sem rede', async () => {
    const h = harness({ provider: { listComments: undefined } });
    expect((await codigo(h.eng.listComments({ ...ALVO, mediaId: '9' }))).code).toBe(
      'capability.disabled',
    );
  });

  test('provider fora do registro/indisponível: capability.disabled', async () => {
    const h = harness({ canais: [canal({ provider: 'x' })] });
    expect((await codigo(h.eng.listMedia({ ...ALVO, limit: 12 }))).code).toBe('capability.disabled');
  });

  test('decifra com o AAD do canal e repassa os settings', async () => {
    const h = harness();
    const page = await h.eng.listMedia({ ...ALVO, limit: 12 });
    expect(page.nextCursor).toBe('C2');
    expect(h.decifrados).toEqual(['org-1:instagram-standalone:17841']);
    expect(h.chamadas).toEqual(['media:TOKEN-PLANO:17841:12']);
  });
});

describe('escopo antes da rede', () => {
  test('sem escopo de métricas: missing_scopes com o nome, sem rede', async () => {
    const h = harness({ canais: [canal({ scopes: [ESCOPOS.comments] })] });
    const e = await codigo(h.eng.accountInsights({ ...ALVO, days: 7 }));
    expect(e.code).toBe('channel.missing_scopes');
    expect(e.detail).toEqual({ missing: [ESCOPOS.insights] });
    expect(h.chamadas).toEqual([]);
  });

  test('sem escopo de comentários: responder é barrado', async () => {
    const h = harness({ canais: [canal({ scopes: [ESCOPOS.insights] })] });
    expect(
      (await codigo(h.eng.reply({ ...ALVO, commentId: '1', message: 'oi', actor: ATOR }))).code,
    ).toBe('channel.missing_scopes');
  });
});

describe('falhas da rede', () => {
  const falha = (errorClass: string, body = '{"error":{"message":"Comentário removido https://x.y/z","code":100}}') =>
    harness({
      provider: {
        async listComments() {
          throw { status: 400, body, errorClass };
        },
      },
    });

  test('token revogado → refresh_required', async () => {
    expect((await codigo(falha('refresh-token').eng.listComments({ ...ALVO, mediaId: '9' }))).code).toBe(
      'channel.refresh_required',
    );
  });

  test('recusa → provider_rejected com a mensagem saneada (sem URL)', async () => {
    const e = await codigo(falha('permanent').eng.listComments({ ...ALVO, mediaId: '9' }));
    expect(e.code).toBe('channel.provider_rejected');
    expect(e.message).toContain('Comentário removido');
    expect(e.message).not.toContain('https://');
  });

  test('instabilidade → provider_failed sem uncertain na leitura', async () => {
    const e = await codigo(falha('transient').eng.listComments({ ...ALVO, mediaId: '9' }));
    expect(e.code).toBe('channel.provider_failed');
    expect(e.detail?.uncertain).toBeUndefined();
  });

  test('sem errorClass, usa o classifyError do provider', async () => {
    const h = harness({
      provider: {
        classifyError: () => 'refresh-token',
        async listComments() {
          throw { status: 401, body: '{}' };
        },
      },
    });
    expect((await codigo(h.eng.listComments({ ...ALVO, mediaId: '9' }))).code).toBe(
      'channel.refresh_required',
    );
  });

  test('transporte caiu depois de enviar a resposta → incerto, uma tentativa só', async () => {
    let tentativas = 0;
    const h = harness({
      provider: {
        async replyToComment() {
          tentativas++;
          throw new TypeError('fetch failed');
        },
      },
    });
    const e = await codigo(h.eng.reply({ ...ALVO, commentId: '1', message: 'oi', actor: ATOR }));
    expect(e.code).toBe('channel.provider_failed');
    expect(e.detail?.uncertain).toBe(true);
    expect(tentativas).toBe(1);
    expect(h.auditoria).toEqual([]);
  });
});

describe('responder e ocultar', () => {
  test('resposta com trim, auditada sem token e sem texto', async () => {
    const h = harness();
    const out = await h.eng.reply({ ...ALVO, commentId: '77', message: '  Olá!  ', actor: ATOR });
    expect(out).toEqual({ id: 'r1' });
    expect(h.chamadas).toEqual(['reply:77:Olá!']);
    expect(h.auditoria).toEqual([
      {
        orgId: 'org-1',
        actorType: 'USER',
        actorId: 'u-1',
        action: 'comment.replied',
        targetType: 'channel',
        targetId: 'ch-1',
        detail: { commentId: '77', replyId: 'r1' },
        ip: '10.0.0.1',
      },
    ]);
    expect(JSON.stringify(h.auditoria)).not.toContain('TOKEN-PLANO');
  });

  test.each([
    ['vazia', '   '],
    ['longa demais', 'a'.repeat(2201)],
  ])('mensagem %s é recusada antes da rede', async (_nome, message) => {
    const h = harness();
    const e = await codigo(h.eng.reply({ ...ALVO, commentId: '1', message, actor: ATOR }));
    expect(e.code).toBe('validation.invalid_request');
    expect(h.chamadas).toEqual([]);
    expect(h.decifrados).toEqual([]);
  });

  test('ocultar e reexibir são auditados com a ação certa', async () => {
    const h = harness();
    await h.eng.setHidden({ ...ALVO, commentId: '5', hidden: true, actor: ATOR });
    await h.eng.setHidden({ ...ALVO, commentId: '5', hidden: false, actor: ATOR });
    expect(h.chamadas).toEqual(['hide:5:true', 'hide:5:false']);
    expect(h.auditoria.map((a) => a.action)).toEqual(['comment.hidden', 'comment.unhidden']);
  });
});

describe('métricas', () => {
  test('período em dias termina agora e começa N dias antes', async () => {
    const h = harness();
    const out = await h.eng.accountInsights({ ...ALVO, days: 7 });
    expect(out.totals.reach).toBe(1);
    expect(h.chamadas).toEqual(['account:2026-10-05T12:00:00.000Z:2026-10-12T12:00:00.000Z']);
  });

  test.each([0, 31, 1.5])('período de %d dias é recusado sem rede', async (days) => {
    const h = harness();
    expect((await codigo(h.eng.accountInsights({ ...ALVO, days }))).code).toBe(
      'validation.invalid_request',
    );
    expect(h.chamadas).toEqual([]);
  });

  test('por post: página de mídia + métricas casadas por id', async () => {
    const h = harness();
    const out = await h.eng.mediaInsights({ ...ALVO, limit: 12 });
    expect(out.nextCursor).toBe('C2');
    expect(out.items).toEqual([
      { media: { id: '9', mediaType: 'IMAGE', timestamp: 't' }, metrics: { reach: 5 } },
    ]);
    expect(h.chamadas).toEqual(['media:TOKEN-PLANO:17841:12', 'media-insights:9']);
  });
});
