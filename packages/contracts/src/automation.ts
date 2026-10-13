import { z } from 'zod';

/**
 * Automação comentário → direct (change add-comment-automation). Vocabulário e schema da
 * configuração, compartilhados por API e motor. A web repete os limites (não carrega este pacote no
 * bundle) e a paridade é assertada em `apps/web/src/features/automation/logic.test.ts`.
 */

export const AutomationStatuses = ['DRAFT', 'TEST', 'ACTIVE', 'PAUSED'] as const;
export type AutomationStatus = (typeof AutomationStatuses)[number];

export const AutomationRunStatuses = ['OPEN', 'COMPLETED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'ABANDONED'] as const;
export type AutomationRunStatus = (typeof AutomationRunStatuses)[number];

export const AutomationTextValidations = ['name', 'phone', 'email', 'free'] as const;
export type AutomationTextValidation = (typeof AutomationTextValidations)[number];

/** limites da Meta/Zernio: título de botão 20, até 3 botões, até 13 respostas rápidas, 640 com botões */
export const AUTOMATION_LIMITS = {
  buttonTitle: 20,
  maxButtons: 3,
  maxOptions: 13,
  messageText: 600,
  publicReply: 300,
  maxPublicReplies: 10,
  maxQuestions: 5,
  maxKeywords: 20,
  keyword: 60,
  maxMedia: 50,
  whatsappMessage: 500,
  maxTestUsernames: 10,
  name: 80,
  maxNodes: 40,
  maxEdges: 120,
  conditionValue: 60,
} as const;

const L = AUTOMATION_LIMITS;
const text = (max: number) => z.string().trim().min(1).max(max);
const buttonTitle = text(L.buttonTitle);
const field = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'campo: minúsculas, números e _');

const ChoiceQuestion = z.object({
  kind: z.literal('choice'),
  field,
  prompt: text(L.messageText),
  options: z.array(z.object({ title: buttonTitle })).min(1).max(L.maxOptions),
});

const TextQuestion = z.object({
  kind: z.literal('text'),
  field,
  prompt: text(L.messageText),
  validate: z.enum(AutomationTextValidations),
});

export const AutomationQuestionSchema = z.discriminatedUnion('kind', [ChoiceQuestion, TextQuestion]);
export type AutomationQuestion = z.infer<typeof AutomationQuestionSchema>;

export const CommentAutomationConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    trigger: z.object({
      /** vazio = qualquer post da conta */
      mediaIds: z.array(z.string().regex(/^\d{1,32}$/)).max(L.maxMedia).default([]),
      /** vazio = qualquer comentário */
      keywords: z.array(text(L.keyword)).max(L.maxKeywords).default([]),
    }),
    publicReplies: z.array(text(L.publicReply)).max(L.maxPublicReplies).default([]),
    opening: z.object({
      text: text(L.messageText),
      /** `button` = um botão postback; `text` = pede para a pessoa responder (contas com botão recusado) */
      mode: z.enum(['button', 'text']).default('button'),
      buttonTitle: buttonTitle.default('Quero!'),
    }),
    questions: z.array(AutomationQuestionSchema).max(L.maxQuestions).default([]),
    finish: z.object({
      text: text(L.messageText),
      whatsapp: z
        .object({
          phone: z.string().regex(/^\d{10,15}$/, 'WhatsApp: só dígitos com DDI, 10 a 15'),
          /** aceita {campo} das perguntas, ex.: "Oi, sou {nome}" */
          message: z.string().trim().max(L.whatsappMessage).default(''),
          buttonTitle: buttonTitle.default('Falar no WhatsApp'),
        })
        .optional(),
    }),
    /** acrescenta "Mensagem automática." à abertura (transparência exigida pela política da Meta) */
    disclosure: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.questions.forEach((q, i) => {
      if (seen.has(q.field)) {
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'field'], message: 'campo repetido' });
      }
      seen.add(q.field);
    });
  });

export type CommentAutomationConfig = z.infer<typeof CommentAutomationConfigSchema>;
export type CommentAutomationConfigInput = z.input<typeof CommentAutomationConfigSchema>;

// ---------- Transporte de mensagens (direct) ----------

export interface DirectButton {
  title: string;
  /** postback devolvido no webhook ao tocar */
  payload?: string;
  /** botão de link (ex.: wa.me) */
  url?: string;
}

export interface DirectMessage {
  text: string;
  /** até 3, renderizados no mesmo balão (aparecem na caixa de solicitações) */
  buttons?: DirectButton[];
  /** até 13 chips acima do teclado (não aparecem na caixa de solicitações) */
  quickReplies?: Array<{ title: string; payload: string }>;
}

/**
 * Envio no direct por um intermediário autorizado (hoje a Zernio; depois a Meta direto). Falhas são
 * `ProviderFailure`; `privateReply` marca `consumed` quando a resposta do comentário já foi gasta e
 * `uncertain` quando a rede não confirmou (nunca retentar).
 */
export interface DirectTransport {
  readonly id: string;
  privateReply(mediaId: string, commentId: string, msg: DirectMessage): Promise<{ messageId: string | null }>;
  sendMessage(conversationId: string, msg: DirectMessage, idempotencyKey: string): Promise<{ messageId: string | null }>;
}

/** detalhe extra de uma falha de resposta privada */
export interface PrivateReplyFailureDetail {
  consumed?: boolean;
  uncertain?: boolean;
}

// ---------- Evento de entrada normalizado (o adaptador da ponte traduz o payload dela) ----------

export interface InboundCommentEvent {
  kind: 'comment';
  /** id da conta na ponte (ex.: `account.accountId` da Zernio) */
  accountRef: string;
  commentId: string;
  mediaId: string;
  text: string;
  authorId: string;
  authorUsername: string | null;
  isReply: boolean;
  /** escrito pela própria conta (a Meta reentrega as respostas da conta como comentários) */
  isOwn: boolean;
}

export interface InboundMessageEvent {
  kind: 'message';
  accountRef: string;
  conversationId: string;
  senderId: string;
  senderUsername: string | null;
  text: string;
  /** postback de botão ou de resposta rápida */
  payload: string | null;
  /** chegou pelo caminho standby (outro app é dono da conversa) */
  standby: boolean;
  outgoing: boolean;
}

export type InboundAutomationEvent = InboundCommentEvent | InboundMessageEvent;
