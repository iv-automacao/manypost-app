import type {
  ActorType,
  AutomationRunStatus,
  AutomationStatus,
  CommentAutomationConfig,
  CommentTransport,
  DirectMessage,
  DirectTransport,
  InboundCommentEvent,
  InboundMessageEvent,
  ProviderFailure,
} from '@manypost/contracts';
import { CommentAutomationConfigSchema, ErrorCodes, WebhookEvents } from '@manypost/contracts';
import {
  decodePayload,
  finishMessage,
  matchesTrigger,
  matchOption,
  openingMessage,
  pickPublicReply,
  promptMessage,
  validateAnswer,
  whatsappUrl,
} from '../../domain/automation/automation-logic';
import { DomainError } from '../../domain/shared/result';
import type { AuditLogRepository } from '../ports/approvals';
import type {
  AutomationGateway,
  AutomationRecord,
  AutomationRepository,
  AutomationRunPatch,
  AutomationRunRecord,
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
const MAX_REASKS = 1;

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

export interface AutomationView extends Omit<AutomationRecord, 'config'> {
  config: CommentAutomationConfig | null;
}

const invalid = (message: string, detail?: Record<string, unknown>) =>
  new DomainError(ErrorCodes.ValidationInvalidRequest, message, detail);

function parseConfig(raw: unknown): CommentAutomationConfig {
  const r = CommentAutomationConfigSchema.safeParse(raw);
  if (!r.success) {
    throw invalid('configuração da automação inválida', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const tryConfig = (raw: unknown): CommentAutomationConfig | null => {
  const r = CommentAutomationConfigSchema.safeParse(raw);
  return r.success ? r.data : null;
};

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

const view = (a: AutomationRecord): AutomationView => ({ ...a, config: tryConfig(a.config) });

export const makeAutomations = (deps: AutomationsDeps) => {
  async function mustGet(orgId: string, id: string) {
    const a = await deps.repo.get(orgId, id);
    if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
    return a;
  }

  function assertTestable(status: AutomationStatus, testUsernames: string[]) {
    if (status === 'TEST' && testUsernames.length === 0) {
      throw invalid('o modo teste precisa de pelo menos uma conta de teste');
    }
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
      return (await deps.repo.list(orgId, filter)).map(view);
    },

    async get(orgId: string, id: string) {
      return view(await mustGet(orgId, id));
    },

    async create(input: {
      orgId: string;
      actor: AutomationActor;
      channelId: string;
      name: string;
      config: unknown;
      testUsernames?: string[];
      status?: AutomationStatus;
    }) {
      const [channel] = await deps.channels.findMany(input.orgId, [input.channelId]);
      if (!channel) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');
      if (!(AUTOMATION_PROVIDERS as readonly string[]).includes(channel.provider)) {
        throw new DomainError(ErrorCodes.CapabilityDisabled, 'automação de comentários só existe para o Instagram');
      }
      const config = parseConfig(input.config);
      const testUsernames = normalizeUsernames(input.testUsernames ?? []);
      const status = input.status ?? 'DRAFT';
      assertTestable(status, testUsernames);
      const a = await deps.repo.create({
        orgId: input.orgId,
        channelId: channel.id,
        name: cleanName(input.name),
        status,
        config,
        testUsernames,
        createdBy: input.actor.type === 'USER' ? input.actor.id : null,
      });
      await audit(input.orgId, input.actor, 'automation.created', a.id, { status });
      return view(a);
    },

    async update(input: {
      orgId: string;
      id: string;
      actor: AutomationActor;
      name?: string;
      config?: unknown;
      testUsernames?: string[];
    }) {
      const current = await mustGet(input.orgId, input.id);
      const testUsernames = input.testUsernames ? normalizeUsernames(input.testUsernames) : current.testUsernames;
      assertTestable(current.status, testUsernames);
      const a = await deps.repo.update(input.orgId, input.id, {
        ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
        ...(input.config !== undefined ? { config: parseConfig(input.config) } : {}),
        ...(input.testUsernames ? { testUsernames } : {}),
      });
      if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      await audit(input.orgId, input.actor, 'automation.updated', a.id);
      return view(a);
    },

    async setStatus(input: { orgId: string; id: string; actor: AutomationActor; status: AutomationStatus }) {
      const current = await mustGet(input.orgId, input.id);
      assertTestable(input.status, current.testUsernames);
      if (input.status === 'ACTIVE' || input.status === 'TEST') parseConfig(current.config);
      const a = await deps.repo.update(input.orgId, input.id, { status: input.status });
      if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      await audit(input.orgId, input.actor, 'automation.status', a.id, { from: current.status, to: input.status });
      return view(a);
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

  /** faz só o que falta, na ordem do fluxo; grava cada efeito logo depois de confirmado */
  async function ensureProgress(
    bound: Bound,
    automation: AutomationRecord,
    cfg: CommentAutomationConfig,
    start: AutomationRunRecord,
  ) {
    let run = start;
    if (run.status === 'OPEN') {
      // 1. resposta pública (não crítica: falhou, segue)
      if (run.publicReply === 'PENDING') {
        const reply = pickPublicReply(cfg, random());
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

      // 2. resposta privada: uma por comentário, sem chave de idempotência → nunca retentada às cegas
      if (run.privateReply === 'PENDING') {
        try {
          await bound.direct.privateReply(run.mediaId, run.commentId, openingMessage(cfg, run.id));
          run = await patch(run, { privateReply: 'SENT', promptSentStep: -1 });
        } catch (e) {
          if (isFailure(e) && e.status === 429 && !e.uncertain) throw new RetryableSendError('private_reply');
          const uncertain = !isFailure(e) || e.uncertain === true || (e.status >= 500 && !e.consumed);
          run = await patch(run, {
            privateReply: uncertain ? 'UNCERTAIN' : 'FAILED',
            status: uncertain ? 'UNCERTAIN' : 'FAILED',
            lastError: `resposta privada: ${errorText(e)}`,
          });
          deps.log('warn', 'automation.run', { runId: run.id, status: run.status, step: run.step });
          return run;
        }
      }

      const n = cfg.questions.length;
      // 3. pergunta do passo atual ainda não entregue (inclui re-pergunta: a chave leva `reasks`)
      if (run.step >= 0 && run.step < n && run.promptSentStep < run.step) {
        const sent = await sendInConversation(
          bound,
          run,
          promptMessage(cfg, run.id, run.step),
          `${run.id}:${run.step}:${run.reasks}`,
          'prompt',
        );
        run = sent.ok
          ? await patch(run, { promptSentStep: run.step })
          : await patch(run, { status: 'FAILED', lastError: `pergunta: ${sent.error}` });
      }

      // 4. fim
      if (run.status === 'OPEN' && run.step >= n && !run.finishSentAt) {
        const sent = await sendInConversation(
          bound,
          run,
          finishMessage(cfg, run.answers, run.participantUsername),
          `${run.id}:fim`,
          'finish',
        );
        const at = now();
        run = sent.ok
          ? await patch(run, { finishSentAt: at, status: 'COMPLETED', completedAt: at })
          : await patch(run, { status: 'FAILED', lastError: `fim: ${sent.error}` });
      }
    }

    // 5. lead completo emitido pelo menos uma vez (`runId` é a chave de deduplicação de quem recebe)
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
          whatsappUrl: whatsappUrl(cfg, run.answers, run.participantUsername),
          completedAt: (run.completedAt ?? now()).toISOString(),
        },
      });
      run = await patch(run, { leadEmittedAt: now() });
    }
    deps.log('info', 'automation.run', { runId: run.id, status: run.status, step: run.step });
    return run;
  }

  async function onComment(bound: Bound, c: InboundCommentEvent) {
    if (c.isReply || c.isOwn) return 'ignored';
    const author = c.authorUsername?.toLowerCase() ?? null;
    for (const automation of await deps.repo.listTriggerable(bound.channel.id)) {
      const cfg = tryConfig(automation.config);
      if (!cfg) continue;
      if (automation.status === 'TEST' && !(author && automation.testUsernames.includes(author))) continue;
      if (!matchesTrigger(cfg, { mediaId: c.mediaId, text: c.text })) continue;

      const { run } = await deps.repo.createRun({
        orgId: automation.orgId,
        automationId: automation.id,
        channelId: bound.channel.id,
        mediaId: c.mediaId,
        commentId: c.commentId,
        commentText: c.text.slice(0, 2200),
        participantId: c.authorId,
        participantUsername: c.authorUsername,
        publicReply: cfg.publicReplies.length ? 'PENDING' : 'NONE',
      });
      // reentrega ou retentativa: `ensureProgress` só faz o que ainda falta
      await ensureProgress(bound, automation, cfg, run);
      return 'run';
    }
    return 'no_match';
  }

  async function onMessage(bound: Bound, m: InboundMessageEvent) {
    if (m.outgoing || m.standby) return 'ignored';
    const since = new Date(now().getTime() - RUN_WINDOW_MS);
    const decoded = decodePayload(m.payload);

    let run: AutomationRunRecord | null = null;
    if (decoded) {
      const r = await deps.repo.getRun(decoded.runId);
      if (r && r.channelId === bound.channel.id && r.status === 'OPEN') run = r;
    }
    run ??= await deps.repo.findOpenRun(bound.channel.id, { participantId: m.senderId }, since);
    if (!run && m.senderUsername) run = await deps.repo.findOpenRun(bound.channel.id, { username: m.senderUsername }, since);
    if (!run) return 'no_run';

    const automation = await deps.repo.get(run.orgId, run.automationId);
    if (!automation || automation.status === 'PAUSED' || automation.status === 'DRAFT') return 'paused';
    const cfg = tryConfig(automation.config);
    if (!cfg) {
      await patch(run, { status: 'FAILED', lastError: 'configuração da automação inválida' });
      return 'invalid_config';
    }

    const base: AutomationRunPatch = {
      lastInteractionAt: now(),
      ...(run.conversationId ? {} : { conversationId: m.conversationId }),
    };
    const n = cfg.questions.length;

    // repetição de um passo já respondido (toque duplo, reentrega): só garante o progresso
    if (decoded && decoded.runId === run.id && decoded.step < run.step) {
      run = await patch(run, base);
      await ensureProgress(bound, automation, cfg, run);
      return 'duplicate';
    }

    if (run.step === -1) {
      // abertura: qualquer resposta (botão ou texto) abre a conversa e segue
      run = await patch(run, { ...base, step: n > 0 ? 0 : n, reasks: 0 });
    } else if (run.step < n) {
      const q = cfg.questions[run.step]!;
      let answer: string | null = null;
      if (q.kind === 'choice') {
        const idx =
          decoded && decoded.runId === run.id && decoded.step === run.step ? decoded.option : matchOption(q, m.text);
        if (idx >= 0 && idx < q.options.length) answer = q.options[idx]!.title;
        else if (run.reasks >= MAX_REASKS && m.text.trim()) answer = m.text.trim().slice(0, 200);
      } else {
        const v = validateAnswer(q.validate, m.text);
        if (v.ok) answer = v.value;
        else if (run.reasks >= MAX_REASKS && m.text.trim()) answer = m.text.trim().slice(0, 500);
      }
      run =
        answer === null
          ? // re-pergunta uma vez: `promptSentStep` volta e a chave nova (reasks+1) permite reenviar
            await patch(run, { ...base, reasks: run.reasks + 1, promptSentStep: run.step - 1 })
          : await patch(run, {
              ...base,
              answers: { ...run.answers, [q.field]: answer },
              step: run.step + 1,
              reasks: 0,
            });
    } else {
      run = await patch(run, base);
    }
    await ensureProgress(bound, automation, cfg, run);
    return 'advanced';
  }

  return {
    /** rota do webhook: grava uma vez e enfileira; `duplicate` = reentrega já gravada */
    async ingest(e: { eventId: string; eventType: string; payload: unknown }) {
      const id = await deps.repo.insertInboundEvent({ source: deps.gateway.source, ...e });
      if (!id) return { duplicate: true as const };
      await deps.scheduler.enqueue(AUTOMATION_EVENT_QUEUE, { inboundEventId: id }, { singletonKey: id, retryLimit: 3 });
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
        const action = parsed.kind === 'comment' ? await onComment(bound, parsed) : await onMessage(bound, parsed);
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        deps.log('info', 'automation.event', { type: ev.eventType, action, ms: Date.now() - started });
        return action;
      } catch (e) {
        await deps.repo.markInboundEvent(ev.id, { error: e instanceof Error ? e.message : 'erro' });
        throw e;
      }
    },
  };
};

export type AutomationEngine = ReturnType<typeof makeAutomationEngine>;
