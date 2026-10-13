import { describe, expect, test } from 'bun:test';
import { FlowV2Schema, type FlowV2Input } from '@manypost/contracts';
import { outputsOf, waits } from './flow-graph';
import { hasErrors, validateFlow } from './flow-validate';

const P = { x: 0, y: 0 };
const parse = (f: Omit<FlowV2Input, 'version'>) => FlowV2Schema.parse({ version: 2, ...f });
const e = (source: string, sourceHandle: string, target: string) => ({
  id: `e-${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});
const opening = { id: 'opening', type: 'opening' as const, position: P, data: { text: 'Oi' } };
const end = { id: 'fim', type: 'end' as const, position: P, data: {} };
const codes = (f: Parameters<typeof validateFlow>[0]) =>
  validateFlow(f).map((p) => `${p.severity}:${p.code}:${p.nodeId ?? ''}:${p.handle ?? ''}`).sort();

describe('flow-graph', () => {
  test('saídas e espera por tipo', () => {
    const f = parse({
      nodes: [
        opening,
        { id: 'm', type: 'message', position: P, data: { text: 'Qual?', options: [{ id: 'a', title: 'A' }] } },
        { id: 'n', type: 'message', position: P, data: { text: 'Info', format: 'none' } },
        { id: 'b', type: 'message', position: P, data: { text: 'X', options: [{ id: 'a', title: 'A' }], onTyped: 'branch' } },
      ],
    });
    expect(outputsOf(f.nodes[1]!)).toEqual([
      { handle: 'a', required: true },
      { handle: 'typed', required: false },
    ]);
    expect(outputsOf(f.nodes[3]!).find((o) => o.handle === 'typed')?.required).toBe(true);
    expect(waits(f.nodes[0]!)).toBe(true);
    expect(waits(f.nodes[1]!)).toBe(true);
    expect(waits(f.nodes[2]!)).toBe(false);
  });
});

describe('validateFlow', () => {
  test('fluxo mínimo válido não tem problemas', () => {
    expect(validateFlow(parse({ nodes: [opening, end], edges: [e('opening', 'next', 'fim')] }))).toEqual([]);
  });

  test('nó solto, saída obrigatória sem ligação e sem fim', () => {
    const f = parse({
      nodes: [
        opening,
        { id: 'q', type: 'question', position: P, data: { text: 'Nome?', field: 'nome', validate: 'name' } },
        { ...end, id: 'solto' },
      ],
      edges: [e('opening', 'next', 'q')],
    });
    expect(codes(f)).toEqual([
      'error:missing_edge:q:next',
      'error:no_finish::',
      'error:unreachable:solto:',
    ]);
    expect(hasErrors(validateFlow(f))).toBe(true);
  });

  test('laço só com nós que não esperam é erro; laço passando por pergunta é permitido', () => {
    const info = { id: 'i', type: 'message' as const, position: P, data: { text: 'Info', format: 'none' as const } };
    const cond = { id: 'c', type: 'condition' as const, position: P, data: { field: 'nome', op: 'filled' as const } };
    const q = { id: 'q', type: 'question' as const, position: P, data: { text: 'Nome?', field: 'nome', validate: 'name' as const } };
    const ruim = parse({
      nodes: [opening, q, info, cond, end],
      edges: [e('opening', 'next', 'q'), e('q', 'next', 'i'), e('i', 'next', 'c'), e('c', 'yes', 'fim'), e('c', 'no', 'i')],
    });
    expect(codes(ruim)).toEqual(['error:wait_free_cycle:i:']);
    const bom = parse({
      nodes: [opening, q, cond, end],
      edges: [e('opening', 'next', 'q'), e('q', 'next', 'c'), e('c', 'yes', 'fim'), e('c', 'no', 'q')],
    });
    expect(validateFlow(bom)).toEqual([]);
  });

  test('condição sobre campo que ninguém grava', () => {
    const f = parse({
      nodes: [opening, { id: 'c', type: 'condition', position: P, data: { field: 'plano', op: 'filled' } }, end],
      edges: [e('opening', 'next', 'c'), e('c', 'yes', 'fim'), e('c', 'no', 'fim')],
    });
    expect(codes(f)).toEqual(['error:unknown_field:c:']);
  });

  test('abertura com botão é só aviso', () => {
    const f = parse({
      nodes: [{ ...opening, data: { text: 'Oi', mode: 'button' } }, end],
      edges: [e('opening', 'next', 'fim')],
    });
    expect(codes(f)).toEqual(['warning:opening_button:opening:']);
    expect(hasErrors(validateFlow(f))).toBe(false);
  });

  test('abertura em resposta rápida não gera aviso', () => {
    const f = parse({
      nodes: [{ ...opening, data: { text: 'Oi', mode: 'quick', buttonTitle: 'Quero ver' } }, end],
      edges: [e('opening', 'next', 'fim')],
    });
    expect(codes(f)).toEqual([]);
  });

  test('link sem saída conta como fim', () => {
    const f = parse({
      nodes: [
        opening,
        {
          id: 'l',
          type: 'link',
          position: P,
          data: { text: 'Fale', target: { kind: 'whatsapp', phone: '5592999990000' } },
        },
      ],
      edges: [e('opening', 'next', 'l')],
    });
    expect(validateFlow(f)).toEqual([]);
  });
});
