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

/** `{campo}` e `{username}` — mesmo comportamento do motor */
export function renderTemplate(tpl: string, answers: Record<string, string>, username: string | null): string {
  return tpl.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (_, k: string) =>
    k === 'username' ? (username ?? '') : (answers[k] ?? ''),
  );
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
