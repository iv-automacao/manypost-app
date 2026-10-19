import { describe, expect, test } from 'bun:test';
import type {
  CommentTransport,
  DirectMessage,
  DirectTransport,
  InboundAutomationEvent,
  ProviderFailure,
} from '@manypost/contracts';
import type { DomainError } from '../../domain/shared/result';
import type {
  AutomationGateway,
  AutomationRecord,
  AutomationRepository,
  AutomationRunRecord,
  AutomationTriggerRecord,
  InboundEventRecord,
} from '../ports/automation';
import type { ChannelRecord } from '../ports/publishing';
import { makeAutomationEngine, makeAutomations } from './comment-automation';

const ORG = 'org-1';
const CH = 'ch-1';

const CONFIG = {
  trigger: { keywords: ['cotação'] },
  publicReplies: ['Te chamei no direct!'],
  opening: { text: 'Oi! Toque abaixo.' },
  questions: [
    { kind: 'choice', field: 'plano', prompt: 'Qual plano?', options: [{ title: 'Saúde' }, { title: 'Vida' }] },
    { kind: 'text', field: 'whatsapp', prompt: 'Seu WhatsApp?', validate: 'phone' },
  ],
  finish: { text: 'Valeu!', whatsapp: { phone: '5592999990000', message: 'Quero {plano}' } },
};

