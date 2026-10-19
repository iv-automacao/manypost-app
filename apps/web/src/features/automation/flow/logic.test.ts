import { describe, expect, test } from 'bun:test';
import { LIMITS } from '../logic';
import { readdirSync, readFileSync } from 'node:fs';
import {
  CommentTriggerConfigSchema,
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
  PUBLIC_REPLY_TEMPLATES,
  addOption,
  connect,
  createNode,
  duplicateNode,
  defaultTrigger,
  emptyFlow,
  normalizeFlow,
  removeNode,
  removeOption,
  shapeIssues,
  triggerIssues,
  simulateFlow,
  updateNodeData,
  validateFlow,
  withReplyTemplates,
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
    for (const kind of ['message', 'question', 'condition', 'link', 'follow', 'end', 'action'] as const) {
      let n = createNode(kind, { x: 10, y: 20 }, f, TEXTS, 'sua.conta');
      if (n.type === 'link' && n.data.target.kind === 'whatsapp') {
        n = { ...n, data: { ...n.data, target: { kind: 'whatsapp', phone: '5592999990000', message: '' } } };
      }
      if (n.type === 'condition') n = { ...n, data: { ...n.data, field: 'nome' } };
      // a ação nasce sem rótulo (o Salvar trava até preencher)
      if (n.type === 'action') n = { ...n, data: { kind: 'send_data', label: 'dados' } };
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

describe('shapeIssues cobre o que a API recusa', () => {
  test('título da abertura vale em qualquer modo', () => {
    let f = emptyFlow(TEXTS);
    f = updateNodeData(f, 'opening', { buttonTitle: '  ' });
    expect(shapeIssues(f)).toEqual([{ nodeId: 'opening', key: 'buttonTitleInvalid' }]);
  });

  test('mensagem do WhatsApp longa e url inválida', () => {
    let f = emptyFlow(TEXTS);
    const l = createNode('link', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, l] };
    const wa = (message: string) =>
      updateNodeData(f, l.id, { target: { kind: 'whatsapp', phone: '5592999990000', message } });
    expect(shapeIssues(wa('x'.repeat(500)))).toEqual([]);
    expect(shapeIssues(wa('x'.repeat(501)))).toEqual([{ nodeId: l.id, key: 'waMessageTooLong' }]);
    const url = (u: string) => shapeIssues(updateNodeData(f, l.id, { target: { kind: 'url', url: u } }));
    expect(url('https://:')).toEqual([{ nodeId: l.id, key: 'urlInvalid' }]);
    expect(url(`https://a.com/${'x'.repeat(1990)}`)).toEqual([{ nodeId: l.id, key: 'urlInvalid' }]);
    expect(url('http://a.com')).toEqual([{ nodeId: l.id, key: 'urlInvalid' }]);
    expect(url('https://a.com/ok')).toEqual([]);
  });

  test('saveTo vazio é removido do nó', () => {
    let f = emptyFlow(TEXTS);
    const m = createNode('message', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, m] };
    f = updateNodeData(f, m.id, { saveTo: 'plano' });
    expect(f.nodes.find((n) => n.id === m.id)!.data).toHaveProperty('saveTo', 'plano');
    f = updateNodeData(f, m.id, { saveTo: '' });
    expect(f.nodes.find((n) => n.id === m.id)!.data).not.toHaveProperty('saveTo');
    expect(shapeIssues(f)).toEqual([]);
  });

  test('palavra-chave vazia é apontada', () => {
    expect(triggerIssues({ mediaIds: [], keywords: ['quero', '  '], publicReplies: [] })).toEqual(['triggerKeywords']);
    expect(triggerIssues({ mediaIds: [], keywords: ['quero'], publicReplies: [] })).toEqual([]);
  });
});

describe('modelos de resposta pública', () => {
  test('todos cabem no limite e passam no schema do gatilho', () => {
    for (const t of PUBLIC_REPLY_TEMPLATES) expect(t.length).toBeLessThanOrEqual(LIMITS.publicReply);
    const r = CommentTriggerConfigSchema.safeParse({ mediaIds: [], keywords: [], publicReplies: [...PUBLIC_REPLY_TEMPLATES] });
    expect(r.success).toBe(true);
  });
  test('lista vazia recebe os 6 modelos', () => {
    expect(withReplyTemplates([])).toHaveLength(6);
  });
  test('deduplica ignorando caixa e espaços, mantendo os existentes primeiro', () => {
    const out = withReplyTemplates(['minha', `  ${PUBLIC_REPLY_TEMPLATES[0]!.toUpperCase()}  `]);
    expect(out[0]).toBe('minha');
    expect(out).toHaveLength(7);
  });
  test('limita a 10 itens', () => {
    const cur = Array.from({ length: 8 }, (_, i) => `resposta ${i}`);
    const out = withReplyTemplates(cur);
    expect(out).toHaveLength(LIMITS.maxPublicReplies);
    expect(out.slice(0, 8)).toEqual(cur);
  });
  test('gatilho padrão traz 3 respostas', () => {
    expect(defaultTrigger().publicReplies).toEqual(PUBLIC_REPLY_TEMPLATES.slice(0, 3));
  });
});

