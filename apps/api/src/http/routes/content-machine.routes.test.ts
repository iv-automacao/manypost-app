import { describe, expect, it } from 'bun:test';
import { DomainError } from '@manypost/core';
import type { Container } from '../../container';
import { errorHandler } from '../middleware/error';
import { contentMachineRoutes } from './content-machine.routes';

const AUTH = { authorization: 'Bearer clerk-session', 'content-type': 'application/json' };
const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const peca = {
  id: ID, orgId: 'org-1', status: 'revisao', format: 'post', pillar: 'educar', icp: '', market: 'manaus', awareness: '', hook: 'g',
  plan: {}, script: null, caption: 'c', hashtags: [], keyword: 'PLANO-1001-A', media: [{ mediaId: 'm1', kind: 'image', order: 1 }],
  review: null, feedback: [], attempts: 0, scheduledFor: null, channelId: null, postGroupId: null, publishedAt: null, permalink: null,
  costUsd: 0.01, error: null, lockedUntil: null, createdAt: new Date(), updatedAt: new Date(),
};

function makeApp() {
  const chamadas: Array<{ fn: string; args: unknown[] }> = [];
  const registra = (fn: string, ret: unknown) => async (...args: unknown[]) => {
    chamadas.push({ fn, args });
    return typeof ret === 'function' ? (ret as (...a: unknown[]) => unknown)(...args) : ret;
  };
  const ctn = {
    auth: {
      authenticateHuman: async (token: string) =>
        token === 'clerk-session' ? { userId: 'user-1', orgId: 'org-1', role: 'OWNER' as const } : null,
      verifyApiKey: async () => null,
    },
    repos: { media: { findMany: async (orgId: string) => (orgId === 'org-1' ? [{ id: 'm1', path: 'org-1/a.png', mime: 'image/png' }] : []) } },
    contentMachine: {
      capabilities: { text: true, renderer: true, video: false, videoModel: null },
      publicUrl: (p: string) => `https://post.exemplo/uploads/${p}`,
      setup: registra('setup', { orgId: 'org-1', name: 'Invista', logoMediaId: null, logoDarkMediaId: null, palette: {}, slogan: '', signature: '', tone: '', defaultChannelId: null, ctaChannel: 'direct', whatsappNumber: '', publishHour: 18, timezone: 'America/Manaus', autoApprove: true, updatedAt: new Date() }),
      repo: {
        listPieces: registra('listPieces', [peca]),
        listFoundations: registra('listFoundations', [{ key: 'icp', body: 'x', validUntil: null, updatedAt: new Date() }]),
        getPiece: registra('getPiece', (orgId: unknown, id: unknown) => (orgId === 'org-1' && id === ID ? peca : null)),
        events: registra('events', []),
      },
      decide: registra('decide', (_a: unknown, _id: unknown, d: { action: string }) => {
        if (d.action === 'approve') throw new DomainError('content.invalid_transition', 'mudou de etapa');
        return peca;
      }),
      createPiece: registra('createPiece', peca),
    },
  } as unknown as Container;
  const app = contentMachineRoutes(ctn);
  app.onError(errorHandler);
  return { app, chamadas };
}

describe('/v1/content-machine', () => {
  it('recusa sem sessão e não toca em nada', async () => {
    const { app, chamadas } = makeApp();
    expect((await app.request('/overview')).status).toBe(401);
    expect((await app.request('/pieces', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(chamadas).toHaveLength(0);
  });

  it('overview configura a org do principal e conta por etapa', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/overview?orgId=outra', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; foundationFilled: number; brand: { name: string } };
    expect(body.counts.revisao).toBe(1);
    expect(body.foundationFilled).toBe(1);
    expect(chamadas.find((c) => c.fn === 'setup')!.args[0]).toBe('org-1');
  });

  it('lista peças com a URL pública das mídias', async () => {
    const { app } = makeApp();
    const res = await app.request('/pieces?status=revisao,inventado', { headers: AUTH });
    const body = (await res.json()) as Array<{ media: Array<{ url: string }>; orgId?: string }>;
    expect(body[0]!.media[0]!.url).toBe('https://post.exemplo/uploads/org-1/a.png');
    expect(body[0]!.orgId).toBeUndefined();
  });

  it('peça inexistente ou de outra org é 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/pieces/0190a1b2-c3d4-7e5f-8a9b-000000000000', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('transição inválida vira 409', async () => {
    const { app } = makeApp();
    const res = await app.request(`/pieces/${ID}/decision`, { method: 'POST', headers: AUTH, body: JSON.stringify({ action: 'approve' }) });
    expect(res.status).toBe(409);
  });

  it('refazer exige o pedido de ajuste', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/pieces/${ID}/decision`, { method: 'POST', headers: AUTH, body: JSON.stringify({ action: 'redo', stage: 'roteiro' }) });
    expect(res.status).toBe(400);
    expect(chamadas.some((c) => c.fn === 'decide')).toBe(false);
  });

  it('cria peça com o ator do principal', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/pieces', { method: 'POST', headers: AUTH, body: JSON.stringify({ format: 'reels', hook: 'Servidor, este é pra você.' }) });
    expect(res.status).toBe(201);
    expect(chamadas.find((c) => c.fn === 'createPiece')!.args[0]).toEqual({ orgId: 'org-1', userId: 'user-1' });
  });
});