const P = { x: 0, y: 0 };
const ed = (source: string, sourceHandle: string, target: string) => ({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });
const FLOW = {
  version: 2,
  nodes: [
    { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
    { id: 'tipo', type: 'message', position: P, data: { text: 'Para quem?', options: [{ id: 'pf', title: 'Pessoa física' }, { id: 'pj', title: 'Minha empresa' }], saveTo: 'tipo' } },
    { id: 'info', type: 'message', position: P, data: { text: 'Empresarial tem condições especiais.', format: 'none' } },
    { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
    { id: 'c', type: 'condition', position: P, data: { field: 'tipo', op: 'equals', value: 'minha empresa' } },
    { id: 'wa', type: 'link', position: P, data: { text: 'Fale com a gente', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: 'Sou {nome}' } } },
    { id: 'fim', type: 'end', position: P, data: { text: 'Obrigado, {nome}!' } },
  ],
  edges: [
    ed('opening', 'next', 'tipo'),
    ed('tipo', 'pf', 'nome'),
    ed('tipo', 'pj', 'info'),
    ed('info', 'next', 'nome'),
    ed('nome', 'next', 'c'),
    ed('c', 'yes', 'wa'),
    ed('c', 'no', 'fim'),
  ],
};
const TRIGGER = [{ kind: 'comment' as const, config: { mediaIds: [], keywords: ['plano'], publicReplies: [] }, position: null }];

/** repositório em memória com a mesma semântica de unicidade do banco */
function memRepo() {
  const automations: AutomationRecord[] = [];
  const runs: AutomationRunRecord[] = [];
  const triggers: AutomationTriggerRecord[] = [];
  const events: Array<InboundEventRecord & { error?: string }> = [];
  let seq = 0;
  const repo: AutomationRepository = {
    async create({ triggers: ts, ...d }) {
      const a = { ...d, id: `auto-${++seq}`, createdAt: new Date(seq), updatedAt: new Date(seq) };
      automations.push(a);
      for (const t of ts ?? []) {
        triggers.push({ ...t, id: `trig-${++seq}`, orgId: a.orgId, automationId: a.id, channelId: a.channelId, createdAt: new Date(seq) });
      }
      return a;
    },
    async update(orgId, id, p, ts) {
      const a = automations.find((x) => x.orgId === orgId && x.id === id);
      if (!a) return null;
      Object.assign(a, p);
      if (ts) {
        for (let i = triggers.length - 1; i >= 0; i--) if (triggers[i]!.automationId === id) triggers.splice(i, 1);
        for (const t of ts) {
          triggers.push({ ...t, id: `trig-${++seq}`, orgId, automationId: id, channelId: a.channelId, createdAt: new Date(seq) });
        }
      }
      return { ...a };
    },
    async get(orgId, id) {
      const a = automations.find((x) => x.orgId === orgId && x.id === id);
      return a ? { ...a } : null;
    },
    async list(orgId) {
      return automations.filter((a) => a.orgId === orgId);
    },
    async softDelete(orgId, id) {
      const i = automations.findIndex((x) => x.orgId === orgId && x.id === id);
      if (i < 0) return false;
      automations.splice(i, 1);
      return true;
    },
    async listTriggerable(channelId) {
      return automations.filter((a) => a.channelId === channelId && (a.status === 'ACTIVE' || a.status === 'TEST'));
    },
    async listTriggers(ids) {
      return triggers.filter((t) => ids.includes(t.automationId));
    },
    async createRun(d) {
      const found = runs.find((r) => r.automationId === d.automationId && r.commentId === d.commentId);
      if (found) return { run: { ...found }, created: false };
      const r: AutomationRunRecord = {
        ...d,
        id: `run-${++seq}`,
        conversationId: null,
        nodeId: null,
        cursor: 0,
        sentCursor: -1,
        status: 'OPEN',
        step: -1,
        promptSentStep: -2,
        reasks: 0,
        answers: {},
        privateReply: 'PENDING',
        finishSentAt: null,
        lastError: null,
        lastInteractionAt: new Date('2026-10-12T12:00:00Z'),
        resumeAt: null,
        lastInboundAt: null,
        reminderSentAt: null,
        completedAt: null,
        leadEmittedAt: null,
        createdAt: new Date(),
      };
      runs.push(r);
      return { run: { ...r }, created: true };
    },
    async getRun(id) {
      const r = runs.find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    async findOpenRun(channelId, who) {
      const r = [...runs]
        .reverse()
        .find(
          (x) =>
            x.channelId === channelId &&
            x.status === 'OPEN' &&
            (who.participantId
              ? x.participantId === who.participantId
              : x.participantUsername?.toLowerCase() === who.username?.toLowerCase()),
        );
      return r ? { ...r } : null;
    },
    async updateRun(id, p) {
      const r = runs.find((x) => x.id === id)!;
      Object.assign(r, p);
      return { ...r };
    },
    async listRuns(orgId) {
      return { items: runs.filter((r) => r.orgId === orgId) };
    },
    async insertInboundEvent(d) {
      if (events.some((e) => e.source === d.source && e.eventId === d.eventId)) return null;
      const id = `ev-${++seq}`;
      events.push({ ...d, id, processedAt: null, attempts: 0 });
      return id;
    },
    async getInboundEvent(id) {
      const e = events.find((x) => x.id === id);
      return e ? { ...e } : null;
    },
    async markInboundEvent(id, o) {
      const e = events.find((x) => x.id === id)!;
      e.attempts++;
      if ('processed' in o) e.processedAt = new Date();
      else e.error = o.error;
    },
  };
  return { repo, automations, runs, events, triggers };
}

type Sent = { op: string; target: string; msg?: DirectMessage; key?: string; text?: string };

function harness(opts: { privateReplyError?: unknown; sendErrors?: unknown[]; status?: 'ACTIVE' | 'TEST'; emitErrors?: unknown[]; noNotifications?: boolean } = {}) {
  const mem = memRepo();
  const sent: Sent[] = [];
  const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
  const enqueued: unknown[] = [];
  const scheduled: Array<{ payload: Record<string, unknown>; startAfter?: Date; singletonKey?: string }> = [];
  const sendErrors = [...(opts.sendErrors ?? [])];
  const emitErrors = [...(opts.emitErrors ?? [])];
  const notified: Array<{ orgId: string; userId?: string | null; kind: string; title: string; body?: string; link?: string }> = [];
  let clock = new Date('2026-10-12T12:05:00Z');

  const comments: CommentTransport = {
    id: 'fake',
    async listComments() {
      return { items: [] };
    },
    async replyToComment(mediaId, commentId, text) {
      sent.push({ op: 'public', target: `${mediaId}/${commentId}`, text });
      return { id: 'pub-1' };
    },
    async setCommentHidden() {},
  };
  const direct: DirectTransport = {
    id: 'fake',
    async privateReply(mediaId, commentId, msg) {
      if (opts.privateReplyError) throw opts.privateReplyError;
      sent.push({ op: 'private', target: `${mediaId}/${commentId}`, msg });
      return { messageId: 'm' };
    },
    async sendMessage(conversationId, msg, key) {
      const err = sendErrors.shift();
      if (err) throw err;
      sent.push({ op: 'send', target: conversationId, msg, key });
      return { messageId: 'm' };
    },
    async typing(conversationId) {
      sent.push({ op: 'typing', target: conversationId });
    },
  };
  const gateway: AutomationGateway = {
    source: 'fake',
    parse: (_t, payload) => payload as InboundAutomationEvent,
    resolve: async (ref) => (ref === 'acc-1' ? { channel: { id: CH, orgId: ORG }, comments, direct } : null),
  };
  const engine = makeAutomationEngine({
    repo: mem.repo,
    gateway,
    scheduler: {
      async enqueue(_q, payload, o) {
        enqueued.push(payload);
        scheduled.push({
          payload: payload as Record<string, unknown>,
          ...(o?.startAfter ? { startAfter: o.startAfter } : {}),
          ...(o?.singletonKey ? { singletonKey: o.singletonKey } : {}),
        });
        return 'job';
      },
    },
    events: {
      async emit(e) {
        const err = emitErrors.shift();
        if (err) throw err;
        emitted.push({ event: e.event, data: e.data });
      },
    },
    ...(opts.noNotifications
      ? {}
      : {
          notifications: {
            async create(n) {
              notified.push(n);
            },
          },
        }),
    log: () => {},
    now: () => clock,
    random: () => 0,
  });

  async function seedAutomation(
    config: unknown = CONFIG,
    testUsernames: string[] = ['iagovieira.ia'],
    triggers?: Array<{ kind: 'comment'; config: unknown; position: null }>,
  ) {
    return mem.repo.create({
      orgId: ORG,
      channelId: CH,
      name: 'Cotação',
      status: opts.status ?? 'ACTIVE',
      config,
      testUsernames,
      createdBy: null,
      ...(triggers ? { triggers } : {}),
    });
  }

  let evSeq = 0;
  async function deliver(payload: InboundAutomationEvent, eventId = `z-${++evSeq}`) {
    const r = await engine.ingest({ eventId, eventType: payload.kind, payload });
    if (r.duplicate) return 'duplicate';
    return engine.process(r.id);
  }

  const comment = (over: Partial<Extract<InboundAutomationEvent, { kind: 'comment' }>> = {}): InboundAutomationEvent => ({
    kind: 'comment',
    accountRef: 'acc-1',
    commentId: 'c-1',
    mediaId: '1801',
    text: 'Quero uma COTACAO',
    authorId: 'igsid-1',
    authorUsername: 'cliente',
    isReply: false,
    isOwn: false,
    ...over,
  });
  const message = (over: Partial<Extract<InboundAutomationEvent, { kind: 'message' }>> = {}): InboundAutomationEvent => ({
    kind: 'message',
    accountRef: 'acc-1',
    conversationId: 'conv-1',
    senderId: 'igsid-1',
    senderUsername: 'cliente',
    text: '',
    payload: null,
    standby: false,
    outgoing: false,
    ...over,
  });

  /** avança o relógio do motor */
  const advance = (sec: number) => {
    clock = new Date(clock.getTime() + sec * 1000);
  };
  const timers = (kind: 'resume' | 'reminder') => scheduled.filter((x) => x.payload.timer === kind);
  /** roda o job de tempo mais recente do tipo (como a fila faria na hora marcada) */
  const fire = (kind: 'resume' | 'reminder') => {
    const t = timers(kind).at(-1);
    if (!t) throw new Error(`nenhum job ${kind} agendado`);
    return engine.processTimer(t.payload as never);
  };
  const failNextSend = (e: unknown) => sendErrors.push(e);

  return { ...mem, engine, sent, emitted, notified, enqueued, scheduled, seedAutomation, deliver, comment, message, advance, timers, fire, failNextSend, now: () => clock };
}

/** toca o botão pelo título usando o payload que a própria mensagem levou */
function tocar(h: ReturnType<typeof harness>, title: string) {
  for (const s of [...h.sent].reverse()) {
    const all = [...(s.msg?.buttons ?? []), ...(s.msg?.quickReplies ?? [])] as Array<{ title: string; payload?: string }>;
    const b = all.find((x) => x.title === title && x.payload);
    if (b) return h.message({ payload: b.payload!, text: title });
  }
  throw new Error(`botão ${title} não encontrado`);
}

describe('comentário → execução', () => {
  test('casa a palavra-chave, responde em público e manda a abertura com botão', async () => {
    const h = harness();
    await h.seedAutomation();
    expect(await h.deliver(h.comment())).toBe('run');
    expect(h.sent.map((s) => s.op)).toEqual(['public', 'private']);
    expect(h.sent[0]?.text).toBe('Te chamei no direct!');
    expect(h.sent[1]?.msg?.buttons?.[0]?.payload).toBe(`mp2:${h.runs[0]!.id}:opening:next`);
    expect(h.runs[0]).toMatchObject({ publicReply: 'SENT', privateReply: 'SENT', nodeId: 'opening', cursor: 0, sentCursor: 0 });
  });

  test('reentrega do mesmo evento não grava nem envia de novo', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment(), 'z-same');
    expect(await h.deliver(h.comment(), 'z-same')).toBe('duplicate');
    expect(h.sent).toHaveLength(2);
    expect(h.enqueued).toHaveLength(1);
  });

  test('mesmo comentário em outro evento retoma sem duplicar', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(h.comment());
    expect(h.runs).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
  });

  test('não reage à própria conta, a resposta de comentário nem a texto sem a palavra', async () => {
    const h = harness();
    await h.seedAutomation();
    expect(await h.deliver(h.comment({ isOwn: true }))).toBe('ignored');
    expect(await h.deliver(h.comment({ commentId: 'c-2', isReply: true }))).toBe('ignored');
    expect(await h.deliver(h.comment({ commentId: 'c-3', text: 'lindo post' }))).toBe('no_match');
    expect(h.sent).toEqual([]);
  });

  test('modo teste só dispara para a conta de teste', async () => {
    const h = harness({ status: 'TEST' });
    await h.seedAutomation();
    expect(await h.deliver(h.comment())).toBe('no_match');
    expect(await h.deliver(h.comment({ commentId: 'c-2', authorUsername: 'IagoVieira.IA' }))).toBe('run');
  });

  test('conta da ponte sem canal é ignorada', async () => {
    const h = harness();
    await h.seedAutomation();
    expect(await h.deliver(h.comment({ accountRef: 'outra' }))).toBe('unknown_account');
  });

  test('resposta privada já gasta → execução falha e nada mais sai', async () => {
    const consumed: ProviderFailure & { consumed: boolean } = {
      status: 400,
      body: '{"error":{"message":"already sent"}}',
      errorClass: 'permanent',
      consumed: true,
    };
    const h = harness({ privateReplyError: consumed });
    await h.seedAutomation();
    await h.deliver(h.comment());
    expect(h.runs[0]).toMatchObject({ status: 'FAILED', privateReply: 'FAILED' });
    expect(h.runs[0]!.lastError).toContain('already sent');
  });

  test('rede caída na resposta privada → incerto, sem retentar', async () => {
    const h = harness({ privateReplyError: new TypeError('fetch failed') });
    await h.seedAutomation();
    await h.deliver(h.comment());
    expect(h.runs[0]).toMatchObject({ status: 'UNCERTAIN', privateReply: 'UNCERTAIN' });
  });

  test('limite (429) na resposta privada → o job falha para retentar', async () => {
    const h = harness({ privateReplyError: { status: 429, body: '{}', errorClass: 'transient' } });
    await h.seedAutomation();
    const ev = await h.engine.ingest({ eventId: 'z-x', eventType: 'comment', payload: h.comment() });
    await expect(h.engine.process((ev as { id: string }).id)).rejects.toThrow();
    expect(h.runs[0]).toMatchObject({ status: 'OPEN', privateReply: 'PENDING' });
  });
});

