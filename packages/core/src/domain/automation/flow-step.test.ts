import { describe, expect, test } from 'bun:test';
import { FlowV2Schema, type FlowNode, type FlowV2Input } from '@manypost/contracts';
import { outputsOf, waits } from './flow-graph';
import {
  actionFor,
  autoNext,
  conditionHolds,
  delayOf,
  decideInput,
  decodePayloadV2,
  encodePayloadV2,
  leadWhatsappUrl,
  messageFor,
} from './flow-step';

const P = { x: 0, y: 0 };
const parse = (f: Omit<FlowV2Input, 'version'>) => FlowV2Schema.parse({ version: 2, ...f });
const e = (source: string, sourceHandle: string, target: string) => ({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });
const ctx = { runId: 'run-1', answers: { nome: 'Ana' }, username: 'ana.x' };

const FLOW = parse({
  nodes: [
    { id: 'opening', type: 'opening', position: P, data: { text: 'Oi {username}' } },
    {
      id: 'plano',
      type: 'message',
      position: P,
      data: { text: 'Qual plano, {nome}?', options: [{ id: 'pf', title: 'Pessoa física' }, { id: 'pj', title: 'Minha empresa' }], saveTo: 'plano' },
    },
    { id: 'zap', type: 'question', position: P, data: { text: 'WhatsApp?', field: 'zap', validate: 'phone' } },
    { id: 'cond', type: 'condition', position: P, data: { field: 'plano', op: 'equals', value: 'minha empresa' } },
    { id: 'wa', type: 'link', position: P, data: { text: 'Fale', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: 'Sou {nome} ({plano})' } } },
    { id: 'fim', type: 'end', position: P, data: { text: '' } },
  ],
  edges: [
    e('opening', 'next', 'plano'),
    e('plano', 'pf', 'zap'),
    e('plano', 'pj', 'zap'),
    e('zap', 'next', 'cond'),
    e('cond', 'yes', 'wa'),
    e('cond', 'no', 'fim'),
  ],
});
const node = (id: string) => FLOW.nodes.find((n) => n.id === id) as FlowNode;

describe('payload v2', () => {
  test('ida e volta; formatos inválidos e mp1 não decodificam', () => {
    const p = encodePayloadV2('0198a1b2-0000-7000-8000-000000000001', 'plano', 'pj');
    expect(decodePayloadV2(p)).toEqual({ runId: '0198a1b2-0000-7000-8000-000000000001', nodeId: 'plano', handle: 'pj' });
    expect(decodePayloadV2('mp1:abc:0:1')).toBeNull();
    expect(decodePayloadV2('mp2:abc:Plano!:x')).toBeNull();
    expect(decodePayloadV2(null)).toBeNull();
  });
});

