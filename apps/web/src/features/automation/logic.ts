/**
 * Automação comentário → direct (add-comment-automation): regras puras da tela. Os limites repetem
 * `AUTOMATION_LIMITS` de `@manypost/contracts` porque `apps/web` não carrega aquele pacote no bundle;
 * a paridade é assertada em `logic.test.ts`. A API valida de novo — aqui é só para orientar quem edita.
 */

export const LIMITS = {
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

export const STATUSES = ['DRAFT', 'TEST', 'ACTIVE', 'PAUSED'] as const;
export type Status = (typeof STATUSES)[number];
export const RUN_STATUSES = ['OPEN', 'COMPLETED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'ABANDONED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TEXT_VALIDATIONS = ['name', 'phone', 'email', 'free'] as const;
export type TextValidation = (typeof TEXT_VALIDATIONS)[number];

export interface ChoiceQuestion {
  kind: 'choice';
  field: string;
  prompt: string;
  options: Array<{ title: string }>;
}
export interface TextQuestion {
  kind: 'text';
  field: string;
  prompt: string;
  validate: TextValidation;
}
export type Question = ChoiceQuestion | TextQuestion;

/** configuração completa em edição (o WhatsApp fica guardado mesmo desligado, para não perder o texto) */
export interface Draft {
  trigger: { mediaIds: string[]; keywords: string[] };
  publicReplies: string[];
  opening: { text: string; mode: 'button' | 'text'; buttonTitle: string };
  questions: Question[];
  finish: { text: string; whatsappEnabled: boolean; whatsapp: { phone: string; message: string; buttonTitle: string } };
  disclosure: boolean;
}

export function emptyDraft(): Draft {
  return {
    trigger: { mediaIds: [], keywords: ['quero'] },
    publicReplies: ['Te chamei no direct!'],
    opening: {
      text: 'Oi! Vi seu comentário. Toque no botão abaixo que eu te passo os detalhes.',
      mode: 'button',
      buttonTitle: 'Quero!',
    },
    questions: [{ kind: 'text', field: 'nome', prompt: 'Para começar, qual é o seu nome?', validate: 'name' }],
    finish: {
      text: 'Obrigado, {nome}! Toque abaixo para continuar no WhatsApp com a nossa equipe.',
      whatsappEnabled: false,
      whatsapp: { phone: '', message: 'Olá! Sou {nome} e vim pelo Instagram.', buttonTitle: 'Falar no WhatsApp' },
    },
    disclosure: true,
  };
}

/** configuração vinda da API → rascunho editável */
export function draftFromConfig(cfg: {
  trigger?: { mediaIds?: string[]; keywords?: string[] };
  publicReplies?: string[];
  opening: { text: string; mode?: 'button' | 'text'; buttonTitle?: string };
  questions?: Question[];
  finish: { text: string; whatsapp?: { phone: string; message?: string; buttonTitle?: string } };
  disclosure?: boolean;
}): Draft {
  const base = emptyDraft();
  return {
    trigger: { mediaIds: cfg.trigger?.mediaIds ?? [], keywords: cfg.trigger?.keywords ?? [] },
    publicReplies: cfg.publicReplies ?? [],
    opening: {
      text: cfg.opening.text,
      mode: cfg.opening.mode ?? 'button',
      buttonTitle: cfg.opening.buttonTitle ?? 'Quero!',
    },
    questions: cfg.questions ?? [],
    finish: {
      text: cfg.finish.text,
      whatsappEnabled: Boolean(cfg.finish.whatsapp),
      whatsapp: {
        phone: cfg.finish.whatsapp?.phone ?? '',
        message: cfg.finish.whatsapp?.message ?? base.finish.whatsapp.message,
        buttonTitle: cfg.finish.whatsapp?.buttonTitle ?? base.finish.whatsapp.buttonTitle,
      },
    },
    disclosure: cfg.disclosure ?? true,
  };
}

/** rascunho → corpo `config` da API */
export function configFromDraft(d: Draft) {
  return {
    version: 1 as const,
    trigger: { mediaIds: d.trigger.mediaIds, keywords: d.trigger.keywords },
    publicReplies: d.publicReplies.map((r) => r.trim()).filter(Boolean),
    opening: d.opening,
    questions: d.questions,
    finish: {
      text: d.finish.text,
      ...(d.finish.whatsappEnabled ? { whatsapp: d.finish.whatsapp } : {}),
    },
    disclosure: d.disclosure,
  };
}

/** "quero, Cotação\npreço" → ['quero', 'Cotação', 'preço'] sem repetir (sem acento/caixa) */
export function splitKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n;]/)) {
    const k = raw.trim();
    const key = normalize(k);
    if (!k || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** nome de campo a partir do texto da pergunta: "Qual seu WhatsApp?" → "qual_seu_whatsapp" */
export function fieldFromPrompt(prompt: string, taken: string[] = []): string {
  const words = normalize(prompt).split(' ').filter(Boolean).slice(0, 3);
  let base = words.join('_').replace(/^[^a-z]+/, '').slice(0, 28) || 'campo';
  if (!/^[a-z]/.test(base)) base = `campo_${base}`.slice(0, 28);
  let field = base;
  for (let i = 2; taken.includes(field); i++) field = `${base}_${i}`;
  return field;
}

export type IssueKey =
  | 'openingText'
  | 'buttonTitle'
  | 'tooManyQuestions'
  | 'questionPrompt'
  | 'fieldFormat'
  | 'fieldDuplicate'
  | 'optionsCount'
  | 'optionTitle'
  | 'finishText'
  | 'whatsappPhone'
  | 'whatsappButton'
  | 'keywordTooLong'
  | 'tooManyKeywords'
  | 'publicReplyTooLong'
  | 'tooManyMedia';

export interface Issue {
  key: IssueKey;
  /** posição da pergunta, quando o problema é numa pergunta */
  question?: number;
}

const tooLong = (s: string, max: number) => s.trim().length === 0 || s.trim().length > max;

/** o que impede salvar — mesmas regras do schema da API */
export function draftIssues(d: Draft): Issue[] {
  const out: Issue[] = [];
  if (tooLong(d.opening.text, LIMITS.messageText)) out.push({ key: 'openingText' });
  if (d.opening.mode === 'button' && tooLong(d.opening.buttonTitle, LIMITS.buttonTitle)) out.push({ key: 'buttonTitle' });
  if (d.trigger.keywords.length > LIMITS.maxKeywords) out.push({ key: 'tooManyKeywords' });
  if (d.trigger.keywords.some((k) => k.length > LIMITS.keyword)) out.push({ key: 'keywordTooLong' });
  if (d.trigger.mediaIds.length > LIMITS.maxMedia) out.push({ key: 'tooManyMedia' });
  if (d.publicReplies.some((r) => r.trim().length > LIMITS.publicReply)) out.push({ key: 'publicReplyTooLong' });
  if (d.questions.length > LIMITS.maxQuestions) out.push({ key: 'tooManyQuestions' });
  const seen = new Set<string>();
  d.questions.forEach((q, i) => {
    if (tooLong(q.prompt, LIMITS.messageText)) out.push({ key: 'questionPrompt', question: i });
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(q.field)) out.push({ key: 'fieldFormat', question: i });
    else if (seen.has(q.field)) out.push({ key: 'fieldDuplicate', question: i });
    seen.add(q.field);
    if (q.kind === 'choice') {
      if (q.options.length < 1 || q.options.length > LIMITS.maxOptions) out.push({ key: 'optionsCount', question: i });
      if (q.options.some((o) => tooLong(o.title, LIMITS.buttonTitle))) out.push({ key: 'optionTitle', question: i });
    }
  });
  if (tooLong(d.finish.text, LIMITS.messageText)) out.push({ key: 'finishText' });
  if (d.finish.whatsappEnabled) {
    if (!/^\d{10,15}$/.test(d.finish.whatsapp.phone)) out.push({ key: 'whatsappPhone' });
    if (tooLong(d.finish.whatsapp.buttonTitle, LIMITS.buttonTitle)) out.push({ key: 'whatsappButton' });
  }
  return out;
}

/** `{campo}` e `{username}` — mesmo comportamento do motor */
export function renderTemplate(tpl: string, answers: Record<string, string>, username: string | null): string {
  return tpl.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (_, k: string) =>
    k === 'username' ? (username ?? '') : (answers[k] ?? ''),
  );
}