describe('direct → perguntas → lead', () => {
  async function aberto(h: ReturnType<typeof harness>) {
    await h.seedAutomation();
    await h.deliver(h.comment());
    return h.runs[0]!.id;
  }

  test('fluxo completo: botão da abertura, opção, telefone, fim com WhatsApp e lead uma vez', async () => {
    const h = harness();
    const runId = await aberto(h);

    await h.deliver(tocar(h, 'Quero!'));
    expect(h.sent.at(-1)).toMatchObject({ op: 'send', target: 'conv-1', key: `${runId}:c1:0` });
    expect(h.sent.at(-1)?.msg?.buttons?.map((b) => b.title)).toEqual(['Saúde', 'Vida']);

    await h.deliver(tocar(h, 'Saúde'));
    expect(h.runs[0]!.answers).toEqual({ plano: 'Saúde' });
    expect(h.sent.at(-1)?.msg?.text).toBe('Seu WhatsApp?');

    await h.deliver(h.message({ text: '(92) 98888-7777' }));
    const fim = h.sent.at(-1)!;
    expect(fim.key).toBe(`${runId}:c3:0`);
    expect(fim.msg?.buttons?.[0]?.url).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Quero Saúde')}`);
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { plano: 'Saúde', whatsapp: '92988887777' } });

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      event: 'lead.captured',
      data: { runId, participantUsername: 'cliente', answers: { plano: 'Saúde', whatsapp: '92988887777' } },
    });

    // mensagem depois do fim não reabre nem reemite
    await h.deliver(h.message({ text: 'obrigado' }));
    expect(h.emitted).toHaveLength(1);
  });

  test('opção digitada em vez de tocada também vale', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(h.message({ text: 'vida' }));
    expect(h.runs[0]!.answers).toEqual({ plano: 'Vida' });
  });

  test('telefone inválido re-pergunta uma vez com chave nova; na segunda aceita o texto', async () => {
    const h = harness();
    const runId = await aberto(h);
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Vida'));
    await h.deliver(h.message({ text: 'não sei' }));
    expect(h.sent.at(-1)).toMatchObject({ key: `${runId}:c2:1`, msg: { text: 'Seu WhatsApp?' } });
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', reasks: 1 });
    await h.deliver(h.message({ text: 'liga no fixo' }));
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { plano: 'Vida', whatsapp: 'liga no fixo' } });
  });

  test('toque antigo é ignorado: não avança nem regrava a resposta', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Saúde'));
    const enviados = h.sent.length;
    expect(await h.deliver(tocar(h, 'Vida'))).toBe('duplicate');
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', answers: { plano: 'Saúde' } });
    expect(h.sent.length).toBe(enviados);
  });

  test('mensagens de saída, standby ou de quem não tem execução são ignoradas', async () => {
    const h = harness();
    await aberto(h);
    expect(await h.deliver(h.message({ outgoing: true, text: 'x' }))).toBe('ignored');
    expect(await h.deliver(h.message({ standby: true, text: 'x' }))).toBe('ignored');
    expect(await h.deliver(h.message({ senderId: 'outro', senderUsername: 'outro' }))).toBe('no_run');
    expect(h.runs[0]!.nodeId).toBe('opening');
  });

  test('remetente com id diferente é achado pelo username', async () => {
    const h = harness();
    await aberto(h);
    expect(await h.deliver(h.message({ senderId: 'igsid-outro', senderUsername: 'Cliente', text: 'oi' }))).toBe('advanced');
    expect(h.runs[0]!.nodeId).toBe('q0');
  });

  test('falha transitória ao mandar a pergunta: o job falha e a retentativa entrega uma vez', async () => {
    const h = harness({ sendErrors: [{ status: 503, body: '{}', errorClass: 'transient' }] });
    await aberto(h);
    const ev = await h.engine.ingest({ eventId: 'z-msg', eventType: 'message', payload: tocar(h, 'Quero!') });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    expect(h.runs[0]).toMatchObject({ nodeId: 'q0', cursor: 1, sentCursor: 0 });
    await h.engine.process(id);
    expect(h.sent.filter((s) => s.op === 'send')).toHaveLength(1);
    expect(h.runs[0]!.sentCursor).toBe(1);
  });

  test('automação pausada não conduz a conversa', async () => {
    const h = harness();
    await aberto(h);
    const tap = tocar(h, 'Quero!');
    await h.repo.update(ORG, h.automations[0]!.id, { status: 'PAUSED' });
    expect(await h.deliver(tap)).toBe('paused');
  });

  test('execução v1 em andamento continua com payload mp1', async () => {
    const h = harness();
    const runId = await aberto(h);
    // estado de uma execução criada pelo motor v1: esperando a pergunta 0, prompt já entregue
    Object.assign(h.runs[0]!, { nodeId: null, cursor: 0, sentCursor: -1, step: 0, promptSentStep: 0, conversationId: 'conv-1' });
    const antes = h.sent.length;
    expect(await h.deliver(h.message({ payload: `mp1:${runId}:0:1`, text: 'Vida' }))).toBe('advanced');
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', answers: { plano: 'Vida' } });
    expect(h.sent.slice(antes).map((s) => s.msg?.text)).toEqual(['Seu WhatsApp?']);
  });
});