describe('telefone do WhatsApp com +55', () => {
  test('exibe sem o 55 e grava com o 55, digitando aos poucos', async () => {
    const { brPhoneDisplay, brPhoneStore } = await import('./logic');
    let stored = '';
    let text = '';
    for (const ch of '92981718317') {
      text = (text + ch).replace(/\D/g, '');
      stored = brPhoneStore(text);
    }
    expect(stored).toBe('5592981718317');
    expect(brPhoneDisplay(stored)).toBe('92981718317');
    expect(brPhoneDisplay('92981718317')).toBe('92981718317');
    expect(brPhoneStore('')).toBe('');
    expect(brPhoneStore('(92) 98171-8317')).toBe('5592981718317');
  });
});

describe('abertura em resposta rápida', () => {
  const quickFlow = () => {
    const f = emptyFlow(TEXTS);
    const opening = f.nodes.find((n) => n.type === 'opening')!;
    return updateNodeData(f, opening.id, { mode: 'quick', buttonTitle: 'Quero ver as opções' });
  };

  test('passa no schema, sem aviso, e o simulador mostra a sugestão com a dica', async () => {
    const { startSim } = await import('./logic');
    const f = quickFlow();
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(validateFlow(f)).toEqual([]);
    const e0 = startSim(f).transcript[0]!;
    const first = e0.from === 'typing' ? ({} as never) : e0.msg;
    expect(first.quick).toEqual(['Quero ver as opções']);
    expect(first.buttons).toBeUndefined();
    expect(first.text).toContain('Responda esta mensagem para continuar.');
  });

  test('tocar na sugestão avança e aparece na conversa com o título', async () => {
    const { startSim, sendSim, tapForTitle } = await import('./logic');
    const f = quickFlow();
    const s0 = startSim(f);
    const tap = tapForTitle(f, s0.nodeId, 'Quero ver as opções');
    expect(tap).toBe('next');
    const s1 = sendSim(s0, { tap: tap! });
    expect(s1.nodeId).not.toBe(s0.nodeId);
    const user = s1.transcript.find((x) => x.from === 'user');
    expect(user && user.from === 'user' ? user.msg.text : null).toBe('Quero ver as opções');
  });
});

describe('atraso e lembrete (add-flow-delay-reminder)', () => {
  const RAW = {
    version: 2,
    reminder: { afterMinutes: 60, text: '{tipo}, ficou faltando pouco.' },
    nodes: [
      { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: 'Oi!' } },
      { id: 'tipo', type: 'message', position: { x: 0, y: 0 }, data: { text: 'Para quem?', format: 'quick', options: [{ id: 'pf', title: 'Pra mim' }], saveTo: 'tipo', delaySec: 2 } },
      { id: 'cidade', type: 'message', position: { x: 0, y: 0 }, data: { text: 'Em qual cidade?', format: 'quick', options: [{ id: 'mao', title: 'Manaus' }], saveTo: 'cidade' } },
      { id: 'seguir', type: 'link', position: { x: 0, y: 0 }, data: { text: 'Segue a gente', buttonTitle: 'Seguir', target: { kind: 'url', url: 'https://x.com' }, delaySec: 5 } },
      { id: 'fim', type: 'end', position: { x: 0, y: 0 }, data: { text: 'Valeu!' } },
    ],
    edges: [
      { id: 'a', source: 'opening', sourceHandle: 'next', target: 'tipo' },
      { id: 'b', source: 'tipo', sourceHandle: 'pf', target: 'cidade' },
      { id: 'c', source: 'cidade', sourceHandle: 'mao', target: 'seguir' },
      { id: 'd', source: 'seguir', sourceHandle: 'next', target: 'fim' },
    ],
  };

  test('normalizar preserva delaySec e lembrete (salvar pelo editor não apaga)', () => {
    const f = normalizeFlow(RAW);
    expect(f.reminder).toEqual({ afterMinutes: 60, text: '{tipo}, ficou faltando pouco.' });
    expect(f.nodes.find((n) => n.id === 'seguir')!.data).toMatchObject({ delaySec: 5 });
    expect(f.nodes.find((n) => n.id === 'cidade')!.data).not.toHaveProperty('delaySec');
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(shapeIssues(f)).toEqual([]);
    const sem = normalizeFlow({ ...RAW, reminder: undefined });
    expect(sem).not.toHaveProperty('reminder');
  });

  test('shapeIssues aponta atraso e lembrete fora do limite', () => {
    const f = normalizeFlow(RAW);
    const atraso = updateNodeData(f, 'seguir', { delaySec: 61 });
    expect(shapeIssues(atraso)).toEqual([{ nodeId: 'seguir', key: 'delayInvalid' }]);
    expect(shapeIssues({ ...f, reminder: { afterMinutes: 4, text: 'x' } })).toEqual([{ nodeId: null, key: 'reminderInvalid' }]);
    expect(shapeIssues({ ...f, reminder: { afterMinutes: 60, text: ' ' } })).toEqual([{ nodeId: null, key: 'reminderInvalid' }]);
    expect(shapeIssues({ ...f, reminder: { afterMinutes: 60, text: 'x'.repeat(301) } })).toEqual([{ nodeId: null, key: 'reminderInvalid' }]);
  });

  test('simulador mostra "digitando" antes do balão com atraso', async () => {
    const { startSim, sendSim } = await import('./logic');
    const s1 = sendSim(startSim(normalizeFlow(RAW)), { text: 'oi' });
    const tail = s1.transcript.slice(-2);
    expect(tail[0]).toEqual({ from: 'typing', seconds: 2 });
    expect(tail[1]).toMatchObject({ from: 'brand', msg: { text: 'Para quem?' } });
  });

  test('simular silêncio mostra o lembrete com a pergunta e as opções, uma vez só', async () => {
    const { startSim, sendSim, simulateSilence, canSimulateSilence } = await import('./logic');
    let s = startSim(normalizeFlow(RAW));
    expect(canSimulateSilence(s)).toBe(false); // ainda na abertura
    s = sendSim(s, { text: 'oi' });
    s = sendSim(s, { tap: 'pf' });
    expect(canSimulateSilence(s)).toBe(true);
    s = simulateSilence(s);
    expect(s.transcript.slice(-2)).toEqual([
      { from: 'brand', msg: { text: 'Pra mim, ficou faltando pouco.' } },
      { from: 'brand', msg: { text: 'Em qual cidade?', quick: ['Manaus'] } },
    ]);
    expect(canSimulateSilence(s)).toBe(false);
    s = sendSim(s, { tap: 'mao' });
    expect(s.status).toBe('completed');
    expect(s.transcript.slice(-3).map((x) => (x.from === 'typing' ? `⏱${x.seconds}` : x.msg.text))).toEqual(['⏱5', 'Segue a gente', 'Valeu!']);
  });

  test('sem lembrete configurado não há silêncio para simular', async () => {
    const { startSim, sendSim, canSimulateSilence } = await import('./logic');
    let s = startSim(normalizeFlow({ ...RAW, reminder: undefined }));
    s = sendSim(s, { text: 'oi' });
    expect(canSimulateSilence(s)).toBe(false);
  });
});

