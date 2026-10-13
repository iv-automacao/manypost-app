import { describe, expect, test } from 'bun:test';
import {
  AUTOMATION_LIMITS,
  AutomationRunStatuses,
  AutomationStatuses,
  AutomationTextValidations,
} from '@manypost/contracts';
import {
  LIMITS,
  RUN_STATUSES,
  STATUSES,
  TEXT_VALIDATIONS,
  answerEntries,
  fieldFromPrompt,
  renderTemplate,
  splitKeywords,
  splitUsernames,
} from './logic';

describe('paridade com @manypost/contracts', () => {
  test('limites, status e validações são os mesmos', () => {
    expect(LIMITS).toEqual(AUTOMATION_LIMITS);
    expect([...STATUSES]).toEqual([...AutomationStatuses]);
    expect([...RUN_STATUSES]).toEqual([...AutomationRunStatuses]);
    expect([...TEXT_VALIDATIONS]).toEqual([...AutomationTextValidations]);
  });
});

describe('textos', () => {
  test('palavras-chave por vírgula ou linha, sem repetir acento/caixa', () => {
    expect(splitKeywords('quero, Cotação\ncotacao;  preço ,')).toEqual(['quero', 'Cotação', 'preço']);
  });

  test('campo a partir da pergunta, sem colidir', () => {
    expect(fieldFromPrompt('Qual seu WhatsApp?')).toBe('qual_seu_whatsapp');
    expect(fieldFromPrompt('Qual seu WhatsApp?', ['qual_seu_whatsapp'])).toBe('qual_seu_whatsapp_2');
    expect(fieldFromPrompt('???')).toBe('campo');
    expect(fieldFromPrompt('3 opções')).toBe('opcoes');
  });

  test('template com respostas e username', () => {
    expect(renderTemplate('Oi {nome} (@{username}){x}', { nome: 'Ana' }, 'ana.s')).toBe('Oi Ana (@ana.s)');
  });

  test('usernames de teste sem @ e minúsculos', () => {
    expect(splitUsernames('@IagoVieira.IA, outra  outra')).toEqual(['iagovieira.ia', 'outra']);
  });

  test('respostas na ordem das perguntas', () => {
    expect(answerEntries({ b: '2', extra: 'x', a: '1' }, ['a', 'b'])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['extra', 'x'],
    ]);
  });
});