describe('CRUD', () => {
  const canal = (over: Partial<ChannelRecord> = {}): ChannelRecord => ({
    id: CH,
    orgId: ORG,
    provider: 'instagram-standalone',
    externalId: '17841',
    name: 'Invista',
    username: 'invista',
    avatarUrl: null,
    status: 'ACTIVE',
    scopes: [],
    settings: {},
    tokenEnc: new Uint8Array(),
    refreshTokenEnc: null,
    tokenKeyVersion: 1,
    tokenExpiresAt: null,
    ...over,
  });
  function crud(canais = [canal()]) {
    const mem = memRepo();
    const audit: Array<Record<string, unknown>> = [];
    const svc = makeAutomations({
      repo: mem.repo,
      channels: { findMany: async (orgId, ids) => canais.filter((c) => c.orgId === orgId && ids.includes(c.id)) },
      audit: { append: async (e) => void audit.push(e) },
    });
    return { svc, audit, mem };
  }
  const ATOR = { type: 'USER' as const, id: 'u-1' };
  const SOLTO = { ...FLOW, edges: FLOW.edges.filter((x) => !(x.source === 'tipo' && x.sourceHandle === 'pf')) };

  test('cria em rascunho com fluxo normalizado, gatilho e auditoria', async () => {
    const { svc, audit, mem } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: ' Cotação ', flow: FLOW, triggers: TRIGGER });
    expect(a).toMatchObject({ name: 'Cotação', status: 'DRAFT', problems: [] });
    expect(a.flow?.nodes[0]).toMatchObject({ data: { mode: 'text', disclosure: true } });
    expect(a.triggers).toEqual([{ id: expect.any(String), kind: 'comment', config: { mediaIds: [], keywords: ['plano'], publicReplies: [] }, position: null }]);
    expect(mem.triggers).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'automation.created', targetId: a.id });
  });

  test('automação v1 é lida como grafo, com o gatilho da config', async () => {
    const { svc, mem } = crud();
    const raw = await mem.repo.create({ orgId: ORG, channelId: CH, name: 'v1', status: 'ACTIVE', config: CONFIG, testUsernames: [], createdBy: null });
    const v = await svc.get(ORG, raw.id);
    expect(v.flow?.nodes.map((n) => n.id)).toEqual(['opening', 'q0', 'q1', 'finish', 'end']);
    expect(v.triggers).toEqual([{ id: null, kind: 'comment', config: { mediaIds: [], keywords: ['cotação'], publicReplies: ['Te chamei no direct!'] }, position: null }]);
    expect(v.problems.map((p) => p.code)).toEqual(['opening_button']);
  });

  test('canal de outra org → not_found; canal que não é Instagram → capability.disabled', async () => {
    const { svc } = crud([canal(), canal({ id: 'ch-x', provider: 'linkedin' })]);
    const e1 = await svc.create({ orgId: 'org-2', actor: ATOR, channelId: CH, name: 'x', flow: FLOW }).catch((e) => e);
    expect((e1 as DomainError).code).toBe('common.not_found');
    const e2 = await svc.create({ orgId: ORG, actor: ATOR, channelId: 'ch-x', name: 'x', flow: FLOW }).catch((e) => e);
    expect((e2 as DomainError).code).toBe('capability.disabled');
  });

  test('fluxo fora do formato → validation.invalid_request com os campos', async () => {
    const { svc } = crud();
    const bad = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: 'x', buttonTitle: 'um título grande demais aqui' } }] };
    const e = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: bad }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
    expect(JSON.stringify((e as DomainError).detail)).toContain('buttonTitle');
  });

  test('rascunho salva com problema; Teste/Ativa com problema → automation.flow_invalid', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: SOLTO, triggers: TRIGGER, testUsernames: ['iagovieira.ia'] });
    expect(a.problems).toContainEqual({ code: 'missing_edge', severity: 'error', nodeId: 'tipo', handle: 'pf' });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('automation.flow_invalid');
    expect((e as DomainError).detail?.problems).toBeArray();
    await svc.update({ orgId: ORG, id: a.id, actor: ATOR, flow: FLOW });
    expect((await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' })).status).toBe('TEST');
    const e2 = await svc.update({ orgId: ORG, id: a.id, actor: ATOR, flow: SOLTO }).catch((err) => err);
    expect((e2 as DomainError).code).toBe('automation.flow_invalid');
  });

  test('Teste/Ativa exigem gatilho', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: FLOW, testUsernames: ['iagovieira.ia'] });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
  });

  test('aviso não bloqueia ativação', async () => {
    const { svc } = crud();
    const comBotao = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: 'Oi!', mode: 'button' } }, ...FLOW.nodes.slice(1)] };
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: comBotao, triggers: TRIGGER });
    const v = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'ACTIVE' });
    expect(v.status).toBe('ACTIVE');
    expect(v.problems).toEqual([{ code: 'opening_button', severity: 'warning', nodeId: 'opening' }]);
  });

  test('modo teste exige conta de teste; usernames normalizados', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: FLOW, triggers: TRIGGER });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
    await svc.update({ orgId: ORG, id: a.id, actor: ATOR, testUsernames: ['@IagoVieira.IA'] });
    const t = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' });
    expect(t).toMatchObject({ status: 'TEST', testUsernames: ['iagovieira.ia'] });
  });

  test('automação de outra org não é lida nem alterada', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: FLOW });
    expect(((await svc.get('org-2', a.id).catch((e) => e)) as DomainError).code).toBe('common.not_found');
    expect(((await svc.update({ orgId: 'org-2', id: a.id, actor: ATOR, name: 'y' }).catch((e) => e)) as DomainError).code).toBe('common.not_found');
    expect(((await svc.remove({ orgId: 'org-2', id: a.id, actor: ATOR }).catch((e) => e)) as DomainError).code).toBe('common.not_found');
  });
});