describe('balão de ação', () => {
  test('nasce como enviar dados sem rótulo e trava o Salvar até preencher', () => {
    const f = emptyFlow(TEXTS);
    const n = createNode('action', { x: 0, y: 0 }, f, TEXTS, null);
    expect(n).toMatchObject({ type: 'action', data: { kind: 'send_data', label: '' } });
    expect(shapeIssues({ ...f, nodes: [...f.nodes, n] })).toEqual([{ nodeId: n.id, key: 'labelInvalid' }]);
  });

  test('formato: rótulo de campo, aviso de 1 a 280', () => {
    const base = emptyFlow(TEXTS);
    const com = (data: unknown) => ({ ...base, nodes: [...base.nodes, { id: 'a', type: 'action', position: { x: 0, y: 0 }, data } as never] });
    expect(shapeIssues(com({ kind: 'send_data', label: 'WhatsApp' }))).toEqual([{ nodeId: 'a', key: 'labelInvalid' }]);
    expect(shapeIssues(com({ kind: 'send_data', label: 'whatsapp_coletado' }))).toEqual([]);
    expect(shapeIssues(com({ kind: 'notify', text: ' ' }))).toEqual([{ nodeId: 'a', key: 'textRequired' }]);
    expect(shapeIssues(com({ kind: 'notify', text: 'x'.repeat(281) }))).toEqual([{ nodeId: 'a', key: 'notifyTooLong' }]);
  });

  test('normalizeFlow limpa o campo do outro tipo', () => {
    const f = normalizeFlow({
      nodes: [
        { id: 'a', type: 'action', position: { x: 0, y: 0 }, data: { kind: 'notify', text: 'Oi', label: 'velho' } },
        { id: 'b', type: 'action', position: { x: 0, y: 0 }, data: { kind: 'send_data', label: 'x', text: 'velho', delaySec: 5 } },
      ],
    });
    expect(f.nodes[0]!.data).toEqual({ kind: 'notify', text: 'Oi' });
    expect(f.nodes[1]!.data).toEqual({ kind: 'send_data', label: 'x' });
  });

  test('trocar o tipo pelo patch do editor não deixa dado velho', () => {
    let f = emptyFlow(TEXTS);
    const n = createNode('action', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, n] };
    f = updateNodeData(f, n.id, { kind: 'notify', text: 'Oi', label: undefined });
    expect(normalizeFlow(f).nodes.find((x) => x.id === n.id)!.data).toEqual({ kind: 'notify', text: 'Oi' });
    expect(FlowV2Schema.safeParse(normalizeFlow(f)).success).toBe(true);
  });
});
