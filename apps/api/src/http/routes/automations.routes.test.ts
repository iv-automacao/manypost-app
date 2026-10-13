import { describe, expect, it } from 'bun:test';
import type { Container } from '../../container';
import { errorHandler } from '../middleware/error';
import { automationRoutes } from './automations.routes';

const ID = '01a0f316-00c2-705c-af90-7803eeb37226';
const CH = '01a0f316-00c2-705c-af90-7803eeb37227';
const CONFIG = {
  trigger: { keywords: ['cotação'] },
  opening: { text: 'Oi!' },
  finish: { text: 'Valeu!' },
};

function makeApp(role: 'MEMBER' | 'ADMIN' = 'MEMBER') {
  const chamadas: Array<{ op: string; input: unknown }> = [];
  const agora = new Date('2026-10-12T12:00:00Z');
  const view = {
    id: ID,
    orgId: 'org-1',
    channelId: CH,
    name: 'Cotação',
    status: 'DRAFT',
    config: null,
    testUsernames: [],
    createdBy: 'user-1',
    createdAt: agora,
    updatedAt: agora,
  };
  const registra = (op: string, ret: unknown) => async (...args: unknown[]) => {
    chamadas.push({ op, input: args.length === 1 ? args[0] : args });
    return ret;
  };
  const ctn = {
    auth: {
      authenticateHuman: async (t: string) => (t === 'sessao' ? { userId: 'user-1', orgId: 'org-1', role } : null),
      verifyApiKey: async () => null,
    },
    automation: {
      automations: {
        list: registra('list', [view]),
        get: registra('get', view),
        create: registra('create', view),
        update: registra('update', view),
        setStatus: registra('setStatus', { ...view, status: 'TEST' }),
        remove: registra('remove', undefined),
        leads: registra('leads', { items: [] }),
      },
    },
  } as unknown as Container;
  const app = automationRoutes(ctn);
  app.onError(errorHandler);
  return { app, chamadas };
}

const AUTH = { authorization: 'Bearer sessao', 'content-type': 'application/json' };
const req = (method: string, body?: unknown) => ({
  method,
  headers: AUTH,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('rotas de automação', () => {
  it('sem sessão → 401', async () => {
    const { app, chamadas } = makeApp();
    expect((await app.request('/')).status).toBe(401);
    expect(chamadas).toEqual([]);
  });

  it('cria com a org do principal e devolve datas ISO', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/', req('POST', { channelId: CH, name: 'Cotação', config: CONFIG }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { createdAt: string }).createdAt).toBe('2026-10-12T12:00:00.000Z');
    expect(chamadas[0]?.input).toMatchObject({ orgId: 'org-1', channelId: CH, actor: { type: 'USER', id: 'user-1' } });
  });

  it('configuração fora do contrato → 400 sem chamar o caso de uso', async () => {
    const { app, chamadas } = makeApp();
    const bad = { ...CONFIG, opening: { text: 'Oi!', buttonTitle: 'um título grande demais aqui' } };
    const res = await app.request('/', req('POST', { channelId: CH, name: 'x', config: bad }));
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('mudar status exige ADMIN/OWNER', async () => {
    const membro = makeApp('MEMBER');
    expect((await membro.app.request(`/${ID}/status`, req('POST', { status: 'ACTIVE' }))).status).toBe(403);
    expect(membro.chamadas).toEqual([]);
    const admin = makeApp('ADMIN');
    const res = await admin.app.request(`/${ID}/status`, req('POST', { status: 'TEST' }));
    expect(res.status).toBe(200);
    expect(admin.chamadas[0]?.input).toMatchObject({ orgId: 'org-1', id: ID, status: 'TEST' });
  });

  it('apagar exige ADMIN/OWNER', async () => {
    expect((await makeApp('MEMBER').app.request(`/${ID}`, req('DELETE'))).status).toBe(403);
    expect((await makeApp('ADMIN').app.request(`/${ID}`, req('DELETE'))).status).toBe(204);
  });

  it('/leads não é capturada como id e repassa filtros', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request(`/leads?status=COMPLETED&automationId=${ID}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(chamadas[0]).toEqual({
      op: 'leads',
      input: ['org-1', { automationId: ID, status: 'COMPLETED', limit: 50 }],
    });
  });

  it('id que não é uuid → 400', async () => {
    const { app } = makeApp();
    expect((await app.request('/nao-uuid', { headers: AUTH })).status).toBe(400);
  });
});
