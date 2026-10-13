import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  FlowConditionOps,
  FlowMessageFormats,
  FlowNodeTypes,
  FlowOnTypedModes,
  FlowOpeningModes,
  FlowProblemCodes,
  FlowV2Schema,
} from '@manypost/contracts';
import {
  CONDITION_OPS,
  FLOW_NODE_TYPES,
  MESSAGE_FORMATS,
  ON_TYPED_MODES,
  OPENING_MODES,
  PROBLEM_CODES,
  addOption,
  connect,
  createNode,
  duplicateNode,
  emptyFlow,
  normalizeFlow,
  removeNode,
  removeOption,
  shapeIssues,
  simulateFlow,
  updateNodeData,
  validateFlow,
  type NodeTexts,
} from './logic';

const TEXTS: NodeTexts = {
  opening: 'Oi! Vi seu comentário.',
  askName: 'Qual é o seu nome?',
  thanks: 'Obrigado, {nome}!',
  message: 'Escolha:',
  option: 'Opção',
  question: 'Sua resposta?',
  end: 'Obrigado!',
  link: 'Toque abaixo.',
  linkButton: 'Abrir',
  follow: 'Segue a gente.',
  followButton: 'Seguir',
};

describe('paridade com @manypost/contracts', () => {
  test('vocabulário igual', () => {
    expect([...FLOW_NODE_TYPES]).toEqual([...FlowNodeTypes]);
    expect([...OPENING_MODES]).toEqual([...FlowOpeningModes]);
    expect([...MESSAGE_FORMATS]).toEqual([...FlowMessageFormats]);
    expect([...ON_TYPED_MODES]).toEqual([...FlowOnTypedModes]);
    expect([...CONDITION_OPS]).toEqual([...FlowConditionOps]);
    expect([...PROBLEM_CODES]).toEqual([...FlowProblemCodes]);
  });

  test('o fluxo inicial passa no schema da API e não tem problemas', () => {
    const f = emptyFlow(TEXTS);
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(validateFlow(f)).toEqual([]);
    expect(shapeIssues(f)).toEqual([]);
  });

  test('todo bloco novo passa no schema (WhatsApp com telefone preenchido)', () => {
    let f = emptyFlow(TEXTS);
    for (const kind of ['message', 'question', 'condition', 'link', 'follow', 'end'] as const) {
      let n = createNode(kind, { x: 10, y: 20 }, f, TEXTS, 'sua.conta');
      if (n.type === 'link' && n.data.target.kind === 'whatsapp') {
        n = { ...n, data: { ...n.data, target: { kind: 'whatsapp', phone: '5592999990000', message: '' } } };
      }
      if (n.type === 'condition') n = { ...n, data: { ...n.data, field: 'nome' } };
      f = { ...f, nodes: [...f.nodes, n] };
    }
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(f.nodes.find((n) => n.id.startsWith('seguir'))).toMatchObject({
      type: 'link',
      data: { target: { kind: 'url', url: 'https://instagram.com/sua.conta' }, buttonTitle: 'Seguir' },
    });
  });
});

describe('fixtures compartilhadas com o core', () => {
  const DIR = new URL('../../../../../../testdata/automation-flows/', import.meta.url);
  for (const file of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
    const fx = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
    test(`${file}: ${fx.name}`, () => {
      const flow = normalizeFlow(fx.flow);
      expect(validateFlow(flow)).toEqual(fx.expect.problems ?? []);
      if (fx.expect.messages) {
        const r = simulateFlow(flow, fx.inputs ?? [], { username: fx.username ?? null });
        expect(r.messages).toEqual(fx.expect.messages);
        expect(r.status).toBe(fx.expect.status);
        if (fx.expect.answers) expect(r.answers).toEqual(fx.expect.answers);
      }
    });
  }
});

describe('edição', () => {
  test('ligar substitui a saída e recusa ligar na abertura ou em si mesmo', () => {
    let f = emptyFlow(TEXTS);
    const end = createNode('end', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, end] };
    f = connect(f, { source: 'opening', sourceHandle: 'next', target: end.id });
    expect(f.edges.filter((e) => e.source === 'opening')).toEqual([
      { id: 'e-opening-next', source: 'opening', sourceHandle: 'next', target: end.id },
    ]);
    expect(connect(f, { source: end.id, sourceHandle: 'next', target: 'opening' })).toBe(f);
    expect(connect(f, { source: 'nome', sourceHandle: 'next', target: 'nome' })).toBe(f);
  });

  test('abertura não sai; remover nó leva as ligações junto', () => {
    const f = emptyFlow(TEXTS);
    expect(removeNode(f, 'opening')).toBe(f);
    const g = removeNode(f, 'nome');
    expect(g.nodes.map((n) => n.id)).toEqual(['opening', 'fim']);
    expect(g.edges).toEqual([]);
  });

  test('opções: adicionar respeita o limite, remover apaga a ligação, formato sem botões limpa', () => {
    let f = emptyFlow(TEXTS);
    const m = createNode('message', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, m] };
    f = addOption(addOption(addOption(f, m.id, 'Mais'), m.id, 'Outra'), m.id, 'Quarta');
    const opts = () => (f.nodes.find((n) => n.id === m.id) as Extract<typeof m, { type: 'message' }>).data.options;
    expect(opts()).toHaveLength(3);
    f = connect(f, { source: m.id, sourceHandle: opts()[1]!.id, target: 'fim' });
    f = removeOption(f, m.id, opts()[1]!.id);
    expect(f.edges.some((e) => e.source === m.id)).toBe(false);
    f = connect(f, { source: m.id, sourceHandle: opts()[0]!.id, target: 'fim' });
    f = updateNodeData(f, m.id, { format: 'none', options: [] });
    expect(f.edges.some((e) => e.source === m.id)).toBe(false);
  });

  test('duplicar gera id novo, desloca e copia só as saídas', () => {
    const f = emptyFlow(TEXTS);
    const r = duplicateNode(f, 'nome');
    const copy = r.flow.nodes.find((n) => n.id === r.id)!;
    expect(r.id).not.toBe('nome');
    expect(copy.position).toEqual({ x: 360 + 48, y: 48 });
    expect(r.flow.edges.filter((e) => e.target === r.id)).toEqual([]);
    expect(r.flow.edges.filter((e) => e.source === r.id).map((e) => e.target)).toEqual(['fim']);
    expect(duplicateNode(f, 'opening').flow).toBe(f);
  });

  test('shapeIssues aponta botão longo, telefone e campo inválidos', () => {
    let f = emptyFlow(TEXTS);
    const m = createNode('message', { x: 0, y: 0 }, f, TEXTS, null);
    const l = createNode('link', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, m, l] };
    f = updateNodeData(f, m.id, { options: [{ id: 'o1', title: 'x'.repeat(21) }], saveTo: 'Plano' });
    expect(shapeIssues(f)).toEqual([
      { nodeId: m.id, key: 'optionTitleInvalid' },
      { nodeId: m.id, key: 'fieldInvalid' },
      { nodeId: l.id, key: 'phoneInvalid' },
    ]);
  });
});
