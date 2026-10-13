import { describe, expect, test } from 'bun:test';
import { CommentAutomationConfigSchema, FlowV2Schema } from '@manypost/contracts';
import { flowFromV1, nodeForV1Step, tapFromV1, triggerFromV1 } from './flow-from-v1';
import { validateFlow } from './flow-validate';

/** forma da automação de produção, com textos marcadores */
const V1 = CommentAutomationConfigSchema.parse({
  trigger: { mediaIds: ['1801'], keywords: ['plano'] },
  publicReplies: ['Resposta pública'],
  opening: { text: 'Abertura', mode: 'button', buttonTitle: 'Quero!' },
  questions: [
    { kind: 'choice', field: 'plano', prompt: 'Pergunta 1', options: [{ title: 'A' }, { title: 'B' }] },
    { kind: 'choice', field: 'vidas', prompt: 'Pergunta 2', options: [1, 2, 3, 4].map((n) => ({ title: `${n}` })) },
    { kind: 'text', field: 'whatsapp', prompt: 'Pergunta 3', validate: 'phone' },
  ],
  finish: { text: 'Fim {plano}', whatsapp: { phone: '5592999990000', message: 'Quero {plano}' } },
});

describe('flowFromV1', () => {
  test('gera um grafo válido com ids determinísticos', () => {
    const f = flowFromV1(V1);
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(f.nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      'opening:opening',
      'q0:message',
      'q1:message',
      'q2:question',
      'finish:link',
      'end:end',
    ]);
    expect(f.nodes[1]).toMatchObject({ data: { format: 'buttons', saveTo: 'plano', onTyped: 'reask' } });
    expect(f.nodes[2]).toMatchObject({ data: { format: 'quick' } });
    expect(f.nodes[0]).toMatchObject({ data: { mode: 'button', buttonTitle: 'Quero!', disclosure: true } });
    expect(f.edges.map((e) => `${e.source}.${e.sourceHandle}>${e.target}`)).toEqual([
      'q0.o0>q1',
      'q0.o1>q1',
      'q1.o0>q2',
      'q1.o1>q2',
      'q1.o2>q2',
      'q1.o3>q2',
      'q2.next>finish',
      'opening.next>q0',
      'finish.next>end',
    ]);
    // só o aviso do modo botão
    expect(validateFlow(f).map((p) => p.code)).toEqual(['opening_button']);
  });

  test('sem WhatsApp o fim é um nó end com o texto; sem perguntas a abertura liga no fim', () => {
    const cfg = CommentAutomationConfigSchema.parse({ trigger: {}, opening: { text: 'Oi' }, finish: { text: 'Tchau' } });
    const f = flowFromV1(cfg);
    expect(f.nodes.map((n) => n.id)).toEqual(['opening', 'finish']);
    expect(f.nodes[1]).toMatchObject({ type: 'end', data: { text: 'Tchau' } });
    expect(f.edges).toEqual([{ id: 'e-opening-next', source: 'opening', sourceHandle: 'next', target: 'finish' }]);
  });

  test('gatilho, passo e toque', () => {
    expect(triggerFromV1(V1)).toEqual({ mediaIds: ['1801'], keywords: ['plano'], publicReplies: ['Resposta pública'] });
    const f = flowFromV1(V1);
    expect([-1, 0, 2, 3].map((s) => nodeForV1Step(f, s))).toEqual(['opening', 'q0', 'q2', 'finish']);
    // pergunta do meio apagada: não pula para o fim
    const sem = { ...f, nodes: f.nodes.filter((n) => n.id !== 'q1') };
    expect(nodeForV1Step(sem, 1)).toBe('q1');
    expect(nodeForV1Step(sem, 3)).toBe('finish');
    expect(tapFromV1(-1, 0)).toEqual({ nodeId: 'opening', handle: 'next' });
    expect(tapFromV1(1, 3)).toEqual({ nodeId: 'q1', handle: 'o3' });
  });
});
