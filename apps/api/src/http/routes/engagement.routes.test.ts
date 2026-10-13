import { describe, expect, it } from 'bun:test';
import { DomainError } from '@manypost/core';
import type { Container } from '../../container';
import { errorHandler } from '../middleware/error';
import { engagementRoutes } from './engagement.routes';

const AUTH = { authorization: 'Bearer clerk-session' };
const CH = '01a0f316-00c2-705c-af90-7803eeb37226';

/** store de idempotência em memória — mesmo contrato do Redis */
function memoryIdempotency() {
  const keys = new Map<string, { fp: string; response?: { status: number; body: string } }>();
  return {
    async claim(key: string, fingerprint: string) {
      const hit = keys.get(key);
      if (!hit) {
        keys.set(key, { fp: fingerprint });
        return { outcome: 'claimed' as const };
      }
      if (hit.fp !== fingerprint) return { outcome: 'conflict' as const };
      return hit.response
        ? { outcome: 'replay' as const, response: hit.response }
        : { outcome: 'pending' as const };
    },
    async store(key: string, response: { status: number; body: string }) {
      const hit = keys.get(key);
      if (hit) hit.response = response;
    },
    async release(key: string) {
      keys.delete(key);
    },
  };
}

function makeApp(over: Record<string, unknown> = {}) {
  const chamadas: Array<{ op: string; input: Record<string, unknown> }> = [];
  const registra = (op: string, out: unknown) => async (input: Record<string, unknown>) => {
    chamadas.push({ op, input });
    return out;
  };
  const engagement = {
    listMedia: registra('listMedia', { items: [{ id: '9', mediaType: 'IMAGE', timestamp: 't' }] }),
    listComments: registra('listComments', { items: [] }),
    reply: registra('reply', { id: 'r-1' }),
    setHidden: registra('setHidden', undefined),
    accountInsights: registra('accountInsights', {
      since: 'a',
      until: 'b',
      totals: { reach: 1, views: null },
      followersCount: 3,
      mediaCount: 1,
      dailyReach: [],
    }),
    mediaInsights: registra('mediaInsights', { items: [] }),
    ...over,
  };
  const ctn = {
    auth: {
      authenticateHuman: async (token: string) =>
        token === 'clerk-session' ? { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' as const } : null,
      verifyApiKey: async () => null,
    },
    runtime: { rateLimiter: null, idempotency: memoryIdempotency() },
    engagement,
  } as unknown as Container;
  const app = engagementRoutes(ctn);
  app.onError(errorHandler);
  return { app, chamadas };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('rotas de engajamento', () => {
  it('recusa sem sessão', async () => {
    const { app, chamadas } = makeApp();
    expect((await app.request(`/${CH}/media`)).status).toBe(401);
    expect(chamadas).toEqual([]);
  });

  it('lista mídia com a org do principal e o cursor da query', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/${CH}/media?cursor=QVFI&orgId=outra`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(chamadas[0]).toEqual({
      op: 'listMedia',
      input: { orgId: 'org-1', channelId: CH, cursor: 'QVFI', limit: 12 },
    });
  });

  it.each(['..%2Fme', 'abc', '12%3Fx%3D1'])('id de mídia "%s" morre na borda, sem rede', async (id) => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/${CH}/media/${id}/comments`, { headers: AUTH });
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('id de comentário não numérico também', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/${CH}/comments/me/replies`, post({ message: 'oi' }));
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('channel id precisa ser uuid', async () => {
    const { app } = makeApp();
    expect((await app.request('/nao-uuid/media', { headers: AUTH })).status).toBe(400);
  });

  it('resposta repassa o ator humano e devolve 201', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(
      `/${CH}/comments/1789/replies`,
      post({ message: 'Olá' }, { 'x-forwarded-for': '10.1.1.1, 172.16.0.1' }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'r-1' });
    expect(chamadas[0]).toEqual({
      op: 'reply',
      input: {
        orgId: 'org-1',
        channelId: CH,
        commentId: '1789',
        message: 'Olá',
        actor: { type: 'USER', id: 'user-1', ip: '10.1.1.1' },
      },
    });
  });

  it('mesma Idempotency-Key responde de novo sem responder duas vezes na rede', async () => {
    const { app, chamadas } = makeApp();
    const headers = { 'idempotency-key': 'k-1' };
    const a = await app.request(`/${CH}/comments/1789/replies`, post({ message: 'Olá' }, headers));
    const b = await app.request(`/${CH}/comments/1789/replies`, post({ message: 'Olá' }, headers));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get('idempotency-replayed')).toBe('true');
    expect(await b.json()).toEqual({ id: 'r-1' });
    expect(chamadas.filter((c) => c.op === 'reply')).toHaveLength(1);
  });

  it('visibilidade aceita hidden booleano e responde 204', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/${CH}/comments/55/visibility`, post({ hidden: true }));
    expect(res.status).toBe(204);
    expect(chamadas[0]?.input).toMatchObject({ commentId: '55', hidden: true });
  });

  it('mediaId opcional nas escritas: repassado quando vem, 400 quando não é numérico', async () => {
    const { app, chamadas } = makeApp();
    const ok = await app.request(`/${CH}/comments/1789/replies`, post({ message: 'Olá', mediaId: '1801' }));
    expect(ok.status).toBe(201);
    expect(chamadas[0]?.input).toMatchObject({ mediaId: '1801', commentId: '1789' });
    const vis = await app.request(`/${CH}/comments/55/visibility`, post({ hidden: false, mediaId: '1801' }));
    expect(vis.status).toBe(204);
    expect(chamadas[1]?.input).toMatchObject({ mediaId: '1801', hidden: false });
    const bad = await app.request(`/${CH}/comments/55/visibility`, post({ hidden: true, mediaId: '../me' }));
    expect(bad.status).toBe(400);
    expect(chamadas).toHaveLength(2);
  });

  it('insights da conta: dias padrão 28 e números nulos preservados', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/${CH}/insights`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { totals: Record<string, unknown> }).totals.views).toBeNull();
    expect(chamadas[0]?.input).toEqual({ orgId: 'org-1', channelId: CH, days: 28 });
  });

  it('insights da conta: dias fora de 1..30 é 400 na borda', async () => {
    const { app, chamadas } = makeApp();
    expect((await app.request(`/${CH}/insights?days=45`, { headers: AUTH })).status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it.each([
    ['channel.refresh_required', 409],
    ['channel.missing_scopes', 403],
    ['channel.provider_rejected', 422],
    ['channel.provider_failed', 502],
    ['capability.disabled', 404],
  ])('%s vira HTTP %i em problem+json', async (code, status) => {
    const { app } = makeApp({
      listComments: async () => {
        throw new DomainError(code, 'msg', code === 'channel.provider_failed' ? { uncertain: true } : undefined);
      },
    });
    const res = await app.request(`/${CH}/media/123/comments`, { headers: AUTH });
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(((await res.json()) as { title: string }).title).toBe(code);
  });
});