describe('messageFor', () => {
  test('abertura em texto leva a dica e o aviso; em botão leva o payload', () => {
    expect(messageFor(node('opening'), ctx)).toEqual({
      text: 'Oi ana.x\n\nResponda esta mensagem para continuar.\n\nMensagem automática.',
    });
    const button = { ...node('opening'), data: { text: 'Oi', mode: 'button', buttonTitle: 'Quero!', disclosure: false } } as FlowNode;
    expect(messageFor(button, ctx)).toEqual({ text: 'Oi', buttons: [{ title: 'Quero!', payload: 'mp2:run-1:opening:next' }] });
  });

  test('abertura em resposta rápida leva a dica e uma sugestão com o payload de next, sem botões', () => {
    const quick = { ...node('opening'), data: { text: 'Oi', mode: 'quick', buttonTitle: 'Quero ver as opções', disclosure: false } } as FlowNode;
    expect(messageFor(quick, ctx)).toEqual({
      text: 'Oi\n\nResponda esta mensagem para continuar.',
      quickReplies: [{ title: 'Quero ver as opções', payload: 'mp2:run-1:opening:next' }],
    });
    // quem está em Solicitações não vê a sugestão e digita: segue igual
    expect(decideInput(FLOW, quick, { handle: null, text: 'oi' }, 0)).toEqual({ kind: 'advance', handle: 'next' });
  });

  test('mensagem com botões renderiza campos; quick vira quickReplies; none só texto', () => {
    expect(messageFor(node('plano'), ctx)).toEqual({
      text: 'Qual plano, Ana?',
      buttons: [
        { title: 'Pessoa física', payload: 'mp2:run-1:plano:pf' },
        { title: 'Minha empresa', payload: 'mp2:run-1:plano:pj' },
      ],
    });
    const quick = { ...node('plano'), data: { ...(node('plano') as { data: object }).data, format: 'quick' } } as FlowNode;
    expect(messageFor(quick, ctx)?.quickReplies?.[1]).toEqual({ title: 'Minha empresa', payload: 'mp2:run-1:plano:pj' });
  });

  test('campo ausente vira vazio, nunca chaves cruas', () => {
    expect(messageFor(node('plano'), { ...ctx, answers: {} })?.text).toBe('Qual plano, ?');
  });

  test('link de WhatsApp com mensagem preenchida; condição e fim vazio não enviam', () => {
    expect(messageFor(node('wa'), { ...ctx, answers: { nome: 'Ana', plano: 'Minha empresa' } })).toEqual({
      text: 'Fale',
      buttons: [{ title: 'WhatsApp', url: `https://wa.me/5592999990000?text=${encodeURIComponent('Sou Ana (Minha empresa)')}` }],
    });
    expect(messageFor(node('cond'), ctx)).toBeNull();
    expect(messageFor(node('fim'), ctx)).toBeNull();
  });
});

describe('condição e saída automática', () => {
  test('condição normaliza caixa e acento', () => {
    const c = node('cond') as Extract<FlowNode, { type: 'condition' }>;
    expect(conditionHolds(c, { plano: 'Minha Empresa' })).toBe(true);
    expect(conditionHolds(c, { plano: 'MINHA EMPRESA ' })).toBe(true);
    expect(conditionHolds(c, { plano: 'Pessoa física' })).toBe(false);
    const has = { ...c, data: { field: 'plano', op: 'contains', value: 'saude' } } as typeof c;
    expect(conditionHolds(has, { plano: 'Plano Saúde' })).toBe(true);
    expect(conditionHolds({ ...c, data: { field: 'x', op: 'filled', value: '' } } as typeof c, { x: '  ' })).toBe(false);
    expect(conditionHolds({ ...c, data: { field: 'x', op: 'empty', value: '' } } as typeof c, {})).toBe(true);
  });

  test('autoNext: condição, link com e sem saída, fim', () => {
    expect(autoNext(FLOW, node('cond'), { plano: 'Minha empresa' })).toEqual({ kind: 'goto', to: 'wa' });
    expect(autoNext(FLOW, node('cond'), { plano: 'Pessoa física' })).toEqual({ kind: 'goto', to: 'fim' });
    expect(autoNext(FLOW, node('wa'), {})).toEqual({ kind: 'finish' });
    expect(autoNext(FLOW, node('fim'), {})).toEqual({ kind: 'finish' });
  });

  test('leadWhatsappUrl usa o primeiro link de WhatsApp', () => {
    expect(leadWhatsappUrl(FLOW, ctx)).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Sou Ana ()')}`);
  });
});

