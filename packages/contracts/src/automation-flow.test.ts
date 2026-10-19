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

describe('atraso e lembrete', () => {
  const q = (delaySec?: unknown) => ({
    id: 'q',
    type: 'question',
    position: { x: 0, y: 100 },
    data: { text: 'Nome?', field: 'nome', validate: 'name', ...(delaySec === undefined ? {} : { delaySec }) },
  });
  const base = (extra: Record<string, unknown> = {}, node: unknown = q()) => ({
    ...flow([opening, node, end], [edge('opening', 'next', 'q'), edge('q', 'next', 'fim')]),
    ...extra,
  });

  test('delaySec de 0 a 60 inteiro nos balões que enviam; fora disso é recusado', () => {
    expect(FlowV2Schema.safeParse(base({}, q(0))).success).toBe(true);
    expect(FlowV2Schema.safeParse(base({}, q(60))).success).toBe(true);
    expect(FlowV2Schema.safeParse(base({}, q(61))).success).toBe(false);
    expect(FlowV2Schema.safeParse(base({}, q(-1))).success).toBe(false);
    expect(FlowV2Schema.safeParse(base({}, q(2.5))).success).toBe(false);
    const delayed = (type: string, data: Record<string, unknown>) =>
      FlowV2Schema.safeParse(flow([opening, { id: 'x', type, position: { x: 0, y: 0 }, data: { ...data, delaySec: 5 } }], [edge('opening', 'next', 'x')]));
    expect(delayed('message', { text: 'Oi', format: 'none' }).success).toBe(true);
    expect(delayed('link', { text: 'Toque', target: { kind: 'url', url: 'https://x.com' } }).success).toBe(true);
    expect(delayed('end', { text: 'Tchau' }).success).toBe(true);
  });

  test('sem delaySec continua válido (fluxos já salvos)', () => {
    const r = FlowV2Schema.parse(base());
    expect(r.nodes[1]).not.toHaveProperty('data.delaySec');
  });

  test('a abertura não tem atraso', () => {
    const r = FlowV2Schema.parse(base({}, q()));
    const o = FlowV2Schema.parse(flow([{ ...opening, data: { text: 'Oi', delaySec: 5 } }, end], [edge('opening', 'next', 'fim')]));
    expect(r.nodes[0]).not.toHaveProperty('data.delaySec');
    expect(o.nodes[0]).not.toHaveProperty('data.delaySec');
  });

  test('lembrete: 5 a 1380 minutos e texto de 1 a 300; ausente é aceito', () => {
    const ok = (reminder: unknown) => FlowV2Schema.safeParse(base({ reminder })).success;
    expect(FlowV2Schema.safeParse(base()).success).toBe(true);
    expect(ok({ afterMinutes: 5, text: 'Oi, {nome}?' })).toBe(true);
    expect(ok({ afterMinutes: 1380, text: 'Oi' })).toBe(true);
    expect(ok({ afterMinutes: 4, text: 'Oi' })).toBe(false);
    expect(ok({ afterMinutes: 1381, text: 'Oi' })).toBe(false);
    expect(ok({ afterMinutes: 60, text: '' })).toBe(false);
    expect(ok({ afterMinutes: 60, text: 'x'.repeat(301) })).toBe(false);
  });
});

describe('balão de ação', () => {
  const acao = (data: unknown, extra: Record<string, unknown> = {}) => ({ id: 'acao', type: 'action', position: { x: 0, y: 100 }, data, ...extra });
  const comAcao = (data: unknown) => flow([opening, acao(data), end], [edge('opening', 'next', 'acao'), edge('acao', 'next', 'fim')]);

  test('enviar dados: rótulo no formato de campo', () => {
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: 'whatsapp_coletado' })).success).toBe(true);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: 'WhatsApp coletado' })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: '' })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: `a${'b'.repeat(32)}` })).success).toBe(false);
  });

  test('avisar a equipe: texto de 1 a 280 caracteres', () => {
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: 'Lead novo: {nome}' })).success).toBe(true);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: '   ' })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: 'x'.repeat(281) })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: 'x'.repeat(280) })).success).toBe(true);
  });

  test('tipo de ação desconhecido é recusado', () => {
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'tag', label: 'x' })).success).toBe(false);
  });

  test('a ação não tem atraso: delaySec é descartado', () => {
    const r = FlowV2Schema.parse(comAcao({ kind: 'send_data', label: 'x', delaySec: 5 }));
    expect(r.nodes[1]).not.toHaveProperty('data.delaySec');
  });

  test('saída única next', () => {
    const outra = flow([opening, acao({ kind: 'send_data', label: 'x' }), end], [edge('opening', 'next', 'acao'), edge('acao', 'yes', 'fim')]);
    expect(issues(outra)).toContain('saída inexistente no nó de origem');
  });
});
