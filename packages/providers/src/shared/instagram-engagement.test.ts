import { describe, expect, test } from 'bun:test';
import type { ErrorClass } from '@manypost/contracts';
import { jsonResponse, mockCtx } from '../../test-kit/contract';
import { classifyEngagementError, makeInstagramEngagement } from './instagram-engagement';

const BASE = 'https://graph.instagram.com/v21.0';
const eng = makeInstagramEngagement(BASE);
const ACCOUNT = { userId: '17841', username: 'invista', accessToken: 'IGQlong' };

type Handler = (url: URL, form: Record<string, string>) => Response;
/** roteia pelo pathname + query, na ordem declarada; o form do POST já vem parseado */
const ctxWith = (routes: Array<[(u: URL) => boolean, Handler]>) =>
  mockCtx((raw, init) => {
    const url = new URL(raw);
    const form =
      init?.body === undefined
        ? {}
        : (Object.fromEntries(new URLSearchParams(String(init.body))) as Record<string, string>);
    const hit = routes.find(([match]) => match(url));
    return hit ? hit[1](url, form) : jsonResponse({ error: { message: 'não mockado' } }, 404);
  });

const metaError = (code: number, message = 'erro', status = 400) =>
  jsonResponse({ error: { message, type: 'OAuthException', code } }, status);

describe('listRecentMedia', () => {
  test('pede os campos certos, usa a miniatura do vídeo e devolve o cursor só quando há próxima página', async () => {
    const ctx = ctxWith([
      [
        (u) => u.pathname === '/v21.0/17841/media',
        (u) => {
          expect(u.searchParams.get('limit')).toBe('12');
          expect(u.searchParams.get('after')).toBe('CUR1');
          expect(u.searchParams.get('fields')).toContain('comments_count');
          return jsonResponse({
            data: [
              {
                id: '1',
                media_type: 'VIDEO',
                media_product_type: 'REELS',
                caption: 'reel',
                permalink: 'https://www.instagram.com/reel/a/',
                thumbnail_url: 'https://cdn/t.jpg',
                media_url: 'https://cdn/v.mp4',
                timestamp: '2026-10-01T12:00:00+0000',
                like_count: 5,
                comments_count: 2,
              },
              { id: '2', media_type: 'IMAGE', media_url: 'https://cdn/i.jpg', timestamp: '2026-09-30T12:00:00+0000' },
            ],
            paging: { cursors: { after: 'CUR2' }, next: 'https://graph.instagram.com/next' },
          });
        },
      ],
    ]);
    const page = await eng.listRecentMedia(ctx, ACCOUNT, { cursor: 'CUR1', limit: 12 });
    expect(page.nextCursor).toBe('CUR2');
    expect(page.items[0]).toMatchObject({
      id: '1',
      mediaType: 'VIDEO',
      productType: 'REELS',
      previewUrl: 'https://cdn/t.jpg',
      likeCount: 5,
      commentsCount: 2,
    });
    expect(page.items[1]?.previewUrl).toBe('https://cdn/i.jpg');
  });

  test('sem paging.next não há cursor (fim da lista)', async () => {
    const ctx = ctxWith([
      [() => true, () => jsonResponse({ data: [], paging: { cursors: { after: 'X' } } })],
    ]);
    const page = await eng.listRecentMedia(ctx, ACCOUNT, { limit: 12 });
    expect(page.nextCursor).toBeUndefined();
  });

  test('o token vai na query, nunca no log', async () => {
    const logs: unknown[] = [];
    const ctx = ctxWith([[() => true, () => jsonResponse({ data: [] })]]);
    ctx.log = (...args) => logs.push(args);
    await eng.listRecentMedia(ctx, ACCOUNT, { limit: 5 });
    expect(new URL(ctx.calls[0]!.url).searchParams.get('access_token')).toBe('IGQlong');
    expect(JSON.stringify(logs)).not.toContain('IGQlong');
  });
});

describe('listComments', () => {
  test('mapeia hidden, respostas e marca o que a própria conta escreveu', async () => {
    const ctx = ctxWith([
      [
        (u) => u.pathname === '/v21.0/999/comments',
        () =>
          jsonResponse({
            data: [
              {
                id: 'c1',
                text: 'quero o plano',
                timestamp: '2026-10-01T12:00:00+0000',
                like_count: 1,
                hidden: false,
                username: 'maria',
                from: { id: '555', username: 'maria' },
                replies: {
                  data: [
                    {
                      id: 'r1',
                      text: 'te chamei no direct',
                      timestamp: '2026-10-01T12:05:00+0000',
                      username: 'invista',
                      from: { id: '17841', username: 'invista' },
                    },
                  ],
                },
              },
              { id: 'c2', text: 'spam', timestamp: '2026-10-01T13:00:00+0000', hidden: true, username: 'bot' },
            ],
          }),
      ],
    ]);
    const page = await eng.listComments(ctx, ACCOUNT, '999', { limit: 50 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ id: 'c1', fromOwner: false, hidden: false, username: 'maria' });
    expect(page.items[0]!.replies[0]).toMatchObject({ id: 'r1', fromOwner: true, replies: [] });
    expect(page.items[1]).toMatchObject({ hidden: true, replies: [] });
  });
});