describe('sequência dourada da v1 (equivalência v1 × grafo convertido)', () => {
  /** mensagem sem payload/chave: o que a pessoa vê */
  const visto = (s: Sent) => ({
    op: s.op,
    text: s.msg?.text ?? s.text,
    buttons: s.msg?.buttons?.map((b) => b.title + (b.url ? ` → ${b.url}` : '')) ?? [],
    quick: s.msg?.quickReplies?.map((q) => q.title) ?? [],
  });

  test('toque, opção, telefone inválido, telefone e fim', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Vida'));
    await h.deliver(h.message({ text: 'não sei' }));
    await h.deliver(h.message({ text: '(92) 98888-7777' }));
    expect(h.sent.map(visto)).toEqual([
      { op: 'public', text: 'Te chamei no direct!', buttons: [], quick: [] },
      { op: 'private', text: 'Oi! Toque abaixo.\n\nMensagem automática.', buttons: ['Quero!'], quick: [] },
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
      {
        op: 'send',
        text: 'Valeu!',
        buttons: [`Falar no WhatsApp → https://wa.me/5592999990000?text=${encodeURIComponent('Quero Vida')}`],
        quick: [],
      },
    ]);
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { plano: 'Vida', whatsapp: '92988887777' } });
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.data.whatsappUrl).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Quero Vida')}`);
  });

  test('texto igual ao título da opção vale como toque (caixa ignorada, grava o título)', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(h.message({ text: 'vida' }));
    expect(h.sent.slice(2).map(visto)).toEqual([
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
    ]);
    expect(h.runs[0]!.answers).toEqual({ plano: 'Vida' });
  });

  test('texto inválido duas vezes na escolha segue pela primeira opção com o texto cru', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(h.message({ text: 'sei lá' }));
    await h.deliver(h.message({ text: 'talvez' }));
    expect(h.sent.slice(2).map(visto)).toEqual([
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
    ]);
    expect(h.runs[0]!.answers).toEqual({ plano: 'talvez' });
  });
});

describe('fluxo v2', () => {
  async function aberto(h: ReturnType<typeof harness>, flow: unknown = FLOW) {
    await h.seedAutomation(flow, ['iagovieira.ia'], TRIGGER);
    expect(await h.deliver(h.comment({ text: 'quero o PLANO' }))).toBe('run');
    return h.runs[0]!.id;
  }

  test('gatilho da tabela dispara; abertura em texto chega sem botão e sem resposta pública', async () => {
    const h = harness();
    await aberto(h);
    expect(h.sent.map((s) => s.op)).toEqual(['private']);
    expect(h.sent[0]!.msg).toEqual({ text: 'Oi!\n\nResponda esta mensagem para continuar.\n\nMensagem automática.' });
    expect(h.runs[0]).toMatchObject({ publicReply: 'NONE', nodeId: 'opening' });
  });

  test('ramo empresa: mensagens encadeadas no mesmo evento, condição, link sem saída fecha o lead', async () => {
    const h = harness();
    const runId = await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.sent.at(-1)?.msg?.buttons?.map((b) => b.title)).toEqual(['Pessoa física', 'Minha empresa']);
    const antes = h.sent.length;
    await h.deliver(tocar(h, 'Minha empresa'));
    expect(h.sent.slice(antes).map((s) => [s.key, s.msg?.text])).toEqual([
      [`${runId}:c2:0`, 'Empresarial tem condições especiais.'],
      [`${runId}:c3:0`, 'Seu nome?'],
    ]);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.sent.at(-1)).toMatchObject({ key: `${runId}:c5:0`, msg: { text: 'Fale com a gente' } });
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { tipo: 'Minha empresa', nome: 'Ana' } });
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.data.whatsappUrl).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Sou Ana')}`);
  });

  test('ramo pessoa física vai direto ao nome e termina no fim com texto', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    await h.deliver(tocar(h, 'Pessoa física'));
    expect(h.sent.at(-1)?.msg?.text).toBe('Seu nome?');
    await h.deliver(h.message({ text: 'Bia' }));
    expect(h.sent.at(-1)?.msg?.text).toBe('Obrigado, Bia!');
    expect(h.runs[0]!.status).toBe('COMPLETED');
  });

  test('retry no meio do encadeamento não reenvia a primeira mensagem', async () => {
    const h = harness({ sendErrors: [undefined, undefined, { status: 503, body: '{}', errorClass: 'transient' }] });
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    const ev = await h.engine.ingest({ eventId: 'z-pj', eventType: 'message', payload: tocar(h, 'Minha empresa') });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    await h.engine.process(id);
    expect(h.sent.filter((s) => s.msg?.text === 'Empresarial tem condições especiais.')).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg?.text === 'Seu nome?')).toHaveLength(1);
  });

  test('nó apagado → ABANDONED e nada é enviado', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    await h.deliver(tocar(h, 'Pessoa física'));
    expect(h.runs[0]!.nodeId).toBe('nome');
    const semNome = {
      ...FLOW,
      nodes: FLOW.nodes.filter((n) => n.id !== 'nome'),
      edges: FLOW.edges.filter((x) => x.source !== 'nome' && x.target !== 'nome'),
    };
    await h.repo.update(ORG, h.automations[0]!.id, { config: semNome });
    const antes = h.sent.length;
    expect(await h.deliver(h.message({ text: 'Bia' }))).toBe('abandoned');
    expect(h.runs[0]).toMatchObject({ status: 'ABANDONED' });
    expect(h.sent.length).toBe(antes);
    expect(h.emitted).toHaveLength(0);
  });

  test('dono da conversa é outra ferramenta (409) → execução falha sem retentar', async () => {
    const h = harness({
      sendErrors: [{ status: 409, body: '{"error":{"message":"not_thread_owner"}}', errorClass: 'permanent' }],
    });
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.runs[0]).toMatchObject({ status: 'FAILED' });
    expect(h.runs[0]!.lastError).toContain('not_thread_owner');
  });

  test('laço sem espera gravado à força para no limite de passos', async () => {
    const h = harness();
    const laco = {
      version: 2,
      nodes: [
        { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
        { id: 'i', type: 'message', position: P, data: { text: 'Info', format: 'none' } },
        { id: 'c', type: 'condition', position: P, data: { field: 'x', op: 'filled' } },
        { id: 'fim', type: 'end', position: P, data: {} },
      ],
      edges: [ed('opening', 'next', 'i'), ed('i', 'next', 'c'), ed('c', 'yes', 'fim'), ed('c', 'no', 'i')],
    };
    await aberto(h, laco);
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.runs[0]).toMatchObject({ status: 'FAILED' });
    expect(h.runs[0]!.lastError).toContain('limite');
    expect(h.sent.filter((s) => s.op === 'send').length).toBeLessThanOrEqual(21);
  });
});

