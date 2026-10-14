import type {
  AutomationRunStatus,
  AutomationStatus,
  CommentTransport,
  DirectTransport,
  InboundAutomationEvent,
} from '@manypost/contracts';

/** Automação comentário → direct (add-comment-automation): persistência. Toda leitura por org. */

export interface AutomationRecord {
  id: string;
  orgId: string;
  channelId: string;
  name: string;
  status: AutomationStatus;
  /** `CommentAutomationConfig` v1 — validado no caso de uso ao gravar e ao ler */
  config: unknown;
  testUsernames: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationTriggerInput {
  kind: 'comment';
  config: unknown;
  position: { x: number; y: number } | null;
}
export interface AutomationTriggerRecord extends AutomationTriggerInput {
  id: string;
  orgId: string;
  automationId: string;
  channelId: string;
  createdAt: Date;
}

export type PublicReplyState = 'PENDING' | 'SENT' | 'FAILED' | 'NONE';
export type PrivateReplyState = 'PENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN';

export interface AutomationRunRecord {
  id: string;
  orgId: string;
  automationId: string;
  channelId: string;
  mediaId: string;
  commentId: string;
  commentText: string;
  participantId: string;
  participantUsername: string | null;
  conversationId: string | null;
  /** nó atual do fluxo v2; `null` = execução v1 ainda não adotada ou resposta privada pendente */
  nodeId: string | null;
  /** conta as entradas em nó (chave de idempotência do envio) */
  cursor: number;
  /** último cursor cuja mensagem foi confirmada */
  sentCursor: number;
  status: AutomationRunStatus;
  step: number;
  promptSentStep: number;
  reasks: number;
  answers: Record<string, string>;
  publicReply: PublicReplyState;
  privateReply: PrivateReplyState;
  finishSentAt: Date | null;
  lastError: string | null;
  lastInteractionAt: Date;
  /** hora marcada do envio atrasado do nó atual (add-flow-delay-reminder) */
  resumeAt: Date | null;
  /** última mensagem da pessoa: base da janela de 24 h do lembrete */
  lastInboundAt: Date | null;
  /** o lembrete único já saiu */
  reminderSentAt: Date | null;
  completedAt: Date | null;
  leadEmittedAt: Date | null;
  createdAt: Date;
}

export type AutomationRunPatch = Partial<
  Pick<
    AutomationRunRecord,
    | 'conversationId'
    | 'nodeId'
    | 'cursor'
    | 'sentCursor'
    | 'status'
    | 'step'
    | 'promptSentStep'
    | 'reasks'
    | 'answers'
    | 'publicReply'
    | 'privateReply'
    | 'finishSentAt'
    | 'lastError'
    | 'lastInteractionAt'
    | 'resumeAt'
    | 'lastInboundAt'
    | 'reminderSentAt'
    | 'completedAt'
    | 'leadEmittedAt'
  >
>;

export interface InboundEventRecord {
  id: string;
  source: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  processedAt: Date | null;
  attempts: number;
}

export interface AutomationRepository {
  create(d: {
    orgId: string;
    channelId: string;
    name: string;
    status: AutomationStatus;
    config: unknown;
    testUsernames: string[];
    createdBy: string | null;
    triggers?: AutomationTriggerInput[];
  }): Promise<AutomationRecord>;
  update(
    orgId: string,
    id: string,
    patch: Partial<Pick<AutomationRecord, 'name' | 'status' | 'config' | 'testUsernames'>>,
    triggers?: AutomationTriggerInput[],
  ): Promise<AutomationRecord | null>;
  get(orgId: string, id: string): Promise<AutomationRecord | null>;
  list(orgId: string, filter?: { channelId?: string }): Promise<AutomationRecord[]>;
  softDelete(orgId: string, id: string): Promise<boolean>;
  /** ACTIVE e TEST do canal, mais antigas primeiro (a primeira que casar vence) */
  listTriggerable(channelId: string): Promise<AutomationRecord[]>;
  /** gatilhos das automações, mais antigos primeiro */
  listTriggers(automationIds: string[]): Promise<AutomationTriggerRecord[]>;

  /** cria a execução; se já existe para (automação, comentário) devolve a existente com `created: false` */
  createRun(d: {
    orgId: string;
    automationId: string;
    channelId: string;
    mediaId: string;
    commentId: string;
    commentText: string;
    participantId: string;
    participantUsername: string | null;
    publicReply: PublicReplyState;
  }): Promise<{ run: AutomationRunRecord; created: boolean }>;
  getRun(id: string): Promise<AutomationRunRecord | null>;
  /** execução OPEN mais recente do participante no canal com interação desde `since` */
  findOpenRun(
    channelId: string,
    who: { participantId?: string; username?: string },
    since: Date,
  ): Promise<AutomationRunRecord | null>;
  updateRun(id: string, patch: AutomationRunPatch): Promise<AutomationRunRecord>;
  listRuns(
    orgId: string,
    filter: { automationId?: string; status?: AutomationRunStatus; cursor?: string; limit: number },
  ): Promise<{ items: AutomationRunRecord[]; nextCursor?: string }>;

  /** grava o evento uma vez; `null` = já existia (reentrega) */
  insertInboundEvent(d: { source: string; eventId: string; eventType: string; payload: unknown }): Promise<string | null>;
  getInboundEvent(id: string): Promise<InboundEventRecord | null>;
  markInboundEvent(id: string, outcome: { processed: true } | { error: string }): Promise<void>;
}

/**
 * Ponte de eventos e envio (hoje a Zernio): traduz o payload recebido e resolve a conta do evento
 * para o canal do manypost (só de organizações autorizadas) com os transportes já fechados sobre ela.
 */
export interface AutomationGateway {
  readonly source: string;
  parse(eventType: string, payload: unknown): InboundAutomationEvent | null;
  resolve(accountRef: string): Promise<{
    channel: { id: string; orgId: string };
    comments: CommentTransport;
    direct: DirectTransport;
  } | null>;
}