describe('escritas', () => {
  test('resposta vai no corpo form-urlencoded e devolve o id', async () => {
    let form: Record<string, string> = {};
    const ctx = ctxWith([
      [
        (u) => u.pathname === '/v21.0/c1/replies',
        (u, f) => {
          form = f;
          expect(u.search).toBe('');
          return jsonResponse({ id: 'r9' });
        },
      ],
    ]);
    const out = await eng.replyToComment(ctx, ACCOUNT, 'c1', 'Olá, Maria');
    expect(out).toEqual({ id: 'r9' });
    expect(form).toEqual({ message: 'Olá, Maria', access_token: 'IGQlong' });
    expect(ctx.calls[0]!.init?.method).toBe('POST');
  });

  test('ocultar e reexibir mandam hide=true/false', async () => {
    const forms: Array<Record<string, string>> = [];
    const ctx = ctxWith([
      [(u) => u.pathname === '/v21.0/c1', (_u, f) => (forms.push(f), jsonResponse({ success: true }))],
    ]);
    await eng.setCommentHidden(ctx, ACCOUNT, 'c1', true);
    await eng.setCommentHidden(ctx, ACCOUNT, 'c1', false);
    expect(forms.map((f) => f.hide)).toEqual(['true', 'false']);
  });

  test('falha da rede sai classificada', async () => {
    const ctx = ctxWith([[() => true, () => metaError(100, 'Unsupported post request')]]);
    await expect(eng.replyToComment(ctx, ACCOUNT, 'c1', 'oi')).rejects.toMatchObject({
      status: 400,
      errorClass: 'permanent',
    });
  });
});

describe('fetchAccountInsights', () => {
  const range = {
    since: new Date('2026-09-01T00:00:00Z'),
    until: new Date('2026-09-30T00:00:00Z'),
  };

  test('totais num pedido só, seguidores e série diária de alcance', async () => {
    const ctx = ctxWith([
      [
        (u) => u.pathname === '/v21.0/17841/insights' && u.searchParams.get('metric_type') === 'total_value',
        (u) => {
          expect(u.searchParams.get('since')).toBe(String(Date.parse('2026-09-01T00:00:00Z') / 1000));
          return jsonResponse({
            data: (u.searchParams.get('metric') ?? '')
              .split(',')
              .map((name, i) => ({ name, total_value: { value: (i + 1) * 10 } })),
          });
        },
      ],
      [
        (u) => u.pathname === '/v21.0/17841/insights',
        () =>
          jsonResponse({
            data: [
              {
                name: 'reach',
                values: [
                  { value: 3, end_time: '2026-09-02T07:00:00+0000' },
                  { value: 4, end_time: '2026-09-03T07:00:00+0000' },
                ],
              },
            ],
          }),
      ],
      [
        (u) => u.pathname === '/v21.0/17841',
        () => jsonResponse({ followers_count: 1200, media_count: 80 }),
      ],
    ]);
    const out = await eng.fetchAccountInsights(ctx, ACCOUNT, range);
    expect(out.totals.reach).toBe(10);
    expect(out.totals.saves).toBeNumber();
    expect(out.followersCount).toBe(1200);
    expect(out.mediaCount).toBe(80);
    expect(out.dailyReach).toEqual([
      { date: '2026-09-02', value: 3 },
      { date: '2026-09-03', value: 4 },
    ]);
  });

  test('métrica recusada vira null e as outras continuam (uma por chamada)', async () => {
    const ctx = ctxWith([
      [
        (u) => u.pathname.endsWith('/insights') && u.searchParams.get('metric_type') === 'total_value',
        (u) => {
          const metric = u.searchParams.get('metric') ?? '';
          if (metric.includes(',') || metric === 'views') {
            return metaError(100, '(#100) metric[1] must be one of the following values');
          }
          return jsonResponse({ data: [{ name: metric, total_value: { value: 7 } }] });
        },
      ],
      [(u) => u.pathname.endsWith('/insights'), () => jsonResponse({ data: [] })],
      [() => true, () => jsonResponse({ followers_count: 1 })],
    ]);
    const out = await eng.fetchAccountInsights(ctx, ACCOUNT, range);
    expect(out.totals.views).toBeNull();
    expect(out.totals.reach).toBe(7);
    expect(out.totals.likes).toBe(7);
  });

  test('token revogado não degrada: sobe como refresh-token', async () => {
    const ctx = ctxWith([[() => true, () => metaError(190, 'Error validating access token')]]);
    await expect(eng.fetchAccountInsights(ctx, ACCOUNT, range)).rejects.toMatchObject({
      errorClass: 'refresh-token',
    });
  });

  test('série diária e seguidores são best-effort', async () => {
    const ctx = ctxWith([
      [
        (u) => u.searchParams.get('metric_type') === 'total_value',
        () => jsonResponse({ data: [{ name: 'reach', total_value: { value: 1 } }] }),
      ],
      [() => true, () => metaError(1, 'An unknown error occurred', 500)],
    ]);
    const out = await eng.fetchAccountInsights(ctx, ACCOUNT, range);
    expect(out.dailyReach).toEqual([]);
    expect(out.followersCount).toBeNull();
    expect(out.totals.views).toBeNull();
  });
});

