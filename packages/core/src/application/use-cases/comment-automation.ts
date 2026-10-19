import type {
  ActorType,
  AutomationRunStatus,
  AutomationStatus,
  CommentAutomationConfig,
  CommentTransport,
  CommentTriggerConfig,
  DirectMessage,
  DirectTransport,
  FlowProblem,
  FlowV2,
  InboundCommentEvent,
  InboundMessageEvent,
  ProviderFailure,
} from '@manypost/contracts';
import {
  AnyAutomationConfigSchema,
  CommentTriggerConfigSchema,
  ErrorCodes,
  FlowTriggerInputSchema,
  FlowV2Schema,
  WebhookEvents,
} from '@manypost/contracts';
import { z } from 'zod';
import { decodePayload, matchesCommentTrigger, renderTemplate } from '../../domain/automation/automation-logic';
import { flowFromV1, nodeForV1Step, tapFromV1, triggerFromV1 } from '../../domain/automation/flow-from-v1';
import { nodeById, openingOf, targetOf, waits } from '../../domain/automation/flow-graph';
import {
  MAX_AUTO_STEPS,
  actionFor,
  autoNext,
  decideInput,
  decodePayloadV2,
  delayOf,
  leadWhatsappUrl,
  messageFor,
  type ActionEffect,
} from '../../domain/automation/flow-step';
import { hasErrors, validateFlow } from '../../domain/automation/flow-validate';
import { DomainError } from '../../domain/shared/result';
import type { AuditLogRepository, NotificationRepository } from '../ports/approvals';
import type {
  AutomationGateway,
  AutomationRecord,
  AutomationRepository,
  AutomationRunPatch,
  AutomationRunRecord,
  AutomationTriggerInput,
  AutomationTriggerRecord,
} from '../ports/automation';
import type { EventPublisher } from '../ports/events';
import type { JobScheduler } from '../ports/job-scheduler';
import type { ChannelRepository } from '../ports/publishing';

/**
 * Automação comentário → direct (openspec add-comment-automation).
 *
 * `makeAutomations`: CRUD por organização. `makeAutomationEngine`: ingestão do webhook da ponte e o
 * motor que roda na fila `automation-event` (serial). O motor é retomável (design D5): cada efeito
 * externo é gravado logo depois de confirmado e todo processamento termina em `ensureProgress`, que
 * só faz o que ainda falta — por isso reprocessar o mesmo evento nunca envia duas vezes.
 */

export const AUTOMATION_EVENT_QUEUE = 'automation-event';
/** providers cujo canal pode ter automação (a ponte resolve pela conta do Instagram) */
export const AUTOMATION_PROVIDERS = ['instagram-standalone', 'instagram'] as const;
/** a resposta privada vale 7 dias; depois disso a execução aberta não é mais retomada */
const RUN_WINDOW_MS = 7 * 86_400_000;
/** o lembrete sai no máximo 23 h depois da última mensagem da pessoa (janela de 24 h da Meta) */
const REMINDER_CAP_MS = 23 * 3_600_000;
/** folga para a fila atrasar o job sem estourar a janela */
const REMINDER_GRACE_MS = 30 * 60_000;

/**
 * Job de tempo (add-flow-delay-reminder): vai na mesma fila serial dos eventos, então nunca corre em
 * paralelo com outro evento da mesma conversa. `accountRef` monta o transporte pela ponte.
 */
export interface AutomationTimerJob {
  timer: 'resume' | 'reminder';
  runId: string;
  cursor: number;
  accountRef: string;
}

// ---------------------------------------------------------------- fluxo carregado

export interface LoadedFlow {
  flow: FlowV2;
  /** configuração v1 original quando a automação ainda não foi salva pelo canvas */
  legacy: CommentAutomationConfig | null;
}

/** v2 como está; v1 convertida na leitura, sem gravar (design D4) */
export function loadFlow(raw: unknown): LoadedFlow | null {
  const r = AnyAutomationConfigSchema.safeParse(raw);
  if (!r.success) return null;
  return r.data.version === 2 ? { flow: r.data, legacy: null } : { flow: flowFromV1(r.data), legacy: r.data };
}

/** gatilho de comentário da automação: a linha da tabela; sem linha, o `config.trigger` da v1 */
export function commentTriggerOf(
  automationId: string,
  triggers: AutomationTriggerRecord[],
  loaded: LoadedFlow,
): CommentTriggerConfig | null {
  const row = triggers.find((t) => t.automationId === automationId && t.kind === 'comment');
  if (row) {
    const p = CommentTriggerConfigSchema.safeParse(row.config);
    return p.success ? p.data : null;
  }
  return loaded.legacy ? triggerFromV1(loaded.legacy) : null;
}

