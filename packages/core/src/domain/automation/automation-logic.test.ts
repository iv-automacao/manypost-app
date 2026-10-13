import { describe, expect, test } from 'bun:test';
import { CommentAutomationConfigSchema } from '@manypost/contracts';
import {
  decodePayload,
  encodePayload,
  finishMessage,
  matchesTrigger,
  matchOption,
  normalizeText,
  openingMessage,
  promptMessage,
  renderTemplate,
  validateAnswer,
  whatsappUrl,
} from './automation-logic';

const cfg = (over: Record<string, unknown> = {}) =>
  CommentAutomationConfigSchema.parse({
    trigger: { keywords: ['cotação', 'quero saber'] },
    opening: { text: 'Oi! Toque abaixo.' },
    finish: { text: 'Pronto, {nome}!' },
    ...over,
  });

describe('normalizeText e matchesTrigger', () => {
  test('ignora acento, caixa e pontuação', () => {
    expect(normalizeText('  Quero uma COTAÇÃO!!! ')).toBe('quero uma cotacao');
  });

  test('palavra ou frase inteira', () => {
    const c = cfg();
    expect(matchesTrigger(c, { mediaId: '1', text: 'quero uma Cotacao' })).toBe(true);
    expect(matchesTrigger(c, { mediaId: '1', text: 'Quero saber, por favor' })).toBe(true);
    expect(matchesTrigger(c, { mediaId: '1', text: 'cotações?' })).toBe(false);
    expect(matchesTrigger(c, { mediaId: '1', text: 'eu quero' })).toBe(false);
  });

  test('sem palavra-chave = qualquer comentário; post fora da lista não casa', () => {
    const c = cfg({ trigger: { keywords: [], mediaIds: ['1801'] } });
    expect(matchesTrigger(c, { mediaId: '1801', text: 'oi' })).toBe(true);
    expect(matchesTrigger(c, { mediaId: '1802', text: 'oi' })).toBe(false);
  });
});

describe('payload', () => {
  test('ida e volta, com abertura como -1', () => {
    expect(decodePayload(encodePayload('run-1', -1, 0))).toEqual({ runId: 'run-1', step: -1, option: 0 });
    expect(decodePayload(encodePayload('run-1', 2, 7))).toEqual({ runId: 'run-1', step: 2, option: 7 });
  });
  test('payload alheio ou quebrado → null', () => {
    expect(decodePayload('SEND_LINK')).toBeNull();
    expect(decodePayload('mp1:run:x:0')).toBeNull();
    expect(decodePayload(null)).toBeNull();
  });
});

describe('validateAnswer', () => {
  test('telefone: só dígitos, 10 a 13', () => {
    expect(validateAnswer('phone', '(92) 99999-0000')).toEqual({ ok: true, value: '92999990000' });
    expect(validateAnswer('phone', 'não sei').ok).toBe(false);
  });
  test('e-mail, nome e livre', () => {
    expect(validateAnswer('email', ' Ana@Invista.com.br ')).toEqual({ ok: true, value: 'ana@invista.com.br' });
    expect(validateAnswer('email', 'ana@').ok).toBe(false);
    expect(validateAnswer('name', 'Ana Souza')).toEqual({ ok: true, value: 'Ana Souza' });
    expect(validateAnswer('name', 'A').ok).toBe(false);
    expect(validateAnswer('free', '  ').ok).toBe(false);
  });
});

describe('mensagens', () => {
  test('abertura com botão e aviso de automação', () => {
    const m = openingMessage(cfg(), 'run-1');
    expect(m.text).toBe('Oi! Toque abaixo.\n\nMensagem automática.');
    expect(m.buttons).toEqual([{ title: 'Quero!', payload: 'mp1:run-1:o:0' }]);
  });

  test('abertura em modo texto pede resposta e não leva botão', () => {
    const m = openingMessage(cfg({ opening: { text: 'Oi!', mode: 'text' }, disclosure: false }), 'run-1');
    expect(m.buttons).toBeUndefined();
    expect(m.text).toBe('Oi!\n\nResponda esta mensagem para continuar.');
  });

  test('escolha com até 3 opções vira botões; com mais, respostas rápidas', () => {
    const tres = cfg({
      questions: [{ kind: 'choice', field: 'plano', prompt: 'Qual?', options: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }],
    });
    expect(promptMessage(tres, 'r', 0).buttons?.map((b) => b.payload)).toEqual(['mp1:r:0:0', 'mp1:r:0:1', 'mp1:r:0:2']);
    const quatro = cfg({
      questions: [
        { kind: 'choice', field: 'plano', prompt: 'Qual?', options: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] },
      ],
    });
    const m = promptMessage(quatro, 'r', 0);
    expect(m.buttons).toBeUndefined();
    expect(m.quickReplies?.at(3)).toEqual({ title: 'D', payload: 'mp1:r:0:3' });
  });

  test('pergunta de texto é só o texto', () => {
    const c = cfg({ questions: [{ kind: 'text', field: 'nome', prompt: 'Seu nome?', validate: 'name' }] });
    expect(promptMessage(c, 'r', 0)).toEqual({ text: 'Seu nome?' });
  });

  test('opção por texto digitado, sem acento e caixa', () => {
    const c = cfg({
      questions: [{ kind: 'choice', field: 'plano', prompt: 'Qual?', options: [{ title: 'Saúde' }, { title: 'Vida' }] }],
    });
    const q = c.questions[0]!;
    expect(q.kind === 'choice' && matchOption(q, 'saude')).toBe(0);
    expect(q.kind === 'choice' && matchOption(q, 'carro')).toBe(-1);
  });

  test('fim com botão do WhatsApp e texto preenchido com as respostas', () => {
    const c = cfg({
      finish: {
        text: 'Pronto, {nome}!',
        whatsapp: { phone: '5592999990000', message: 'Oi, sou {nome} (@{username}), quero {plano}' },
      },
    });
    const answers = { nome: 'Ana', plano: 'Saúde' };
    const m = finishMessage(c, answers, 'ana.s');
    expect(m.text).toBe('Pronto, Ana!');
    expect(m.buttons).toEqual([
      { title: 'Falar no WhatsApp', url: whatsappUrl(c, answers, 'ana.s')! },
    ]);
    expect(whatsappUrl(c, answers, 'ana.s')).toBe(
      `https://wa.me/5592999990000?text=${encodeURIComponent('Oi, sou Ana (@ana.s), quero Saúde')}`,
    );
  });

  test('campo sem resposta vira vazio', () => {
    expect(renderTemplate('Oi {nome}{x}', {}, null)).toBe('Oi ');
  });
});