describe('retentativa e reentrega (resumabilidade)', () => {
  test('v1: re-ask cujo envio falhou não aceita o mesmo texto na retentativa', async () => {
    const h = harness({ sendErrors: [undefined, undefined, { status: 503, body: '{}', errorClass: 'transient' }] });
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Vida'));
    const ev = await h.engine.ingest({ eventId: 'z-ns', eventType: 'message', payload: h.message({ text: 'não sei' }) });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    await h.engine.process(id);
    expect(h.sent.filter((s) => s.msg?.text === 'Seu WhatsApp?')).toHaveLength(2);
    expect(h.runs[0]!.status).toBe('OPEN');
    expect(h.runs[0]!.answers).toEqual({ plano: 'Vida' });
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', reasks: 1 });
  });

  test('v2: resposta que avançou e cujo envio seguinte falhou não vira resposta do nó seguinte', async () => {
    const h = harness({ sendErrors: [undefined, { status: 503, body: '{}', errorClass: 'transient' }] });
    await h.seedAutomation(FLOW, ['iagovieira.ia'], TRIGGER);
    await h.deliver(h.comment({ text: 'quero o PLANO' }));
    await h.deliver(h.message({ text: 'oi' }));
    const ev = await h.engine.ingest({ eventId: 'z-pf', eventType: 'message', payload: h.message({ text: 'Pessoa física' }) });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    await h.engine.process(id);
    expect(h.sent.filter((s) => s.msg?.text === 'Seu nome?')).toHaveLength(1);
    expect(h.runs[0]!.status).toBe('OPEN');
    expect(h.runs[0]!.answers).toEqual({ tipo: 'Pessoa física' });
    expect(h.runs[0]!.nodeId).toBe('nome');
  });

  test('execução v1 em andamento sobrevive à reentrega do comentário', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    Object.assign(h.runs[0]!, { nodeId: null, cursor: 0, sentCursor: -1, step: 0, promptSentStep: 0, conversationId: 'conv-1' });
    const antes = h.sent.length;
    expect(await h.deliver(h.comment())).toBe('run');
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ status: 'OPEN', nodeId: 'q0' });
    expect(h.sent.length).toBe(antes);
  });
});