// ---------------------------------------------------------------- CRUD

export interface AutomationActor {
  type: ActorType;
  id: string | null;
  ip?: string | null;
}

export interface AutomationsDeps {
  repo: AutomationRepository;
  channels: Pick<ChannelRepository, 'findMany'>;
  audit: AuditLogRepository;
}

export interface AutomationTriggerView {
  /** `null` = gatilho ainda dentro da config v1 (sem linha na tabela) */
  id: string | null;
  kind: 'comment';
  config: CommentTriggerConfig;
  position: { x: number; y: number } | null;
}

export interface AutomationView extends Omit<AutomationRecord, 'config'> {
  /** grafo v2 (v1 convertida na leitura); `null` = config gravada não passa mais na validação */
  flow: FlowV2 | null;
  triggers: AutomationTriggerView[];
  problems: FlowProblem[];
}

const invalid = (message: string, detail?: Record<string, unknown>) =>
  new DomainError(ErrorCodes.ValidationInvalidRequest, message, detail);

const issuesOf = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

function parseFlow(raw: unknown): FlowV2 {
  const r = FlowV2Schema.safeParse(raw);
  if (!r.success) throw invalid('fluxo da automação inválido', { issues: issuesOf(r.error) });
  return r.data;
}

function parseTriggers(raw: unknown[]): AutomationTriggerInput[] {
  const r = z.array(FlowTriggerInputSchema).max(1, 'por enquanto, um gatilho por fluxo').safeParse(raw);
  if (!r.success) throw invalid('gatilho inválido', { issues: issuesOf(r.error) });
  return r.data.map((t) => ({ kind: t.kind, config: t.config, position: t.position }));
}

const flowInvalid = (problems: FlowProblem[]) =>
  new DomainError(ErrorCodes.AutomationFlowInvalid, 'o fluxo tem problemas que impedem testar ou ativar', { problems });

/** `@Fulano.X` → `fulano.x`; formato de username do Instagram */
function normalizeUsernames(list: string[]): string[] {
  const out = [...new Set(list.map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (out.length > 10) throw invalid('no máximo 10 contas de teste');
  const bad = out.find((u) => !/^[a-z0-9._]{1,30}$/.test(u));
  if (bad) throw invalid(`username de teste inválido: ${bad}`);
  return out;
}

function cleanName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 80) throw invalid('dê um nome de 1 a 80 caracteres');
  return n;
}

function triggerViews(a: AutomationRecord, rows: AutomationTriggerRecord[], loaded: LoadedFlow | null): AutomationTriggerView[] {
  const mine = rows.filter((t) => t.automationId === a.id && t.kind === 'comment');
  if (mine.length) {
    return mine.flatMap((t) => {
      const p = CommentTriggerConfigSchema.safeParse(t.config);
      return p.success ? [{ id: t.id, kind: 'comment' as const, config: p.data, position: t.position }] : [];
    });
  }
  return loaded?.legacy ? [{ id: null, kind: 'comment', config: triggerFromV1(loaded.legacy), position: null }] : [];
}

function view(a: AutomationRecord, rows: AutomationTriggerRecord[]): AutomationView {
  const { config, ...rest } = a;
  const loaded = loadFlow(config);
  return {
    ...rest,
    flow: loaded?.flow ?? null,
    triggers: triggerViews(a, rows, loaded),
    problems: loaded ? validateFlow(loaded.flow) : [],
  };
}