describe('fetchMediaInsights', () => {
  test('lê values e total_value, e isola o post recusado', async () => {
    const ctx = ctxWith([
      [
        (u) => u.pathname === '/v21.0/1/insights',
        () =>
          jsonResponse({
            data: [
              { name: 'reach', values: [{ value: 100 }] },
              { name: 'saved', total_value: { value: 4 } },
            ],
          }),
      ],
      [(u) => u.pathname === '/v21.0/2/insights', () => metaError(10, 'Not enough viewers')],
    ]);
    const out = await eng.fetchMediaInsights(ctx, ACCOUNT, ['1', '2']);
    expect(out[0]).toMatchObject({ mediaId: '1', metrics: { reach: 100, saved: 4, likes: null } });
    expect(out[1]?.mediaId).toBe('2');
    expect(out[1]?.metrics.reach).toBeNull();
    expect(out[1]?.unavailableReason).toBe('Not enough viewers');
  });

  test('métrica que não vale para o tipo do post é refeita uma a uma', async () => {
    const ctx = ctxWith([
      [
        (u) => u.pathname === '/v21.0/1/insights',
        (u) => {
          const metric = u.searchParams.get('metric') ?? '';
          if (metric.includes(',') || metric === 'views') return metaError(100, 'metric not supported');
          return jsonResponse({ data: [{ name: metric, values: [{ value: 2 }] }] });
        },
      ],
    ]);
    const [one] = await eng.fetchMediaInsights(ctx, ACCOUNT, ['1']);
    expect(one?.metrics.views).toBeNull();
    expect(one?.metrics.reach).toBe(2);
    expect(one?.unavailableReason).toBeUndefined();
  });

  test('token revogado num post derruba a operação (reconectar)', async () => {
    const ctx = ctxWith([[() => true, () => metaError(190, 'Error validating access token', 401)]]);
    await expect(eng.fetchMediaInsights(ctx, ACCOUNT, ['1'])).rejects.toMatchObject({
      errorClass: 'refresh-token',
    });
  });

  test('no máximo 4 chamadas simultâneas', async () => {
    let live = 0;
    let peak = 0;
    const ctx = mockCtx(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return jsonResponse({ data: [] });
    });
    await eng.fetchMediaInsights(ctx, ACCOUNT, ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(peak).toBeLessThanOrEqual(4);
    expect(ctx.calls).toHaveLength(9);
  });
});

describe('classifyEngagementError', () => {
  test.each<[number, string, ErrorClass]>([
    [401, '{"error":{"code":190}}', 'refresh-token'],
    [400, '{"error":{"type":"OAuthException","code":190,"error_subcode":463}}', 'refresh-token'],
    // (#10) também é "Not enough viewers" num post isolado: não pede reconexão
    [403, '{"error":{"type":"OAuthException","code":10}}', 'permanent'],
    [400, '{"error":{"type":"OAuthException","code":200}}', 'refresh-token'],
    [400, '{"error":{"type":"OAuthException","code":100}}', 'permanent'],
    [400, '{"error":{"type":"OAuthException","code":4}}', 'transient'],
    [400, '{"error":{"code":613}}', 'transient'],
    [429, '{}', 'transient'],
    [503, 'gateway', 'transient'],
    [404, '{"error":{"code":803}}', 'permanent'],
  ])('%i %s → %s', (status, body, expected) => {
    expect(classifyEngagementError(status, body)).toBe(expected);
  });
});