describe('atraso por balão (add-flow-delay-reminder)', () => {
  const DELAY = {
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
      { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
      { id: 'wa', type: 'link', position: P, data: { text: 'Fale com a gente', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: '' } } },
      { id: 'seguir', type: 'link', position: P, data: { text: 'Segue a gente', buttonTitle: 'Seguir', target: { kind: 'url', url: 'https://www.instagram.com/x/' }, delaySec: 5 } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Valeu, {nome}!', delaySec: 2 } },
    ],
    edges: [ed('opening', 'next', 'nome'), ed('nome', 'next', 'wa'), ed('wa', 'next', 'seguir'), ed('seguir', 'next', 'fim')],
  };

  async function ateOLink(h: ReturnType<typeof harness>) {
    await h.seedAutomation(DELAY, ['iagovieira.ia'], TRIGGER);
    await h.deliver(h.comment({ text: 'plano' }));
    await h.deliver(h.message({ text: 'oi' }));
    await h.deliver(h.message({ text: 'Ana' }));
    return { ...h.runs[0]! }; // cópia: o repositório em memória muda o objeto depois
  }

  test('o balão com atraso não sai no mesmo evento: digitando, job agendado e envio na hora', async () => {
    const h = harness();
    const run = await ateOLink(h);
    const t0 = h.now().getTime();
    expect(h.sent.slice(-2).map((s) => [s.op, s.msg?.text])).toEqual([
      ['send', 'Fale com a gente'],
      ['typing', undefined],
    ]);
    expect(run).toMatchObject({ nodeId: 'seguir', status: 'OPEN' });
    expect(run.resumeAt?.getTime()).toBe(t0 + 5000);
    const job = h.timers('resume').at(-1)!;
    expect(job.payload).toEqual({ timer: 'resume', runId: run.id, cursor: run.cursor, accountRef: 'acc-1' });
    expect(job.startAfter?.getTime()).toBe(t0 + 5000);

    h.advance(5);
    await h.fire('resume');
    expect(h.sent.filter((s) => s.op === 'send').at(-1)).toMatchObject({ key: `${run.id}:c${run.cursor}:0`, msg: { text: 'Segue a gente' } });
    expect(h.runs[0]).toMatchObject({ nodeId: 'fim', resumeAt: new Date(t0 + 7000) });

    h.advance(2);
    await h.fire('resume');
    expect(h.sent.filter((s) => s.op === 'send').at(-1)?.msg?.text).toBe('Valeu, Ana!');
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', resumeAt: null });
    expect(h.emitted).toHaveLength(1);
  });

  test('mensagem da pessoa durante a espera fica registrada e não antecipa o envio', async () => {
    const h = harness();
    await ateOLink(h);
    const enviados = h.sent.length;
    h.advance(1);
    await h.deliver(h.message({ text: 'e aí?' }));
    expect(h.sent.length).toBe(enviados);
    expect(h.runs[0]!.lastInboundAt?.getTime()).toBe(h.now().getTime());
    h.advance(4);
    await h.fire('resume');
    expect(h.sent.filter((s) => s.msg?.text === 'Segue a gente')).toHaveLength(1);
  });

  test('job antes da hora não envia e reagenda para a hora marcada', async () => {
    const h = harness();
    const run = await ateOLink(h);
    const antes = h.timers('resume').length;
    await h.fire('resume');
    expect(h.sent.some((s) => s.msg?.text === 'Segue a gente')).toBe(false);
    expect(h.timers('resume').length).toBe(antes + 1);
    expect(h.timers('resume').at(-1)!.startAfter).toEqual(run.resumeAt!);
  });

  test('job velho (cursor mudou) ou automação pausada não faz nada', async () => {
    const h = harness();
    const run = await ateOLink(h);
    h.advance(5);
    expect(await h.engine.processTimer({ timer: 'resume', runId: run.id, cursor: run.cursor - 1, accountRef: 'acc-1' })).toBe('stale');
    h.automations[0]!.status = 'PAUSED';
    expect(await h.fire('resume')).toBe('paused');
    expect(h.sent.some((s) => s.msg?.text === 'Segue a gente')).toBe(false);
  });

  test('falha transitória no envio atrasado: o job lança e a retentativa envia uma vez com a mesma chave', async () => {
    const h = harness();
    const run = await ateOLink(h);
    h.advance(5);
    h.failNextSend({ status: 503, body: '{}', errorClass: 'transient' });
    await expect(h.fire('resume')).rejects.toThrow();
    await h.fire('resume');
    const seguir = h.sent.filter((s) => s.msg?.text === 'Segue a gente');
    expect(seguir).toHaveLength(1);
    expect(seguir[0]!.key).toBe(`${run.id}:c${run.cursor}:0`);
  });
});

describe('lembrete "parou no meio" (add-flow-delay-reminder)', () => {
  const REM = {
    version: 2,
    reminder: { afterMinutes: 60, text: '{tipo}, ficou faltando pouco.' },
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
      { id: 'tipo', type: 'message', position: P, data: { text: 'Para quem?', format: 'quick', options: [{ id: 'pf', title: 'Pra mim' }, { id: 'pj', title: 'Empresa' }], saveTo: 'tipo' } },
      { id: 'cidade', type: 'message', position: P, data: { text: 'Em qual cidade?', format: 'quick', options: [{ id: 'mao', title: 'Manaus' }, { id: 'bv', title: 'Boa Vista' }], saveTo: 'cidade' } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Valeu!' } },
    ],
    edges: [
      ed('opening', 'next', 'tipo'),
      ed('tipo', 'pf', 'cidade'),
      ed('tipo', 'pj', 'cidade'),
      ed('cidade', 'mao', 'fim'),
      ed('cidade', 'bv', 'fim'),
    ],
  };

  async function naCidade(h: ReturnType<typeof harness>, flow: unknown = REM) {
    await h.seedAutomation(flow, ['iagovieira.ia'], TRIGGER);
    await h.deliver(h.comment({ text: 'plano' }));
    await h.deliver(h.message({ text: 'oi' }));
    await h.deliver(tocar(h, 'Pra mim'));
    return { ...h.runs[0]! };
  }

  test('parou na cidade: depois do tempo sai o lembrete e, logo depois, a pergunta com as opções', async () => {
    const h = harness();
    const run = await naCidade(h);
    const inbound = run.lastInboundAt!.getTime();
    const job = h.timers('reminder').at(-1)!;
    expect(job.payload).toEqual({ timer: 'reminder', runId: run.id, cursor: run.cursor, accountRef: 'acc-1' });
    expect(job.startAfter?.getTime()).toBe(inbound + 60 * 60_000);

    h.advance(3600);
    expect(await h.fire('reminder')).toBe('reminded');
    // duas mensagens: o texto do lembrete sozinho (sem estourar o limite de 640 com botões) e a pergunta
    const [lembrete, pergunta] = h.sent.slice(-2);
    expect(lembrete).toMatchObject({ key: `${run.id}:rem${run.cursor}`, msg: { text: 'Pra mim, ficou faltando pouco.' } });
    expect(lembrete!.msg).not.toHaveProperty('quickReplies');
    expect(pergunta).toMatchObject({ key: `${run.id}:rem${run.cursor}:q`, msg: { text: 'Em qual cidade?' } });
    expect(pergunta!.msg?.quickReplies?.map((q) => q.title)).toEqual(['Manaus', 'Boa Vista']);
    expect(h.runs[0]!.reminderSentAt).not.toBeNull();

    await h.deliver(tocar(h, 'Manaus'));
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { cidade: 'Manaus' } });
  });

  test('respondeu antes do lembrete: o job não envia nada', async () => {
    const h = harness();
    await naCidade(h);
    const job = h.timers('reminder').at(-1)!;
    await h.deliver(tocar(h, 'Manaus'));
    const enviados = h.sent.length;
    h.advance(3600);
    expect(await h.engine.processTimer(job.payload as never)).toBe('stale');
    expect(h.sent.length).toBe(enviados);
  });

  test('quem não respondeu a abertura não recebe lembrete', async () => {
    const h = harness();
    await h.seedAutomation(REM, ['iagovieira.ia'], TRIGGER);
    await h.deliver(h.comment({ text: 'plano' }));
    expect(h.timers('reminder')).toHaveLength(0);
  });

  test('um lembrete por conversa', async () => {
    const h = harness();
    const flow = {
      ...REM,
      nodes: [...REM.nodes.filter((n) => n.id !== 'fim'), { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } }, { id: 'fim', type: 'end', position: P, data: { text: 'Valeu!' } }],
      edges: [...REM.edges.filter((x) => x.source !== 'cidade'), ed('cidade', 'mao', 'nome'), ed('cidade', 'bv', 'nome'), ed('nome', 'next', 'fim')],
    };
    await naCidade(h, flow);
    h.advance(3600);
    await h.fire('reminder');
    const agendados = h.timers('reminder').length;
    await h.deliver(tocar(h, 'Manaus'));
    expect(h.runs[0]!.nodeId).toBe('nome');
    expect(h.timers('reminder').length).toBe(agendados);
    h.advance(3600);
    expect(await h.fire('reminder')).toBe('stale');
  });

  test('janela de 24 h: agenda no máximo 23 h depois e não envia se a última mensagem passou de 23 h 30', async () => {
    const h = harness();
    const run = await naCidade(h, { ...REM, reminder: { afterMinutes: 1380, text: 'Oi de novo' } });
    expect(h.timers('reminder').at(-1)!.startAfter?.getTime()).toBe(run.lastInboundAt!.getTime() + 23 * 3600_000);
    h.advance(24 * 3600);
    expect(await h.fire('reminder')).toBe('window_closed');
    expect(h.sent.some((s) => s.msg?.text?.startsWith('Oi de novo'))).toBe(false);
  });

  test('lembrete que roda antes da hora (resposta mais nova, toque antigo) reagenda para a hora certa', async () => {
    const h = harness();
    await naCidade(h);
    const velho = h.timers('reminder').at(-1)!;
    h.advance(1800);
    // toque num botão antigo: só registra a mensagem e não arma lembrete novo
    await h.deliver(tocar(h, 'Pra mim'));
    const inbound = h.runs[0]!.lastInboundAt!.getTime();
    h.advance(1800);
    expect(await h.engine.processTimer(velho.payload as never)).toBe('rescheduled');
    expect(h.timers('reminder').at(-1)!.startAfter?.getTime()).toBe(inbound + 3600_000);
    h.advance(1800);
    expect(await h.fire('reminder')).toBe('reminded');
  });

  test('ponte fora do ar no job de tempo: lança para a fila tentar de novo', async () => {
    const h = harness();
    const run = await naCidade(h);
    h.advance(3600);
    await expect(h.engine.processTimer({ timer: 'reminder', runId: run.id, cursor: run.cursor, accountRef: 'acc-fora' })).rejects.toThrow();
  });

  test('falha transitória no lembrete: retentativa envia uma vez só', async () => {
    const h = harness();
    await naCidade(h);
    h.advance(3600);
    h.failNextSend({ status: 503, body: '{}', errorClass: 'transient' });
    await expect(h.fire('reminder')).rejects.toThrow();
    expect(await h.fire('reminder')).toBe('reminded');
    const { id, cursor } = h.runs[0]!;
    expect(h.sent.filter((s) => s.key?.includes(':rem')).map((s) => s.key)).toEqual([`${id}:rem${cursor}`, `${id}:rem${cursor}:q`]);
  });
});

