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

function harness(opts: { privateReplyError?: unknown; sendErrors?: unknown[]; status?: 'ACTIVE' | 'TEST' } = {}) {
  const mem = memRepo();
  const sent: Sent[] = [];
  const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
  const enqueued: unknown[] = [];
  const sendErrors = [...(opts.sendErrors ?? [])];

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
      async enqueue(_q, payload) {
        enqueued.push(payload);
        return 'job';
      },
    },
    events: {
      async emit(e) {
        emitted.push({ event: e.event, data: e.data });
      },
    },
    log: () => {},
    now: () => new Date('2026-10-12T12:05:00Z'),
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

  return { ...mem, engine, sent, emitted, enqueued, seedAutomation, deliver, comment, message };
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

  test('cria em rascunho com config normalizada e audita', async () => {
    const { svc, audit } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: ' Cotação ', config: CONFIG });
    expect(a).toMatchObject({ name: 'Cotação', status: 'DRAFT' });
    expect(a.config?.opening.mode).toBe('button');
    expect(audit[0]).toMatchObject({ action: 'automation.created', targetId: a.id });
  });

  test('canal de outra org → not_found; canal que não é Instagram → capability.disabled', async () => {
    const { svc } = crud([canal(), canal({ id: 'ch-x', provider: 'linkedin' })]);
    const e1 = await svc.create({ orgId: 'org-2', actor: ATOR, channelId: CH, name: 'x', config: CONFIG }).catch((e) => e);
    expect((e1 as DomainError).code).toBe('common.not_found');
    const e2 = await svc.create({ orgId: ORG, actor: ATOR, channelId: 'ch-x', name: 'x', config: CONFIG }).catch((e) => e);
    expect((e2 as DomainError).code).toBe('capability.disabled');
  });

  test('config inválida → 400 com os campos', async () => {
    const { svc } = crud();
    const bad = { ...CONFIG, opening: { text: 'x', buttonTitle: 'um título grande demais aqui' } };
    const e = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', config: bad }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
    expect(JSON.stringify((e as DomainError).detail)).toContain('opening.buttonTitle');
  });

  test('modo teste exige conta de teste; usernames normalizados', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', config: CONFIG });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
    await svc.update({ orgId: ORG, id: a.id, actor: ATOR, testUsernames: ['@IagoVieira.IA'] });
    const t = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' });
    expect(t).toMatchObject({ status: 'TEST', testUsernames: ['iagovieira.ia'] });
  });

  test('automação de outra org não é lida nem alterada', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', config: CONFIG });
    expect(((await svc.get('org-2', a.id).catch((e) => e)) as DomainError).code).toBe('common.not_found');
    expect(((await svc.remove({ orgId: 'org-2', id: a.id, actor: ATOR }).catch((e) => e)) as DomainError).code).toBe(
      'common.not_found',
    );
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
