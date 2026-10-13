import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { parseZernioEvent, verifyZernioSignature } from './zernio-events';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

describe('verifyZernioSignature', () => {
  test('aceita o HMAC hex do corpo cru e recusa o resto', () => {
    const body = '{"id":"e1"}';
    expect(verifyZernioSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyZernioSignature(SECRET, body, sign(body).toUpperCase())).toBe(true);
    expect(verifyZernioSignature(SECRET, `${body} `, sign(body))).toBe(false);
    expect(verifyZernioSignature(SECRET, body, null)).toBe(false);
    expect(verifyZernioSignature(SECRET, body, 'sha256=abc')).toBe(false);
  });
});

describe('parseZernioEvent', () => {
  test('comment.received do Instagram', () => {
    const ev = parseZernioEvent('comment.received', {
      id: 'e1',
      event: 'comment.received',
      comment: {
        id: '501',
        platformPostId: '1801',
        platform: 'instagram',
        text: 'quero',
        author: { id: 'igsid-1', username: 'cliente', isOwnAccount: false },
        isReply: false,
        parentCommentId: null,
      },
      account: { id: 'zig', accountId: 'zig', platform: 'instagram', username: 'invista' },
    });
    expect(ev).toEqual({
      kind: 'comment',
      accountRef: 'zig',
      commentId: '501',
      mediaId: '1801',
      text: 'quero',
      authorId: 'igsid-1',
      authorUsername: 'cliente',
      isReply: false,
      isOwn: false,
    });
  });

  test('message.received com postback e standby', () => {
    const ev = parseZernioEvent('message.received', {
      message: {
        conversationId: 'conv-1',
        platform: 'instagram',
        direction: 'incoming',
        text: 'Quero!',
        sender: { id: 'igsid-1', username: 'cliente' },
      },
      conversation: { id: 'conv-1', participantId: 'igsid-1' },
      account: { accountId: 'zig' },
      metadata: { postbackPayload: 'mp1:r:o:0', standby: true },
    });
    expect(ev).toMatchObject({ kind: 'message', payload: 'mp1:r:o:0', standby: true, outgoing: false, senderId: 'igsid-1' });
  });

  test('outra plataforma, teste da Zernio ou evento desconhecido → null', () => {
    const base = { account: { accountId: 'z' } };
    expect(parseZernioEvent('comment.received', { ...base, comment: { platform: 'facebook', id: '1', platformPostId: '2', author: { id: '3' } } })).toBeNull();
    expect(parseZernioEvent('message.received', { ...base, test: true })).toBeNull();
    expect(parseZernioEvent('post.published', base)).toBeNull();
  });
});
