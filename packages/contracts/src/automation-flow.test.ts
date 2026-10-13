import { describe, expect, test } from 'bun:test';
import { AnyAutomationConfigSchema, FlowV2Schema } from './automation-flow';

const opening = { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: 'Oi!' } };
const end = { id: 'fim', type: 'end', position: { x: 0, y: 200 }, data: {} };
const flow = (nodes: unknown[], edges: unknown[] = []) => ({ version: 2, nodes, edges });
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `e-${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});
const issues = (v: unknown) => {
  const r = FlowV2Schema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('FlowV2Schema', () => {
  test('aceita o fluxo mínimo e aplica os padrões', () => {
    const r = FlowV2Schema.parse(flow([opening, end], [edge('opening', 'next', 'fim')]));
    expect(r.nodes[0]).toMatchObject({ data: { mode: 'text', buttonTitle: 'Quero!', disclosure: true } });
    expect(r.nodes[1]).toMatchObject({ data: { text: '' } });
  });

  test('exige exatamente uma abertura', () => {
    expect(issues(flow([end]))).toContain('o fluxo precisa de exatamente uma abertura');
    expect(issues(flow([opening, { ...opening, id: 'outra' }]))).toContain('o fluxo precisa de exatamente uma abertura');
  });

  test('ids de nó repetidos e fora do padrão', () => {
    expect(issues(flow([opening, { ...end, id: 'opening' }]))).toContain('id de nó repetido');
    expect(FlowV2Schema.safeParse(flow([opening, { ...end, id: 'Fim!' }])).success).toBe(false);
  });

  test('mensagem: 4 botões, 14 respostas rápidas, título longo e id reservado são recusados', () => {
    const msg = (format: string, n: number, title = 'Opção') => ({
      id: 'm',
      type: 'message',
      position: { x: 0, y: 0 },
      data: { text: 'Qual?', format, options: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, title })) },
    });
    expect(FlowV2Schema.safeParse(flow([opening, msg('buttons', 3)])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, msg('buttons', 4)])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, msg('quick', 13)])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, msg('quick', 14)])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, msg('none', 1)])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, msg('buttons', 1, 'x'.repeat(21))])).success).toBe(false);
    const reserved = msg('buttons', 1);
    (reserved.data.options[0] as { id: string }).id = 'typed';
    expect(FlowV2Schema.safeParse(flow([opening, reserved])).success).toBe(false);
  });

  test('ligações: nó inexistente, entrada na abertura, saída inválida e saída duplicada', () => {
    expect(issues(flow([opening, end], [edge('opening', 'next', 'nada')]))).toContain('ligação para nó inexistente');
    expect(issues(flow([opening, end], [edge('fim', 'next', 'opening')]))).toContain('nada pode ligar na abertura');
    expect(issues(flow([opening, end], [edge('opening', 'yes', 'fim')]))).toContain('saída inexistente no nó de origem');
    expect(
      issues(flow([opening, end, { ...end, id: 'fim2' }], [edge('opening', 'next', 'fim'), { ...edge('opening', 'next', 'fim2'), id: 'x' }])),
    ).toContain('esta saída já tem uma ligação');
  });

  test('link só aceita https e condição igual/contém exige valor', () => {
    const link = (url: string) => ({
      id: 'l',
      type: 'link',
      position: { x: 0, y: 0 },
      data: { text: 'Veja', buttonTitle: 'Abrir', target: { kind: 'url', url } },
    });
    expect(FlowV2Schema.safeParse(flow([opening, link('https://instagram.com/x')])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, link('http://instagram.com/x')])).success).toBe(false);
    const cond = (op: string, value?: string) => ({
      id: 'c',
      type: 'condition',
      position: { x: 0, y: 0 },
      data: { field: 'plano', op, ...(value === undefined ? {} : { value }) },
    });
    expect(FlowV2Schema.safeParse(flow([opening, cond('equals')])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, cond('equals', 'Vida')])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, cond('filled')])).success).toBe(true);
  });

  test('limite de 40 nós', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...end, id: `n${i}` }));
    expect(FlowV2Schema.safeParse(flow([opening, ...many])).success).toBe(false);
  });
});

describe('AnyAutomationConfigSchema', () => {
  test('lê v1 e v2', () => {
    const v1 = AnyAutomationConfigSchema.parse({ trigger: {}, opening: { text: 'Oi' }, finish: { text: 'Fim' } });
    expect(v1.version).toBe(1);
    const v2 = AnyAutomationConfigSchema.parse(flow([opening, end], [edge('opening', 'next', 'fim')]));
    expect(v2.version).toBe(2);
  });
});
