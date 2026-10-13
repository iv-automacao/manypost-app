import type {
  AutomationQuestion,
  AutomationTextValidation,
  CommentAutomationConfig,
  DirectMessage,
} from '@manypost/contracts';
import { AUTOMATION_LIMITS } from '@manypost/contracts';

/**
 * Regras puras da automação comentário → direct (add-comment-automation, design D3/D4/D9). Sem I/O:
 * o motor (`use-cases/comment-automation.ts`) decide quando chamar cada uma.
 */

const DISCLOSURE = 'Mensagem automática.';
const TEXT_MODE_HINT = 'Responda esta mensagem para continuar.';
const PAYLOAD_PREFIX = 'mp1';

/** minúsculas, sem acento, pontuação vira espaço, espaços colapsados */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** post na lista (ou lista vazia) e palavra-chave como palavra/frase inteira (ou sem palavras) */
export function matchesTrigger(cfg: CommentAutomationConfig, c: { mediaId: string; text: string }): boolean {
  const { mediaIds, keywords } = cfg.trigger;
  if (mediaIds.length > 0 && !mediaIds.includes(c.mediaId)) return false;
  if (keywords.length === 0) return true;
  const hay = ` ${normalizeText(c.text)} `;
  return keywords.some((k) => {
    const n = normalizeText(k);
    return n.length > 0 && hay.includes(` ${n} `);
  });
}

/** `mp1:<runId>:<step|o>:<opção>` — localiza a execução sem depender do id do remetente */
export function encodePayload(runId: string, step: number, option: number): string {
  return `${PAYLOAD_PREFIX}:${runId}:${step < 0 ? 'o' : step}:${option}`;
}

export function decodePayload(p: string | null | undefined): { runId: string; step: number; option: number } | null {
  if (!p) return null;
  const m = /^mp1:([A-Za-z0-9-]{1,64}):(o|\d{1,2}):(\d{1,2})$/i.exec(p);
  if (!m) return null;
  return { runId: m[1]!, step: m[2] === 'o' ? -1 : Number(m[2]), option: Number(m[3]) };
}

export function validateAnswer(
  kind: AutomationTextValidation,
  raw: string,
): { ok: true; value: string } | { ok: false } {
  const t = raw.trim();
  switch (kind) {
    case 'phone': {
      const digits = t.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 13 ? { ok: true, value: digits } : { ok: false };
    }
    case 'email': {
      const v = t.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? { ok: true, value: v } : { ok: false };
    }
    case 'name':
      return t.length >= 2 && t.length <= 80 ? { ok: true, value: t } : { ok: false };
    case 'free':
      return t.length >= 1 ? { ok: true, value: t.slice(0, 500) } : { ok: false };
  }
}

/** índice da opção cujo título bate com o texto digitado (sem acento/caixa), ou -1 */
export function matchOption(q: Extract<AutomationQuestion, { kind: 'choice' }>, text: string): number {
  const n = normalizeText(text);
  return q.options.findIndex((o) => normalizeText(o.title) === n);
}

export function openingMessage(cfg: CommentAutomationConfig, runId: string): DirectMessage {
  const parts = [cfg.opening.text];
  if (cfg.opening.mode === 'text') parts.push(TEXT_MODE_HINT);
  if (cfg.disclosure) parts.push(DISCLOSURE);
  const text = parts.join('\n\n');
  return cfg.opening.mode === 'button'
    ? { text, buttons: [{ title: cfg.opening.buttonTitle, payload: encodePayload(runId, -1, 0) }] }
    : { text };
}

/** pergunta `step`: até 3 opções em botões (aparecem na caixa de solicitações), acima disso chips */
export function promptMessage(cfg: CommentAutomationConfig, runId: string, step: number): DirectMessage {
  const q = cfg.questions[step];
  if (!q) throw new Error(`pergunta ${step} inexistente`);
  if (q.kind === 'text') return { text: q.prompt };
  const opts = q.options.map((o, i) => ({ title: o.title, payload: encodePayload(runId, step, i) }));
  return opts.length <= AUTOMATION_LIMITS.maxButtons ? { text: q.prompt, buttons: opts } : { text: q.prompt, quickReplies: opts };
}

/** `{campo}` das respostas e `{username}` de quem comentou; campo ausente vira vazio */
export function renderTemplate(tpl: string, answers: Record<string, string>, username: string | null): string {
  return tpl.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (_, k: string) =>
    k === 'username' ? (username ?? '') : (answers[k] ?? ''),
  );
}

export function whatsappUrl(
  cfg: CommentAutomationConfig,
  answers: Record<string, string>,
  username: string | null,
): string | null {
  const wa = cfg.finish.whatsapp;
  if (!wa) return null;
  const msg = renderTemplate(wa.message, answers, username).trim();
  return `https://wa.me/${wa.phone}${msg ? `?text=${encodeURIComponent(msg)}` : ''}`;
}

export function finishMessage(
  cfg: CommentAutomationConfig,
  answers: Record<string, string>,
  username: string | null,
): DirectMessage {
  const text = renderTemplate(cfg.finish.text, answers, username);
  const url = whatsappUrl(cfg, answers, username);
  return url && cfg.finish.whatsapp ? { text, buttons: [{ title: cfg.finish.whatsapp.buttonTitle, url }] } : { text };
}

/** sorteia uma variação de resposta pública (`rand` em [0,1)) */
export function pickPublicReply(cfg: CommentAutomationConfig, rand: number): string | null {
  const v = cfg.publicReplies;
  return v.length ? v[Math.min(v.length - 1, Math.floor(rand * v.length))]! : null;
}