const SAMPLE: Record<TextValidation, string> = {
  name: 'Ana',
  phone: '(92) 99999-0000',
  email: 'ana@email.com',
  free: 'Quero saber mais',
};

export interface Bubble {
  side: 'comment' | 'reply' | 'brand' | 'user';
  text: string;
  buttons?: string[];
  /** opções como chips (mais de 3) — não aparecem na caixa de solicitações */
  chips?: string[];
  link?: boolean;
}

/** conversa de exemplo, na ordem em que a pessoa vê */
export function previewConversation(d: Draft, labels: { disclosure: string; textModeHint: string }): Bubble[] {
  const user = 'cliente';
  const answers: Record<string, string> = {};
  const out: Bubble[] = [{ side: 'comment', text: d.trigger.keywords[0] ?? 'Quero!' }];
  const reply = d.publicReplies.find((r) => r.trim());
  if (reply) out.push({ side: 'reply', text: reply });

  const opening = [d.opening.text, d.opening.mode === 'text' ? labels.textModeHint : null, d.disclosure ? labels.disclosure : null]
    .filter(Boolean)
    .join('\n\n');
  out.push(
    d.opening.mode === 'button'
      ? { side: 'brand', text: opening, buttons: [d.opening.buttonTitle] }
      : { side: 'brand', text: opening },
  );
  out.push({ side: 'user', text: d.opening.mode === 'button' ? d.opening.buttonTitle : 'Oi' });

  for (const q of d.questions) {
    if (q.kind === 'choice') {
      const titles = q.options.map((o) => o.title);
      out.push(
        titles.length <= LIMITS.maxButtons
          ? { side: 'brand', text: q.prompt, buttons: titles }
          : { side: 'brand', text: q.prompt, chips: titles },
      );
      const a = titles[0] ?? '';
      answers[q.field] = a;
      out.push({ side: 'user', text: a });
    } else {
      out.push({ side: 'brand', text: q.prompt });
      answers[q.field] = SAMPLE[q.validate];
      out.push({ side: 'user', text: SAMPLE[q.validate] });
    }
  }
  const finish = renderTemplate(d.finish.text, answers, user);
  out.push(
    d.finish.whatsappEnabled
      ? { side: 'brand', text: finish, buttons: [d.finish.whatsapp.buttonTitle], link: true }
      : { side: 'brand', text: finish },
  );
  return out;
}

export function statusVariant(s: Status): 'neutral' | 'review' | 'published' | 'scheduled' {
  return s === 'ACTIVE' ? 'published' : s === 'TEST' ? 'review' : s === 'PAUSED' ? 'scheduled' : 'neutral';
}

export function runStatusVariant(s: RunStatus): 'neutral' | 'review' | 'published' | 'publishing' | 'failed' {
  switch (s) {
    case 'COMPLETED':
      return 'published';
    case 'OPEN':
      return 'publishing';
    case 'FAILED':
      return 'failed';
    case 'UNCERTAIN':
      return 'review';
    case 'SKIPPED':
      return 'neutral';
    case 'ABANDONED':
      return 'neutral';
  }
}

/** respostas do lead na ordem das perguntas quando conhecidas, depois o resto */
export function answerEntries(answers: Record<string, string>, order: string[] = []): Array<[string, string]> {
  const known = order.filter((k) => k in answers).map((k) => [k, answers[k]!] as [string, string]);
  const rest = Object.entries(answers).filter(([k]) => !order.includes(k));
  return [...known, ...rest];
}

/** "@Fulano, beltrano" → ['fulano', 'beltrano'] */
export function splitUsernames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((u) => u.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean),
    ),
  ];
}
