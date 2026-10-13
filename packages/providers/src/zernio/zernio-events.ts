import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundAutomationEvent } from '@manypost/contracts';

/**
 * Webhook da Zernio → evento normalizado da automação (change add-comment-automation, design D7/D8).
 * Formatos da OpenAPI pública v1.262 (`WebhookPayloadComment`, `WebhookPayloadMessage`). Só
 * Instagram; qualquer outro evento ou plataforma volta `null` (respondido 200 e ignorado).
 */

/** `X-Zernio-Signature` = HMAC-SHA256 em hex do corpo cru com o segredo do webhook */
export function verifyZernioSignature(secret: string, rawBody: string, signature: string | null | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(signature, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function parseZernioEvent(eventType: string, payload: unknown): InboundAutomationEvent | null {
  const p = obj(payload);
  if (p.test === true) return null;
  const account = obj(p.account);
  const accountRef = str(account.accountId) ?? str(account.id);
  if (!accountRef) return null;

  if (eventType === 'comment.received') {
    const c = obj(p.comment);
    const author = obj(c.author);
    const commentId = str(c.id);
    const mediaId = str(c.platformPostId);
    const authorId = str(author.id);
    if (c.platform !== 'instagram' || !commentId || !mediaId || !authorId) return null;
    return {
      kind: 'comment',
      accountRef,
      commentId,
      mediaId,
      text: typeof c.text === 'string' ? c.text : '',
      authorId,
      authorUsername: str(author.username),
      isReply: c.isReply === true,
      isOwn: author.isOwnAccount === true,
    };
  }

  if (eventType === 'message.received') {
    const m = obj(p.message);
    const conv = obj(p.conversation);
    const sender = obj(m.sender);
    const meta = obj(p.metadata);
    const conversationId = str(m.conversationId) ?? str(conv.id);
    const senderId = str(sender.id) ?? str(conv.participantId);
    if (m.platform !== 'instagram' || !conversationId || !senderId) return null;
    return {
      kind: 'message',
      accountRef,
      conversationId,
      senderId,
      senderUsername: str(sender.username) ?? str(conv.participantUsername),
      text: typeof m.text === 'string' ? m.text : '',
      payload: str(meta.postbackPayload) ?? str(meta.quickReplyPayload),
      standby: meta.standby === true,
      outgoing: m.direction === 'outgoing',
    };
  }
  return null;
}
