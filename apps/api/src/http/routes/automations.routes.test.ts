import { describe, expect, it } from 'bun:test';
import type { Container } from '../../container';
import { errorHandler } from '../middleware/error';
import { automationRoutes } from './automations.routes';

const ID = '01a0f316-00c2-705c-af90-7803eeb37226';
const CH = '01a0f316-00c2-705c-af90-7803eeb37227';
const FLOW = {
  version: 2,
  nodes: [
    { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: 'Oi!' } },
    { id: 'fim', type: 'end', position: { x: 0, y: 160 }, data: {} },
  ],
  edges: [{ id: 'e1', source: 'opening', sourceHandle: 'next', target: 'fim' }],
};
const TRIGGERS = [{ kind: 'comment', config: { keywords: ['plano'] } }];

function makeApp(role: 'MEMBER' | 'ADMIN' = 'MEMBER') {
  const chamadas: Array<{ op: string; input: unknown }> = [];
  const agora = new Date('2026-10-12T12:00:00Z');
  const view = {
    id: ID,
    orgId: 'org-1',
    channelId: CH,
    name: 'Cotação',
    status: 'DRAFT',
    flow: null,
    triggers: [],
    problems: [],
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

  it('cria com a org do principal, repassa fluxo e gatilho e devolve datas ISO', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/', req('POST', { channelId: CH, name: 'Cotação', flow: FLOW, triggers: TRIGGERS }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { createdAt: string; problems: unknown[]; triggers: unknown[] };
    expect(body.createdAt).toBe('2026-10-12T12:00:00.000Z');
    expect(body.problems).toEqual([]);
    expect(chamadas[0]?.input).toMatchObject({ orgId: 'org-1', channelId: CH, actor: { type: 'USER', id: 'user-1' }, flow: { version: 2 } });
    expect((chamadas[0]?.input as { triggers: Array<{ config: { publicReplies: string[] } }> }).triggers[0]!.config.publicReplies).toEqual([]);
  });

  it('fluxo fora do contrato → 400 sem chamar o caso de uso', async () => {
    const { app, chamadas } = makeApp();
    const bad = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: 'Oi!', buttonTitle: 'um título grande demais aqui' } }] };
    const res = await app.request('/', req('POST', { channelId: CH, name: 'x', flow: bad }));
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('mais de um gatilho → 400', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/', req('POST', { channelId: CH, name: 'x', flow: FLOW, triggers: [...TRIGGERS, ...TRIGGERS] }));
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('problema de fluxo vira 400 automation.flow_invalid com a lista', async () => {
    const { DomainError } = await import('@manypost/core');
    const problems = [{ code: 'missing_edge', severity: 'error', nodeId: 'm', handle: 'b' }];
    const rota = automationRoutes({
      auth: {
        authenticateHuman: async () => ({ userId: 'user-1', orgId: 'org-1', role: 'ADMIN' }),
        verifyApiKey: async () => null,
      },
      automation: {
        automations: {
          setStatus: async () => {
            throw new DomainError('automation.flow_invalid', 'o fluxo tem problemas', { problems });
          },
        },
      },
    } as unknown as Container);
    rota.onError(errorHandler);
    const res = await rota.request(`/${ID}/status`, req('POST', { status: 'ACTIVE' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { title: string; extra: { problems: unknown[] } };
    expect(body.title).toBe('automation.flow_invalid');
    expect(body.extra.problems).toEqual(problems);
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
