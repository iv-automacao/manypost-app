import { describe, expect, test } from 'bun:test';
import type { ProviderFailure } from '@manypost/contracts';
import { makeZernioBridge } from './zernio-bridge';

const KEY = 'sk_test_chave_falsa';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: Record<string, unknown> | null;
}
type Route = (c: Call) => Response | undefined;

/** fetch falso: grava as chamadas e responde pela primeira rota que devolver algo */
function harness(routes: Route[], opts: { now?: () => Date } = {}) {
  const calls: Call[] = [];
  const logs: Array<{ level: string; msg: string; data?: object }> = [];
  const fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(raw)),
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return json({ error: 'não mockado' }, 404);
  }) as typeof globalThis.fetch;
  const bridge = makeZernioBridge({
    apiKey: KEY,
    fetch,
    log: (level, msg, data) => logs.push({ level, msg, ...(data ? { data } : {}) }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { bridge, calls, logs };
}

const ACCOUNTS = {
  accounts: [
    { _id: 'zfb', platform: 'facebook', platformUserId: '17841', username: 'invista', isActive: true },
    { _id: 'zig', platform: 'instagram', platformUserId: '17841', username: 'InvistaSeguros.br', isActive: true },
    { _id: 'zoff', platform: 'instagram', platformUserId: '999', username: 'desligada', isActive: false },
  ],
};
const accountsRoute: Route = (c) => (c.url.pathname === '/api/v1/accounts' ? json(ACCOUNTS) : undefined);

describe('forAccount', () => {
  test('resolve pela id da conta na rede, só Instagram ativo, com Bearer e filtro de plataforma', async () => {
    const { bridge, calls } = harness([accountsRoute]);
    const t = await bridge.forAccount({ platformUserId: '17841' });
    expect(t?.id).toBe('zernio');
    expect(calls[0]?.url.searchParams.get('platform')).toBe('instagram');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  test('cai para o username sem diferenciar caixa', async () => {
    const { bridge } = harness([accountsRoute]);
    expect(await bridge.forAccount({ platformUserId: '000', username: 'invistaseguros.BR' })).not.toBeNull();
  });

  test('conta ausente ou inativa → null', async () => {
    const { bridge } = harness([accountsRoute]);
    expect(await bridge.forAccount({ platformUserId: '42', username: 'outra' })).toBeNull();
    expect(await bridge.forAccount({ platformUserId: '999' })).toBeNull();
  });

  test('guarda a lista por 10 minutos', async () => {
    let t = 0;
    const { bridge, calls } = harness([accountsRoute], { now: () => new Date(t) });
    await bridge.forAccount({ platformUserId: '17841' });
    t = 9 * 60_000;
    await bridge.forAccount({ platformUserId: '17841' });
    expect(calls.length).toBe(1);
    t = 11 * 60_000;
    await bridge.forAccount({ platformUserId: '17841' });
    expect(calls.length).toBe(2);
  });

  test('falha ao listar contas → null com log, sem a chave', async () => {
    const { bridge, logs } = harness([() => json({ error: 'Unauthorized' }, 401)]);
    expect(await bridge.forAccount({ platformUserId: '17841' })).toBeNull();
    expect(logs.some((l) => l.msg === 'zernio.accounts.failed')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });
});

describe('comentários', () => {
  const resolved = async (routes: Route[]) => {
    const h = harness([accountsRoute, ...routes]);
    const t = await h.bridge.forAccount({ platformUserId: '17841' });
    if (!t) throw new Error('ponte não resolveu');
    return { ...h, t };
  };

  test('lista com respostas, oculto, autor próprio e cursor só quando há mais', async () => {
    const { t, calls } = await resolved([
      (c) =>
        c.url.pathname === '/api/v1/inbox/comments/1801'
          ? json({
              comments: [
                {
                  id: '501',
                  message: 'quero saber mais',
                  createdTime: '2026-10-12T10:00:00.000Z',
                  from: { id: 'u1', username: 'cliente', isOwner: false },
                  likeCount: 2,
                  isHidden: true,
                  replies: [
                    {
                      id: '502',
                      message: 'te chamei no direct',
                      createdTime: '2026-10-12T10:05:00.000Z',
                      from: { id: 'o', username: 'invistaseguros.br', isOwner: true },
                    },
                  ],
                },
              ],
              pagination: { hasMore: true, cursor: 'NEXT' },
            })
          : undefined,
    ]);
    const page = await t.listComments('1801', { cursor: 'PREV', limit: 500 });
    const call = calls.at(-1)!;
    expect(call.url.searchParams.get('accountId')).toBe('zig');
    expect(call.url.searchParams.get('cursor')).toBe('PREV');
    expect(call.url.searchParams.get('limit')).toBe('50');
    expect(page.nextCursor).toBe('NEXT');
    expect(page.items[0]).toEqual({
      id: '501',
      text: 'quero saber mais',
      username: 'cliente',
      timestamp: '2026-10-12T10:00:00.000Z',
      likeCount: 2,
      hidden: true,
      fromOwner: false,
      replies: [
        {
          id: '502',
          text: 'te chamei no direct',
          username: 'invistaseguros.br',
          timestamp: '2026-10-12T10:05:00.000Z',
          hidden: false,
          fromOwner: true,
          replies: [],
        },
      ],
    });
  });

  test('sem hasMore não devolve cursor', async () => {
    const { t } = await resolved([
      (c) =>
        c.url.pathname.startsWith('/api/v1/inbox/comments/')
          ? json({ comments: [], pagination: { hasMore: false, cursor: 'X' } })
          : undefined,
    ]);
    expect((await t.listComments('1801', { limit: 25 })).nextCursor).toBeUndefined();
  });

  test('resposta vai no corpo com accountId e commentId', async () => {
    const { t, calls } = await resolved([
      (c) =>
        c.method === 'POST' && c.url.pathname === '/api/v1/inbox/comments/1801'
          ? json({ success: true, data: { commentId: '777', isReply: true } })
          : undefined,
    ]);
    expect(await t.replyToComment('1801', '501', 'oi')).toEqual({ id: '777' });
    expect(calls.at(-1)?.body).toEqual({ accountId: 'zig', message: 'oi', commentId: '501' });
  });

  test('ocultar é POST com accountId no corpo; reexibir é DELETE com accountId na query', async () => {
    const { t, calls } = await resolved([
      (c) => (c.url.pathname === '/api/v1/inbox/comments/1801/501/hide' ? json({ hidden: true }) : undefined),
    ]);
    await t.setCommentHidden('1801', '501', true);
    expect(calls.at(-1)?.method).toBe('POST');
    expect(calls.at(-1)?.body).toEqual({ accountId: 'zig' });
    await t.setCommentHidden('1801', '501', false);
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.at(-1)?.url.searchParams.get('accountId')).toBe('zig');
  });

  test.each([
    [401, 'permanent'],
    [403, 'permanent'],
    [400, 'permanent'],
    [429, 'transient'],
    [502, 'transient'],
  ] as const)('HTTP %d → %s, com a mensagem da Zernio no formato da Meta', async (status, cls) => {
    const { t } = await resolved([
      (c) => (c.url.pathname.startsWith('/api/v1/inbox/') ? json({ error: 'Inbox addon required' }, status) : undefined),
    ]);
    const err = (await t.listComments('1801', { limit: 25 }).catch((e: unknown) => e)) as ProviderFailure;
    expect(err.status).toBe(status);
    expect(err.errorClass).toBe(cls);
    expect(JSON.parse(err.body)).toEqual({ error: { message: 'Inbox addon required' } });
  });
});

describe('accountById', () => {
  test('devolve id na rede e username da conta Instagram pelo id da Zernio', async () => {
    const { bridge } = harness([accountsRoute]);
    expect(await bridge.accountById('zig')).toEqual({ platformUserId: '17841', username: 'InvistaSeguros.br' });
    expect(await bridge.accountById('zfb')).toBeNull();
    expect(await bridge.accountById('nada')).toBeNull();
  });
});

describe('direct (add-comment-automation)', () => {
  const direct = async (routes: Route[]) => {
    const h = harness([accountsRoute, ...routes]);
    const t = await h.bridge.directFor({ platformUserId: '17841' });
    if (!t) throw new Error('ponte não resolveu');
    return { ...h, t };
  };

  test('resposta privada com botões postback e de link', async () => {
    const { t, calls } = await direct([
      (c) =>
        c.url.pathname === '/api/v1/inbox/comments/1801/501/private-reply'
          ? json({ status: 'ok', messageId: 'm-1' })
          : undefined,
    ]);
    const out = await t.privateReply('1801', '501', {
      text: 'Oi!',
      buttons: [
        { title: 'Quero!', payload: 'mp1:r:o:0' },
        { title: 'Site', url: 'https://invista.com.br' },
      ],
    });
    expect(out).toEqual({ messageId: 'm-1' });
    expect(calls.at(-1)?.body).toEqual({
      accountId: 'zig',
      message: 'Oi!',
      buttons: [
        { type: 'postback', title: 'Quero!', payload: 'mp1:r:o:0' },
        { type: 'url', title: 'Site', url: 'https://invista.com.br' },
      ],
    });
  });

  test('resposta privada já gasta → permanente com consumed', async () => {
    const { t } = await direct([
      () => json({ error: 'A private reply has already been sent', details: { privateReplyConsumed: true } }, 400),
    ]);
    const err = (await t.privateReply('1801', '501', { text: 'x' }).catch((e: unknown) => e)) as ProviderFailure & {
      consumed?: boolean;
    };
    expect(err.errorClass).toBe('permanent');
    expect(err.consumed).toBe(true);
  });

  test('502 da resposta privada → incerto', async () => {
    const { t } = await direct([() => json({ error: 'Meta did not confirm', details: { privateReplyOutcome: 'unknown' } }, 502)]);
    const err = (await t.privateReply('1801', '501', { text: 'x' }).catch((e: unknown) => e)) as { uncertain?: boolean };
    expect(err.uncertain).toBe(true);
  });

  test('mensagem na conversa com Idempotency-Key e respostas rápidas', async () => {
    const { t, calls } = await direct([
      (c) =>
        c.url.pathname === '/api/v1/inbox/conversations/conv-1/messages'
          ? json({ success: true, data: { messageId: 'm-2', conversationId: 'conv-1' } })
          : undefined,
    ]);
    const out = await t.sendMessage(
      'conv-1',
      { text: 'Qual plano?', quickReplies: [{ title: 'Saúde', payload: 'mp1:r:0:0' }] },
      'run-1:0:0',
    );
    expect(out).toEqual({ messageId: 'm-2' });
    expect(calls.at(-1)?.headers.get('idempotency-key')).toBe('run-1:0:0');
    expect(calls.at(-1)?.body).toEqual({
      accountId: 'zig',
      message: 'Qual plano?',
      quickReplies: [{ title: 'Saúde', payload: 'mp1:r:0:0' }],
    });
  });
});