describe('decideInput', () => {
  const plano = node('plano');
  test('toque ou texto igual ao título avançam e gravam o título', () => {
    expect(decideInput(FLOW, plano, { handle: 'pj', text: '' }, 0)).toEqual({ kind: 'advance', handle: 'pj', save: { field: 'plano', value: 'Minha empresa' } });
    expect(decideInput(FLOW, plano, { handle: null, text: 'pessoa FISICA' }, 0)).toEqual({ kind: 'advance', handle: 'pf', save: { field: 'plano', value: 'Pessoa física' } });
  });

  test('texto fora das opções: re-pergunta uma vez e depois segue pela primeira opção com o texto cru', () => {
    expect(decideInput(FLOW, plano, { handle: null, text: 'sei lá' }, 0)).toEqual({ kind: 'reask' });
    expect(decideInput(FLOW, plano, { handle: null, text: 'sei lá' }, 1)).toEqual({ kind: 'advance', handle: 'pf', save: { field: 'plano', value: 'sei lá' } });
  });

  test('modo branch sai por typed', () => {
    const f = parse({
      nodes: [
        { id: 'opening', type: 'opening', position: P, data: { text: 'Oi' } },
        { id: 'm', type: 'message', position: P, data: { text: 'X', options: [{ id: 'a', title: 'A' }], onTyped: 'branch' } },
        { id: 'fim', type: 'end', position: P, data: {} },
      ],
      edges: [e('opening', 'next', 'm'), e('m', 'a', 'fim'), e('m', 'typed', 'fim')],
    });
    expect(decideInput(f, f.nodes[1]!, { handle: null, text: 'outra coisa' }, 0)).toEqual({ kind: 'advance', handle: 'typed' });
  });

  test('pergunta valida, re-pergunta uma vez e aceita o cru', () => {
    const zap = node('zap');
    expect(decideInput(FLOW, zap, { handle: null, text: '(92) 98888-7777' }, 0)).toEqual({ kind: 'advance', handle: 'next', save: { field: 'zap', value: '92988887777' } });
    expect(decideInput(FLOW, zap, { handle: null, text: 'não sei' }, 0)).toEqual({ kind: 'reask' });
    expect(decideInput(FLOW, zap, { handle: null, text: 'não sei' }, 1)).toEqual({ kind: 'advance', handle: 'next', save: { field: 'zap', value: 'não sei' } });
  });

  test('entrada vazia é ignorada em pergunta e em mensagem; a abertura segue com qualquer coisa', () => {
    expect(decideInput(FLOW, node('zap'), { handle: null, text: '  ' }, 0)).toEqual({ kind: 'ignore' });
    expect(decideInput(FLOW, plano, { handle: null, text: '' }, 0)).toEqual({ kind: 'ignore' });
    expect(decideInput(FLOW, node('opening'), { handle: null, text: '' }, 0)).toEqual({ kind: 'advance', handle: 'next' });
  });
});

describe('balão de ação', () => {
  const fluxo = FlowV2Schema.parse({
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi' } },
      { id: 'dados', type: 'action', position: P, data: { kind: 'send_data', label: 'nome_coletado' } },
      { id: 'avisa', type: 'action', position: P, data: { kind: 'notify', text: 'Lead novo: {nome} (@{username})' } },
      { id: 'fim', type: 'end', position: P, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'opening', sourceHandle: 'next', target: 'dados' },
      { id: 'e2', source: 'dados', sourceHandle: 'next', target: 'avisa' },
    ],
  });
  const ctx = { runId: 'r', answers: { nome: 'Ana' }, username: 'ana.s' };
  const no = (id: string) => fluxo.nodes.find((n) => n.id === id)!;

  test('actionFor resolve o efeito com os campos preenchidos', () => {
    expect(actionFor(no('dados'), ctx)).toEqual({ kind: 'send_data', label: 'nome_coletado' });
    expect(actionFor(no('avisa'), ctx)).toEqual({ kind: 'notify', text: 'Lead novo: Ana (@ana.s)' });
    expect(actionFor(no('opening'), ctx)).toBeNull();
  });

  test('a ação não manda mensagem, não espera, não atrasa e segue por next', () => {
    expect(messageFor(no('dados'), ctx)).toBeNull();
    expect(waits(no('dados'))).toBe(false);
    expect(delayOf(no('dados'))).toBe(0);
    expect(autoNext(fluxo, no('dados'), ctx.answers)).toEqual({ kind: 'goto', to: 'avisa' });
    expect(autoNext(fluxo, no('avisa'), ctx.answers)).toEqual({ kind: 'dead_end', handle: 'next' });
    expect(outputsOf(no('dados'))).toEqual([{ handle: 'next', required: true }]);
  });
});
