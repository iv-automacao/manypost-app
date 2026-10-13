import { describe, expect, test } from 'bun:test';
import {
  AUTOMATION_LIMITS,
  AutomationRunStatuses,
  AutomationStatuses,
  AutomationTextValidations,
  CommentAutomationConfigSchema,
} from '@manypost/contracts';
import {
  LIMITS,
  RUN_STATUSES,
  STATUSES,
  TEXT_VALIDATIONS,
  answerEntries,
  configFromDraft,
  draftFromConfig,
  draftIssues,
  emptyDraft,
  fieldFromPrompt,
  previewConversation,
  renderTemplate,
  splitKeywords,
  splitUsernames,
} from './logic';

const LABELS = { disclosure: 'Mensagem automática.', textModeHint: 'Responda esta mensagem para continuar.' };

describe('paridade com @manypost/contracts', () => {
  test('limites, status e validações são os mesmos', () => {
    expect(LIMITS).toEqual(AUTOMATION_LIMITS);
    expect([...STATUSES]).toEqual([...AutomationStatuses]);
    expect([...RUN_STATUSES]).toEqual([...AutomationRunStatuses]);
    expect([...TEXT_VALIDATIONS]).toEqual([...AutomationTextValidations]);
  });

  test('o rascunho padrão vira uma configuração que a API aceita', () => {
    expect(draftIssues(emptyDraft())).toEqual([]);
    expect(CommentAutomationConfigSchema.safeParse(configFromDraft(emptyDraft())).success).toBe(true);
  });

  test('WhatsApp desligado não vai no corpo; ligado com telefone válido passa na API', () => {
    const d = emptyDraft();
    expect(configFromDraft(d).finish).not.toHaveProperty('whatsapp');
    d.finish.whatsappEnabled = true;
    d.finish.whatsapp.phone = '5592999990000';
    expect(CommentAutomationConfigSchema.safeParse(configFromDraft(d)).success).toBe(true);
  });

  test('ida e volta pela API preserva o rascunho', () => {
    const d = emptyDraft();
    d.finish.whatsappEnabled = true;
    d.finish.whatsapp.phone = '5592999990000';
    const api = CommentAutomationConfigSchema.parse(configFromDraft(d));
    expect(draftFromConfig(api)).toEqual(d);
  });
});

describe('draftIssues', () => {
  test('aponta botão longo, opções demais, campo repetido e telefone inválido', () => {
    const d = emptyDraft();
    d.opening.buttonTitle = 'um título grande demais aqui';
    d.questions = [
      { kind: 'choice', field: 'plano', prompt: 'Qual?', options: Array.from({ length: 14 }, (_, i) => ({ title: `O${i}` })) },
      { kind: 'text', field: 'plano', prompt: 'De novo?', validate: 'free' },
    ];
    d.finish.whatsappEnabled = true;
    d.finish.whatsapp.phone = '+55 92';
    expect(draftIssues(d)).toEqual([
      { key: 'buttonTitle' },
      { key: 'optionsCount', question: 0 },
      { key: 'fieldDuplicate', question: 1 },
      { key: 'whatsappPhone' },
    ]);
  });

  test('modo texto não exige título de botão', () => {
    const d = emptyDraft();
    d.opening.mode = 'text';
    d.opening.buttonTitle = '';
    expect(draftIssues(d)).toEqual([]);
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

describe('previewConversation', () => {
  test('comentário, resposta pública, abertura com botão, perguntas e fim com WhatsApp', () => {
    const d = emptyDraft();
    d.questions.push({
      kind: 'choice',
      field: 'plano',
      prompt: 'Qual plano?',
      options: ['A', 'B', 'C', 'D'].map((title) => ({ title })),
    });
    d.finish.whatsappEnabled = true;
    d.finish.whatsapp.phone = '5592999990000';
    const b = previewConversation(d, LABELS);
    expect(b.map((x) => x.side)).toEqual(['comment', 'reply', 'brand', 'user', 'brand', 'user', 'brand', 'user', 'brand']);
    expect(b[2]).toEqual({
      side: 'brand',
      text: `${d.opening.text}\n\nMensagem automática.`,
      buttons: ['Quero!'],
    });
    expect(b[6]?.chips).toEqual(['A', 'B', 'C', 'D']);
    expect(b.at(-1)).toMatchObject({ text: 'Obrigado, Ana! Toque abaixo para continuar no WhatsApp com a nossa equipe.', link: true });
  });
});