export const makeAutomations = (deps: AutomationsDeps) => {
  async function mustGet(orgId: string, id: string) {
    const a = await deps.repo.get(orgId, id);
    if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
    return a;
  }

  async function viewOf(a: AutomationRecord) {
    return view(a, await deps.repo.listTriggers([a.id]));
  }

  function assertTestable(status: AutomationStatus, testUsernames: string[]) {
    if (status === 'TEST' && testUsernames.length === 0) {
      throw invalid('o modo teste precisa de pelo menos uma conta de teste');
    }
  }

  /** Teste/Ativa: fluxo sem erro e com gatilho (avisos não bloqueiam) */
  function assertRunnable(v: AutomationView) {
    if (!v.flow) throw invalid('configuração da automação inválida');
    if (hasErrors(v.problems)) throw flowInvalid(v.problems);
    if (v.triggers.length === 0) throw invalid('a automação precisa de um gatilho para testar ou ativar');
  }

  const audit = (orgId: string, actor: AutomationActor, action: string, id: string, detail?: Record<string, unknown>) =>
    deps.audit
      .append({
        orgId,
        actorType: actor.type,
        actorId: actor.id,
        action,
        targetType: 'automation',
        targetId: id,
        ...(detail ? { detail } : {}),
        ip: actor.ip ?? null,
      })
      .catch(() => {});

  return {
    async list(orgId: string, filter?: { channelId?: string }) {
      const items = await deps.repo.list(orgId, filter);
      const rows = await deps.repo.listTriggers(items.map((a) => a.id));
      return items.map((a) => view(a, rows));
    },

    async get(orgId: string, id: string) {
      return viewOf(await mustGet(orgId, id));
    },

    async create(input: {
      orgId: string;
      actor: AutomationActor;
      channelId: string;
      name: string;
      flow: unknown;
      triggers?: unknown[];
      testUsernames?: string[];
      status?: AutomationStatus;
    }) {
      const [channel] = await deps.channels.findMany(input.orgId, [input.channelId]);
      if (!channel) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');
      if (!(AUTOMATION_PROVIDERS as readonly string[]).includes(channel.provider)) {
        throw new DomainError(ErrorCodes.CapabilityDisabled, 'automação de comentários só existe para o Instagram');
      }
      const flow = parseFlow(input.flow);
      const triggers = parseTriggers(input.triggers ?? []);
      const testUsernames = normalizeUsernames(input.testUsernames ?? []);
      const status = input.status ?? 'DRAFT';
      assertTestable(status, testUsernames);
      // nascer em Teste/Ativa só com fluxo que roda — conferido antes de gravar
      if (status === 'TEST' || status === 'ACTIVE') {
        const at = new Date();
        const draft: AutomationRecord = {
          id: 'novo',
          orgId: input.orgId,
          channelId: channel.id,
          name: 'novo',
          status,
          config: flow,
          testUsernames,
          createdBy: null,
          createdAt: at,
          updatedAt: at,
        };
        const rows = triggers.map((t, i) => ({
          ...t,
          id: `novo-${i}`,
          orgId: input.orgId,
          automationId: 'novo',
          channelId: channel.id,
          createdAt: at,
        }));
        assertRunnable(view(draft, rows));
      }
      const a = await deps.repo.create({
        orgId: input.orgId,
        channelId: channel.id,
        name: cleanName(input.name),
        status,
        config: flow,
        testUsernames,
        createdBy: input.actor.type === 'USER' ? input.actor.id : null,
        triggers,
      });
      await audit(input.orgId, input.actor, 'automation.created', a.id, { status });
      return viewOf(a);
    },

    async update(input: {
      orgId: string;
      id: string;
      actor: AutomationActor;
      name?: string;
      flow?: unknown;
      triggers?: unknown[];
      testUsernames?: string[];
    }) {
      const current = await mustGet(input.orgId, input.id);
      const testUsernames = input.testUsernames ? normalizeUsernames(input.testUsernames) : current.testUsernames;
      assertTestable(current.status, testUsernames);
      const flow = input.flow !== undefined ? parseFlow(input.flow) : undefined;
      const triggers = input.triggers !== undefined ? parseTriggers(input.triggers) : undefined;

      // em Teste/Ativa, o que vai ser gravado já tem de rodar
      if (current.status === 'TEST' || current.status === 'ACTIVE') {
        const draft: AutomationRecord = { ...current, ...(flow ? { config: flow } : {}) };
        const rows = triggers
          ? triggers.map((t, i) => ({ ...t, id: `novo-${i}`, orgId: current.orgId, automationId: current.id, channelId: current.channelId, createdAt: new Date() }))
          : await deps.repo.listTriggers([current.id]);
        assertRunnable(view(draft, rows));
      }

      const a = await deps.repo.update(
        input.orgId,
        input.id,
        {
          ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
          ...(flow ? { config: flow } : {}),
          ...(input.testUsernames ? { testUsernames } : {}),
        },
        triggers,
      );
      if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      await audit(input.orgId, input.actor, 'automation.updated', a.id);
      return viewOf(a);
    },

    async setStatus(input: { orgId: string; id: string; actor: AutomationActor; status: AutomationStatus }) {
      const current = await mustGet(input.orgId, input.id);
      assertTestable(input.status, current.testUsernames);
      if (input.status === 'ACTIVE' || input.status === 'TEST') assertRunnable(await viewOf(current));
      const a = await deps.repo.update(input.orgId, input.id, { status: input.status });
      if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      await audit(input.orgId, input.actor, 'automation.status', a.id, { from: current.status, to: input.status });
      return viewOf(a);
    },

    async remove(input: { orgId: string; id: string; actor: AutomationActor }) {
      if (!(await deps.repo.softDelete(input.orgId, input.id))) {
        throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      }
      await audit(input.orgId, input.actor, 'automation.deleted', input.id);
    },

    /** execuções como leads, com o nome da automação */
    async leads(
      orgId: string,
      filter: { automationId?: string; status?: AutomationRunStatus; cursor?: string; limit: number },
    ) {
      const [page, automations] = await Promise.all([deps.repo.listRuns(orgId, filter), deps.repo.list(orgId)]);
      const names = new Map(automations.map((a) => [a.id, a.name]));
      return {
        items: page.items.map((r) => ({ ...r, automationName: names.get(r.automationId) ?? null })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
};

export type Automations = ReturnType<typeof makeAutomations>;

// ---------------------------------------------------------------- motor

export interface AutomationEngineDeps {
  repo: AutomationRepository;
  gateway: AutomationGateway;
  scheduler: Pick<JobScheduler, 'enqueue'>;
  events?: EventPublisher;
  /** balão "Avisar a equipe"; ausente = o aviso vira no-op */
  notifications?: Pick<NotificationRepository, 'create'>;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: object) => void;
  now?: () => Date;
  random?: () => number;
}

/** falha que o job deve retentar (o envio é idempotente ou nada saiu) */
class RetryableSendError extends Error {
  constructor(public readonly op: string) {
    super(`envio transitório falhou: ${op}`);
  }
}

const isFailure = (e: unknown): e is ProviderFailure & { consumed?: boolean; uncertain?: boolean } =>
  typeof e === 'object' && e !== null && typeof (e as ProviderFailure).status === 'number';

/** texto curto para `last_error` — só a mensagem saneada, nunca o corpo */
function errorText(e: unknown): string {
  if (isFailure(e)) {
    try {
      const msg = (JSON.parse(e.body) as { error?: { message?: unknown } }).error?.message;
      if (typeof msg === 'string') return `${e.status}: ${msg.slice(0, 200)}`;
    } catch {
      // corpo não-JSON
    }
    return `HTTP ${e.status}`;
  }
  return 'falha de rede';
}

interface Bound {
  channel: { id: string; orgId: string };
  comments: CommentTransport;
  direct: DirectTransport;
  /** conta da ponte que gerou o evento (vai nos jobs de tempo) */
  accountRef: string;
}

export const makeAutomationEngine = (deps: AutomationEngineDeps) => {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  async function patch(run: AutomationRunRecord, p: AutomationRunPatch) {
    return deps.repo.updateRun(run.id, p);
  }

  /** envio idempotente na conversa: transitório/rede = retentar o job; permanente = falha da execução */
  async function sendInConversation(bound: Bound, run: AutomationRunRecord, msg: DirectMessage, key: string, op: string) {
    if (!run.conversationId) throw new RetryableSendError(`${op}: conversa ainda desconhecida`);
    try {
      await bound.direct.sendMessage(run.conversationId, msg, key);
      return { ok: true as const };
    } catch (e) {
      if (!isFailure(e) || e.errorClass === 'transient') {
        deps.log('warn', 'automation.send.failed', { runId: run.id, op, status: isFailure(e) ? e.status : null, retry: true });
        throw new RetryableSendError(op);
      }
      deps.log('warn', 'automation.send.failed', { runId: run.id, op, status: e.status, retry: false });
      return { ok: false as const, error: errorText(e) };
    }
  }

  /** execução criada pelo motor v1 (sem nó) ganha o nó equivalente; o prompt entregue não sai de novo */
  async function adoptLegacyRun(run: AutomationRunRecord, flow: FlowV2) {
    if (run.nodeId !== null || run.privateReply !== 'SENT') return run;
    const delivered = run.step < 0 || run.promptSentStep >= run.step;
    return patch(run, { nodeId: nodeForV1Step(flow, run.step), cursor: 1, sentCursor: delivered ? 1 : 0 });
  }

  /**
   * Agenda um job de tempo. Na fila `automation-event` (política padrão do pg-boss) a `singletonKey`
   * não deduplica: jobs repetidos são inofensivos porque cada um confere cursor e `reminderSentAt`.
   */
  async function scheduleTimer(timer: AutomationTimerJob['timer'], run: AutomationRunRecord, bound: Bound, at: Date) {
    const job: AutomationTimerJob = { timer, runId: run.id, cursor: run.cursor, accountRef: bound.accountRef };
    await deps.scheduler.enqueue(AUTOMATION_EVENT_QUEUE, job, {
      startAfter: at,
      singletonKey: `${run.id}:${timer}:${run.cursor}:${at.getTime()}`,
      retryLimit: 3,
      retryBackoffSec: 20,
    });
  }

  /** "digitando…" é cortesia: falhou, só registra */
  async function typing(bound: Bound, run: AutomationRunRecord) {
    if (!run.conversationId || !bound.direct.typing) return;
    try {
      await bound.direct.typing(run.conversationId);
    } catch {
      deps.log('warn', 'automation.typing.failed', { runId: run.id });
    }
  }

  /** hora em que o lembrete vence, contada da última mensagem da pessoa e limitada a 23 h */
  function reminderDue(flow: FlowV2, run: AutomationRunRecord): number | null {
    if (!flow.reminder || !run.lastInboundAt) return null;
    const base = run.lastInboundAt.getTime();
    return Math.min(base + flow.reminder.afterMinutes * 60_000, base + REMINDER_CAP_MS);
  }

  /** nó em que o lembrete pode sair: já enviado, espera resposta e não é a abertura */
  function remindableNode(flow: FlowV2, run: AutomationRunRecord) {
    const node = nodeById(flow, run.nodeId);
    if (!node || node.type === 'opening' || !waits(node) || run.sentCursor !== run.cursor) return null;
    return node;
  }

  /** arma o lembrete único quando a conversa fica parada esperando a pessoa */
  async function armReminder(bound: Bound, flow: FlowV2, run: AutomationRunRecord) {
    if (run.status !== 'OPEN' || run.reminderSentAt || !remindableNode(flow, run)) return;
    const due = reminderDue(flow, run);
    if (due === null || due <= now().getTime()) return;
    await scheduleTimer('reminder', run, bound, new Date(due));
  }

  async function sendReminder(bound: Bound, flow: FlowV2, run: AutomationRunRecord) {
    const reminder = flow.reminder;
    if (!reminder) return 'off';
    const node = remindableNode(flow, run);
    const due = reminderDue(flow, run);
    if (run.reminderSentAt || !node || due === null) return 'stale';
    const t = now().getTime();
    // antes da hora (resposta mais nova, toque antigo, tempo editado, relógio adiantado): reagenda
    if (t < due - 1000) {
      await scheduleTimer('reminder', run, bound, new Date(due));
      return 'rescheduled';
    }
    if (t > run.lastInboundAt!.getTime() + REMINDER_CAP_MS + REMINDER_GRACE_MS) return 'window_closed';
    const msg = messageFor(node, { runId: run.id, answers: run.answers, username: run.participantUsername });
    if (!msg) return 'stale';
    // duas mensagens: o texto do lembrete sozinho e a pergunta como saiu (junto, estouraria os 640 com botões)
    const text = renderTemplate(reminder.text, run.answers, run.participantUsername);
    let sent = await sendInConversation(bound, run, { text }, `${run.id}:rem${run.cursor}`, 'reminder');
    if (sent.ok) sent = await sendInConversation(bound, run, msg, `${run.id}:rem${run.cursor}:q`, 'reminder');
    // lembrete recusado não derruba a conversa: só não tenta de novo
    await patch(run, sent.ok ? { reminderSentAt: now() } : { reminderSentAt: now(), lastError: `lembrete: ${sent.error}` });
    deps.log('info', 'automation.reminder', { runId: run.id, cursor: run.cursor, ok: sent.ok });
    return sent.ok ? 'reminded' : 'failed';
  }

  /**
   * Faz só o que falta, na ordem do fluxo, gravando cada efeito logo depois de confirmado (design D6):
   * resposta pública, resposta privada (abertura), mensagens dos nós até o próximo que espera, fim e
   * `lead.captured`. Reprocessar o mesmo evento nunca envia duas vezes.
   */
  /**
   * Efeito do balão de ação (add-flow-action-node). Pelo menos uma vez: falha aqui lança e o job é
   * refeito; quem recebe o `lead.updated` deduplica por runId + nodeId.
   */
  async function runAction(effect: ActionEffect, nodeId: string, run: AutomationRunRecord, automation: AutomationRecord, flow: FlowV2) {
    const ctx = { runId: run.id, answers: run.answers, username: run.participantUsername };
    if (effect.kind === 'send_data') {
      await deps.events?.emit({
        orgId: run.orgId,
        event: WebhookEvents.LeadUpdated,
        channelId: run.channelId,
        data: {
          label: effect.label,
          nodeId,
          runId: run.id,
          automationId: automation.id,
          automationName: automation.name,
          channelId: run.channelId,
          mediaId: run.mediaId,
          commentId: run.commentId,
          commentText: run.commentText,
          participantId: run.participantId,
          participantUsername: run.participantUsername,
          answers: run.answers,
          whatsappUrl: leadWhatsappUrl(flow, ctx),
          status: 'OPEN',
          test: automation.status === 'TEST',
          sentAt: now().toISOString(),
        },
      });
      return;
    }
    await deps.notifications?.create({
      orgId: run.orgId,
      userId: null,
      kind: 'automation.notify',
      title: automation.name,
      body: effect.text,
      link: '/leads',
    });
  }

  async function drive(
    bound: Bound,
    automation: AutomationRecord,
    loaded: LoadedFlow,
    publicReplies: string[],
    start: AutomationRunRecord,
  ) {
    const { flow } = loaded;
    let run = start;
    const ctx = () => ({ runId: run.id, answers: run.answers, username: run.participantUsername });

    if (run.status === 'OPEN') {
      // execução criada pelo motor v1 reentregue pelo comentário também ganha o nó equivalente
      run = await adoptLegacyRun(run, flow);

      // 1. resposta pública (não crítica: falhou, segue)
      if (run.publicReply === 'PENDING') {
        const reply = publicReplies.length
          ? publicReplies[Math.min(publicReplies.length - 1, Math.floor(random() * publicReplies.length))]!
          : null;
        if (!reply) run = await patch(run, { publicReply: 'NONE' });
        else {
          try {
            await bound.comments.replyToComment(run.mediaId, run.commentId, reply);
            run = await patch(run, { publicReply: 'SENT' });
          } catch (e) {
            run = await patch(run, { publicReply: 'FAILED', lastError: `resposta pública: ${errorText(e)}` });
          }
        }
      }

      // 2. resposta privada = abertura; uma por comentário, sem chave de idempotência → nunca retentada às cegas
      if (run.privateReply === 'PENDING') {
        const opening = openingOf(flow);
        try {
          await bound.direct.privateReply(run.mediaId, run.commentId, messageFor(opening, ctx())!);
          run = await patch(run, { privateReply: 'SENT', promptSentStep: -1, nodeId: opening.id, sentCursor: run.cursor });
        } catch (e) {
          if (isFailure(e) && e.status === 429 && !e.uncertain) throw new RetryableSendError('private_reply');
          const uncertain = !isFailure(e) || e.uncertain === true || (e.status >= 500 && !e.consumed);
          run = await patch(run, {
            privateReply: uncertain ? 'UNCERTAIN' : 'FAILED',
            status: uncertain ? 'UNCERTAIN' : 'FAILED',
            lastError: `resposta privada: ${errorText(e)}`,
          });
          deps.log('warn', 'automation.run', { runId: run.id, status: run.status, node: run.nodeId });
          return run;
        }
      }

      // 3. anda pelos nós que não esperam até o próximo que espera
      let steps = 0;
      while (run.status === 'OPEN') {
        const node = nodeById(flow, run.nodeId);
        if (!node) {
          run = await patch(run, { status: 'ABANDONED', lastError: 'o passo desta conversa foi removido do fluxo' });
          break;
        }
        if (run.sentCursor < run.cursor) {
          // atraso: marca a hora, mostra "digitando…" e deixa a continuação para o job de tempo
          const delay = delayOf(node);
          if (delay > 0) {
            if (!run.resumeAt) {
              run = await patch(run, { resumeAt: new Date(now().getTime() + delay * 1000) });
              await typing(bound, run);
            }
            if (now().getTime() < run.resumeAt!.getTime() - 1000) {
              await scheduleTimer('resume', run, bound, run.resumeAt!);
              break;
            }
          }
          // balão de ação: efeito sem mensagem; o sentCursor abaixo impede repetir ao retomar
          const effect = actionFor(node, ctx());
          if (effect) await runAction(effect, node.id, run, automation, flow);
          const msg = messageFor(node, ctx());
          if (msg) {
            const sent = await sendInConversation(bound, run, msg, `${run.id}:c${run.cursor}:${run.reasks}`, node.type);
            if (!sent.ok) {
              run = await patch(run, { status: 'FAILED', lastError: `${node.type}: ${sent.error}` });
              break;
            }
          }
          run = await patch(run, { sentCursor: run.cursor, ...(run.resumeAt ? { resumeAt: null } : {}) });
        }
        if (waits(node)) break;
        if (++steps > MAX_AUTO_STEPS) {
          run = await patch(run, { status: 'FAILED', lastError: 'limite de passos automáticos seguidos' });
          break;
        }
        const nx = autoNext(flow, node, run.answers);
        if (nx.kind === 'finish') {
          const at = now();
          run = await patch(run, { status: 'COMPLETED', completedAt: at, finishSentAt: at });
          break;
        }
        if (nx.kind === 'dead_end') {
          run = await patch(run, { status: 'ABANDONED', lastError: `saída sem ligação: ${node.id}.${nx.handle}` });
          break;
        }
        run = await patch(run, { nodeId: nx.to, cursor: run.cursor + 1, reasks: 0 });
      }
    }

    // 4. lead completo emitido pelo menos uma vez (`runId` é a chave de deduplicação de quem recebe)
    if (run.status === 'COMPLETED' && !run.leadEmittedAt) {
      await deps.events?.emit({
        orgId: run.orgId,
        event: WebhookEvents.LeadCaptured,
        channelId: run.channelId,
        data: {
          runId: run.id,
          automationId: automation.id,
          automationName: automation.name,
          channelId: run.channelId,
          mediaId: run.mediaId,
          commentId: run.commentId,
          commentText: run.commentText,
          participantId: run.participantId,
          participantUsername: run.participantUsername,
          answers: run.answers,
          whatsappUrl: leadWhatsappUrl(flow, ctx()),
          completedAt: (run.completedAt ?? now()).toISOString(),
        },
      });
      run = await patch(run, { leadEmittedAt: now() });
    }
    deps.log('info', 'automation.run', { runId: run.id, status: run.status, node: run.nodeId, cursor: run.cursor });
    return run;
  }

  async function onComment(bound: Bound, c: InboundCommentEvent) {
    if (c.isReply || c.isOwn) return 'ignored';
    const author = c.authorUsername?.toLowerCase() ?? null;
    const automations = await deps.repo.listTriggerable(bound.channel.id);
    const triggers = automations.length ? await deps.repo.listTriggers(automations.map((a) => a.id)) : [];
    for (const automation of automations) {
      const loaded = loadFlow(automation.config);
      if (!loaded) continue;
      const trigger = commentTriggerOf(automation.id, triggers, loaded);
      if (!trigger) continue;
      if (automation.status === 'TEST' && !(author && automation.testUsernames.includes(author))) continue;
      if (!matchesCommentTrigger(trigger, { mediaId: c.mediaId, text: c.text })) continue;

      const { run } = await deps.repo.createRun({
        orgId: automation.orgId,
        automationId: automation.id,
        channelId: bound.channel.id,
        mediaId: c.mediaId,
        commentId: c.commentId,
        commentText: c.text.slice(0, 2200),
        participantId: c.authorId,
        participantUsername: c.authorUsername,
        publicReply: trigger.publicReplies.length ? 'PENDING' : 'NONE',
      });
      // reentrega ou retentativa: `drive` só faz o que ainda falta
      await drive(bound, automation, loaded, trigger.publicReplies, run);
      return 'run';
    }
    return 'no_match';
  }

  async function onMessage(bound: Bound, m: InboundMessageEvent) {
    if (m.outgoing || m.standby) return 'ignored';
    const since = new Date(now().getTime() - RUN_WINDOW_MS);
    const v2 = decodePayloadV2(m.payload);
    const v1 = v2 ? null : decodePayload(m.payload);
    const tapRunId = v2?.runId ?? v1?.runId ?? null;

    let run: AutomationRunRecord | null = null;
    if (tapRunId) {
      const r = await deps.repo.getRun(tapRunId);
      if (r && r.channelId === bound.channel.id && r.status === 'OPEN') run = r;
    }
    run ??= await deps.repo.findOpenRun(bound.channel.id, { participantId: m.senderId }, since);
    if (!run && m.senderUsername) run = await deps.repo.findOpenRun(bound.channel.id, { username: m.senderUsername }, since);
    if (!run) return 'no_run';

    const automation = await deps.repo.get(run.orgId, run.automationId);
    if (!automation || automation.status === 'PAUSED' || automation.status === 'DRAFT') return 'paused';
    const loaded = loadFlow(automation.config);
    if (!loaded) {
      await patch(run, { status: 'FAILED', lastError: 'configuração da automação inválida' });
      return 'invalid_config';
    }
    const triggers = await deps.repo.listTriggers([automation.id]);
    const publicReplies = commentTriggerOf(automation.id, triggers, loaded)?.publicReplies ?? [];

    const base: AutomationRunPatch = {
      lastInteractionAt: now(),
      lastInboundAt: now(),
      ...(run.conversationId ? {} : { conversationId: m.conversationId }),
    };

    // resposta privada ainda pendente (429 em retentativa): só garante o progresso
    if (run.privateReply !== 'SENT') {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'pending';
    }

    run = await adoptLegacyRun(run, loaded.flow);
    const node = nodeById(loaded.flow, run.nodeId);
    if (!node) {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'abandoned';
    }

    // a mensagem do nó atual ainda não saiu (retentativa): a pessoa não está respondendo a ela
    if (run.sentCursor < run.cursor) {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'duplicate';
    }

    const tap =
      v2 && v2.runId === run.id
        ? { nodeId: v2.nodeId, handle: v2.handle }
        : v1 && v1.runId === run.id
          ? tapFromV1(v1.step, v1.option)
          : null;
    // toque de outra execução ou de um passo que já passou (toque duplo, botão antigo): só garante o progresso
    if ((tapRunId && tapRunId !== run.id) || (tap && tap.nodeId !== run.nodeId)) {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'duplicate';
    }

    const d = decideInput(loaded.flow, node, { handle: tap?.handle ?? null, text: m.text }, run.reasks);
    if (d.kind === 'ignore') {
      run = await patch(run, base);
    } else if (d.kind === 'reask') {
      // a chave nova (reasks+1) permite reenviar a mesma mensagem
      run = await patch(run, { ...base, reasks: run.reasks + 1, sentCursor: run.cursor - 1 });
    } else {
      const to = targetOf(loaded.flow, node.id, d.handle);
      const answers = d.save ? { ...run.answers, [d.save.field]: d.save.value } : run.answers;
      run = to
        ? await patch(run, { ...base, answers, nodeId: to, cursor: run.cursor + 1, reasks: 0 })
        : await patch(run, { ...base, answers, status: 'ABANDONED', lastError: `saída sem ligação: ${node.id}.${d.handle}` });
    }
    run = await drive(bound, automation, loaded, publicReplies, run);
    await armReminder(bound, loaded.flow, run);
    return run.status === 'ABANDONED' ? 'abandoned' : 'advanced';
  }

  return {
    /** rota do webhook: grava uma vez e enfileira; `duplicate` = reentrega já gravada */
    async ingest(e: { eventId: string; eventType: string; payload: unknown }) {
      const id = await deps.repo.insertInboundEvent({ source: deps.gateway.source, ...e });
      if (!id) return { duplicate: true as const };
      await deps.scheduler.enqueue(AUTOMATION_EVENT_QUEUE, { inboundEventId: id }, { singletonKey: id, retryLimit: 3, retryBackoffSec: 20 });
      return { duplicate: false as const, id };
    },

    /** job da fila: lança só quando vale retentar (envio idempotente transitório) */
    async process(inboundEventId: string) {
      const started = Date.now();
      const ev = await deps.repo.getInboundEvent(inboundEventId);
      if (!ev || ev.processedAt) return 'done';
      const parsed = deps.gateway.parse(ev.eventType, ev.payload);
      if (!parsed) {
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        return 'ignored';
      }
      const bound = await deps.gateway.resolve(parsed.accountRef);
      if (!bound) {
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        return 'unknown_account';
      }
      try {
        const b: Bound = { ...bound, accountRef: parsed.accountRef };
        const action = parsed.kind === 'comment' ? await onComment(b, parsed) : await onMessage(b, parsed);
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        deps.log('info', 'automation.event', { type: ev.eventType, action, ms: Date.now() - started });
        return action;
      } catch (e) {
        await deps.repo.markInboundEvent(ev.id, { error: e instanceof Error ? e.message : 'erro' });
        throw e;
      }
    },

    /** job de tempo: retoma um envio atrasado ou manda o lembrete; lança só quando vale retentar */
    async processTimer(t: AutomationTimerJob) {
      const run = await deps.repo.getRun(t.runId);
      // a conversa andou, fechou ou o job é de outra posição: nada a fazer
      if (!run || run.status !== 'OPEN' || run.cursor !== t.cursor) return 'stale';
      const automation = await deps.repo.get(run.orgId, run.automationId);
      if (!automation || automation.status === 'PAUSED' || automation.status === 'DRAFT') return 'paused';
      const loaded = loadFlow(automation.config);
      if (!loaded) return 'invalid_config';
      const resolved = await deps.gateway.resolve(t.accountRef);
      // ponte fora do ar (ou conta sumiu): lança para a fila tentar de novo, senão o envio se perde
      if (!resolved) throw new RetryableSendError(`${t.timer}: conta da ponte indisponível`);
      if (resolved.channel.id !== run.channelId) return 'unknown_account';
      const bound: Bound = { ...resolved, accountRef: t.accountRef };

      if (t.timer === 'reminder') return sendReminder(bound, loaded.flow, run);
      const triggers = await deps.repo.listTriggers([automation.id]);
      const publicReplies = commentTriggerOf(automation.id, triggers, loaded)?.publicReplies ?? [];
      const after = await drive(bound, automation, loaded, publicReplies, run);
      await armReminder(bound, loaded.flow, after);
      return 'resumed';
    },
  };
};

export type AutomationEngine = ReturnType<typeof makeAutomationEngine>;