describe('balão de ação', () => {
  const FLOW_ACAO = {
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
      { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
      { id: 'dados', type: 'action', position: P, data: { kind: 'send_data', label: 'nome_coletado' } },
      { id: 'avisa', type: 'action', position: P, data: { kind: 'notify', text: 'Lead novo: {nome}' } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Obrigado, {nome}!' } },
    ],
    edges: [ed('opening', 'next', 'nome'), ed('nome', 'next', 'dados'), ed('dados', 'next', 'avisa'), ed('avisa', 'next', 'fim')],
  };
  async function aberto(h: ReturnType<typeof harness>, testers = ['iagovieira.ia']) {
    await h.seedAutomation(FLOW_ACAO, testers, TRIGGER);
    expect(await h.deliver(h.comment({ text: 'quero o PLANO' }))).toBe('run');
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.sent.at(-1)?.msg?.text).toBe('Seu nome?');
  }

  test('enviar dados e avisar rodam no mesmo evento e o fluxo segue até o fim', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.sent.at(-1)?.msg?.text).toBe('Obrigado, Ana!');
    expect(h.emitted.map((e) => e.event)).toEqual(['lead.updated', 'lead.captured']);
    expect(h.emitted[0]!.data).toMatchObject({
      label: 'nome_coletado',
      nodeId: 'dados',
      runId: h.runs[0]!.id,
      automationName: 'Cotação',
      participantUsername: 'cliente',
      answers: { nome: 'Ana' },
      whatsappUrl: null,
      status: 'OPEN',
      test: false,
    });
    expect(typeof h.emitted[0]!.data.sentAt).toBe('string');
    expect(h.emitted[1]!.data).not.toHaveProperty('label');
    expect(h.notified).toEqual([{ orgId: ORG, userId: null, kind: 'automation.notify', title: 'Cotação', body: 'Lead novo: Ana', link: '/leads' }]);
    expect(h.runs[0]!.status).toBe('COMPLETED');
  });

  test('em modo Teste o lead.updated sai com test: true', async () => {
    const h = harness({ status: 'TEST' });
    await aberto(h, ['cliente']);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.emitted[0]).toMatchObject({ event: 'lead.updated', data: { test: true } });
  });

  test('retry depois da ação não repete o evento nem o aviso', async () => {
    const h = harness({ sendErrors: [undefined, { status: 503, body: '{}', errorClass: 'transient' }] });
    await aberto(h);
    const ev = await h.engine.ingest({ eventId: 'z-ana', eventType: 'message', payload: h.message({ text: 'Ana' }) });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    await h.engine.process(id);
    expect(h.emitted.filter((e) => e.event === 'lead.updated')).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg?.text === 'Obrigado, Ana!')).toHaveLength(1);
  });

  test('falha ao gravar o evento faz o job lançar e a ação sai na retentativa', async () => {
    const h = harness({ emitErrors: [new Error('banco fora')] });
    await aberto(h);
    const ev = await h.engine.ingest({ eventId: 'z-ana', eventType: 'message', payload: h.message({ text: 'Ana' }) });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow('banco fora');
    expect(h.sent.filter((s) => s.msg?.text === 'Obrigado, Ana!')).toHaveLength(0);
    await h.engine.process(id);
    expect(h.emitted.filter((e) => e.event === 'lead.updated')).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg?.text === 'Obrigado, Ana!')).toHaveLength(1);
  });

  test('sem notificações ligadas o aviso é ignorado e o fluxo conclui', async () => {
    const h = harness({ noNotifications: true });
    await aberto(h);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.runs[0]!.status).toBe('COMPLETED');
    expect(h.notified).toHaveLength(0);
  });
});
