import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  ContentFormats,
  ContentFoundationKeys,
  ContentMarkets,
  ContentPieceStatuses,
  ContentPromptNames,
} from '@manypost/contracts';
import { toLocalInput } from '@/lib/datetime';
import messages from '@/messages/pt-BR.json';
import {
  BOARD_COLUMNS,
  CAPTION_TOTAL_MAX,
  FORMATS,
  FOUNDATION_KEYS,
  MARKETS,
  PLAN_POLL_WINDOW_MS,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  PROMPT_NAMES,
  SECTIONS,
  SIDE_GROUPS,
  STATUSES,
  actionsFor,
  brandDraft,
  brandPatchFrom,
  ctaWordFrom,
  captionLock,
  captionPatch,
  captionValues,
  cleanPalette,
  clearSaved,
  coverOf,
  dropFields,
  editDraft,
  formatBrl,
  formatHashtags,
  formatUsd,
  groupByStatus,
  groupPrompts,
  invalidPaletteRoles,
  isExpired,
  isMonday,
  isPaletteEmpty,
  nextMonday,
  normalizeHex,
  parseHashtags,
  pollInterval,
  publishedText,
  readScript,
  rebaseFields,
  sameDraft,
  sectionFor,
  shiftMonth,
  shownValues,
  staleFields,
  topPieces,
  usdToBrl,
  type CaptionDrafts,
  needsPublicationCheck,
  isInstagramLink,
} from './logic';
import type { ContentBrand, ContentPiece, ContentPrompt, PieceStatus } from './types';

const maquina = messages.maquina as unknown as Record<string, Record<string, unknown>>;
/** Intl usa espaço não separável entre símbolo e valor */
const plain = (s: string) => s.replace(/\s/g, ' ');

const piece = (over: Partial<ContentPiece> = {}): ContentPiece => ({
  id: over.id ?? 'p1',
  status: over.status ?? 'ideia',
  format: over.format ?? 'carrossel',
  pillar: '',
  icp: '',
  market: '',
  awareness: '',
  hook: 'gancho',
  plan: {},
  script: over.script ?? null,
  caption: over.caption ?? '',
  hashtags: over.hashtags ?? [],
  keyword: 'PME-0928-A',
  media: over.media ?? [],
  review: over.review ?? null,
  feedback: [],
  attempts: 0,
  scheduledFor: over.scheduledFor ?? null,
  channelId: null,
  postGroupId: null,
  publishedAt: null,
  permalink: null,
  costUsd: 0,
  error: null,
  running: over.running ?? false,
  createdAt: '2026-09-27T12:00:00.000Z',
  updatedAt: '2026-09-27T12:00:00.000Z',
});

describe('vocabulário espelha o contrato', () => {
  test('status, formatos, chaves, prompts e mercados são os mesmos de @manypost/contracts', () => {
    expect([...STATUSES]).toEqual([...ContentPieceStatuses]);
    expect([...FORMATS]).toEqual([...ContentFormats]);
    expect([...FOUNDATION_KEYS]).toEqual([...ContentFoundationKeys]);
    expect([...PROMPT_NAMES]).toEqual([...ContentPromptNames]);
    expect([...MARKETS]).toEqual([...ContentMarkets]);
  });

  test('quadro + seção lateral cobrem cada status exatamente uma vez', () => {
    const todos = [...BOARD_COLUMNS, ...SIDE_GROUPS];
    expect(new Set(todos).size).toBe(todos.length);
    expect([...todos].sort()).toEqual([...STATUSES].sort());
  });

  test('todo status, formato, mercado, documento e prompt tem rótulo em pt-BR', () => {
    for (const s of STATUSES) expect(typeof maquina.status?.[s]).toBe('string');
    for (const f of FORMATS) expect(typeof maquina.format?.[f]).toBe('string');
    for (const m of MARKETS) expect(typeof maquina.market?.[m]).toBe('string');
    const keys = (maquina.foundation?.keys ?? {}) as Record<string, { title?: string }>;
    for (const k of FOUNDATION_KEYS) expect(typeof keys[k]?.title).toBe('string');
    const names = (maquina.prompts?.names ?? {}) as Record<string, { title?: string }>;
    for (const n of PROMPT_NAMES) expect(typeof names[n]?.title).toBe('string');
  });
});

describe('seções', () => {
  test('pathname escolhe a seção; a raiz e o desconhecido caem no quadro', () => {
    expect(sectionFor('/maquina')).toBe('board');
    expect(sectionFor('/maquina/')).toBe('board');
    expect(sectionFor('/maquina/identidade')).toBe('identity');
    expect(sectionFor('/maquina/gastos/')).toBe('spend');
    expect(sectionFor('/maquina/outra')).toBe('board');
  });

  test('toda seção tem rota de verdade e rótulo', async () => {
    const raiz = fileURLToPath(new URL('../../app/(app)/', import.meta.url));
    for (const s of SECTIONS) {
      const arquivo = Bun.file(`${raiz}${s.href.replace(/^\//, '')}/page.tsx`);
      expect(await arquivo.exists(), `sem rota para ${s.href}`).toBe(true);
      expect(typeof maquina.sections?.[s.key]).toBe('string');
    }
  });
});

describe('quadro', () => {
  test('agrupa por status e ordena agendado pela data de publicação', () => {
    const g = groupByStatus([
      piece({ id: 'a', status: 'agendado', scheduledFor: '2026-10-02T12:00:00.000Z' }),
      piece({ id: 'b', status: 'revisao' }),
      piece({ id: 'c', status: 'agendado', scheduledFor: '2026-09-30T12:00:00.000Z' }),
      piece({ id: 'd', status: 'erro' }),
    ]);
    expect(g.agendado.map((p) => p.id)).toEqual(['c', 'a']);
    expect(g.revisao.map((p) => p.id)).toEqual(['b']);
    expect(g.erro.map((p) => p.id)).toEqual(['d']);
    expect(g.publicado).toEqual([]);
  });

  test('polling rápido enquanto a esteira anda sozinha, lento quando tudo espera uma pessoa', () => {
    expect(pollInterval(undefined)).toBe(POLL_IDLE_MS);
    expect(pollInterval([])).toBe(POLL_IDLE_MS);
    for (const status of ['ideia', 'roteiro', 'producao', 'aprovado'] as PieceStatus[]) {
      expect(pollInterval([piece({ status })])).toBe(POLL_ACTIVE_MS);
    }
    expect(pollInterval([piece({ status: 'revisao' }), piece({ status: 'publicado' })])).toBe(POLL_IDLE_MS);
    // etapa rodando num status que espera pessoa (ex.: retry recém-disparado) também acelera
    expect(pollInterval([piece({ status: 'revisao', running: true })])).toBe(POLL_ACTIVE_MS);
  });

  test('depois de pedir a pauta, o quadro acelera pela janela inteira mesmo sem peça automática', () => {
    const agora = 1_000_000;
    const ate = agora + PLAN_POLL_WINDOW_MS;
    const paradas = [piece({ status: 'revisao' })];
    expect(pollInterval(paradas, ate, agora)).toBe(POLL_ACTIVE_MS);
    expect(pollInterval(undefined, ate, agora)).toBe(POLL_ACTIVE_MS);
    expect(pollInterval([], ate, ate - 1)).toBe(POLL_ACTIVE_MS);
    // janela vencida: volta à regra de sempre
    expect(pollInterval(paradas, ate, ate)).toBe(POLL_IDLE_MS);
    expect(pollInterval([piece({ status: 'ideia' })], ate, ate + 1)).toBe(POLL_ACTIVE_MS);
  });

  test('capa é a primeira mídia com URL, pela ordem', () => {
    expect(coverOf(piece())).toBeNull();
    const cover = coverOf(
      piece({
        media: [
          { mediaId: 'm2', kind: 'image', order: 2, url: '/u/2.png', mime: 'image/png' },
          { mediaId: 'm0', kind: 'image', order: 0, url: null, mime: null },
          { mediaId: 'm1', kind: 'image', order: 1, url: '/u/1.png', mime: 'image/png' },
        ],
      }),
    );
    expect(cover?.mediaId).toBe('m1');
  });
});

describe('ações humanas por status', () => {
  const roteiro = { hook: 'Gancho', slides: [] };
  const com = (status: PieceStatus) => actionsFor(piece({ status, script: roteiro }));
  const sem = (status: PieceStatus) => actionsFor(piece({ status, script: null }));

  test('revisão e erro têm o conjunto completo; reprovada só reabre pelo roteiro', () => {
    expect(com('revisao')).toEqual(['approve', 'redoScript', 'redoProduction', 'reject']);
    expect(com('erro')).toEqual(['retry', 'redoScript', 'redoProduction', 'reject']);
    expect(com('reprovado')).toEqual(['redoScript']);
  });

  test('refazer arte/vídeo exige roteiro gravado: erro antes do roteiro não oferece', () => {
    expect(sem('erro')).toEqual(['retry', 'redoScript', 'reject']);
    for (const s of STATUSES) expect(sem(s)).not.toContain('redoProduction');
  });

  test('etapas automáticas só podem ser descartadas; agendado e publicado não têm ação', () => {
    for (const s of ['ideia', 'roteiro', 'producao'] as PieceStatus[]) expect(com(s)).toEqual(['reject']);
    for (const s of ['aprovado', 'agendado', 'publicado'] as PieceStatus[]) expect(com(s)).toEqual([]);
  });

  test('aprovar e tentar de novo só aparecem onde a transição existe', () => {
    const onde = (a: string) => STATUSES.filter((s) => com(s).includes(a as never));
    expect(onde('approve')).toEqual(['revisao']);
    expect(onde('retry')).toEqual(['erro']);
  });
});

describe('legenda: quando pode editar', () => {
  test('ideia, aprovado e etapa rodando travam, cada um com o seu motivo', () => {
    const livres = STATUSES.filter((status) => captionLock(piece({ status })) === null);
    expect(livres).toEqual(['roteiro', 'producao', 'revisao', 'erro']);
    expect(captionLock(piece({ status: 'reprovado' }))).toBe('reprovado');
    expect(captionLock(piece({ status: 'ideia' }))).toBe('ideia');
    expect(captionLock(piece({ status: 'aprovado' }))).toBe('aprovado');
    expect(captionLock(piece({ status: 'agendado' }))).toBe('closed');
    expect(captionLock(piece({ status: 'publicado' }))).toBe('closed');
  });

  test('etapa rodando trava qualquer status editável', () => {
    for (const status of ['roteiro', 'producao', 'revisao', 'erro'] as PieceStatus[]) {
      expect(captionLock(piece({ status, running: true }))).toBe('running');
    }
    // agendada/publicada continua "fechada", rodando ou não
    expect(captionLock(piece({ status: 'agendado', running: true }))).toBe('closed');
  });
});

describe('legenda: total publicado', () => {
  test('monta como o agendamento: legenda aparada, linha em branco e hashtags', () => {
    expect(publishedText('  Oi  ', ['a', 'b'])).toBe('Oi\n\n#a #b');
    expect(publishedText('Oi', [])).toBe('Oi');
    expect(publishedText('   ', ['a'])).toBe('#a');
    expect(publishedText('', [])).toBe('');
  });

  test('o limite vale para o total: legenda no teto + hashtags passa', () => {
    const cheia = 'x'.repeat(CAPTION_TOTAL_MAX);
    expect(publishedText(cheia, []).length).toBe(CAPTION_TOTAL_MAX);
    expect(publishedText(cheia, ['pme']).length).toBe(CAPTION_TOTAL_MAX + 2 + 4);
  });
});

describe('legenda: rascunho por campo', () => {
  const server = captionValues(
    piece({ caption: 'Legenda gerada', hashtags: ['saude', 'pme'], scheduledFor: '2026-10-05T13:00:00.000Z' }),
  );

  test('valores do servidor no formato dos campos', () => {
    expect(server.caption).toBe('Legenda gerada');
    expect(server.hashtags).toBe('#saude #pme');
    expect(server.date).toBe(toLocalInput(new Date('2026-10-05T13:00:00.000Z')));
    expect(captionValues(piece()).date).toBe('');
  });

  test('só o campo mexido vira rascunho; o resto acompanha o servidor', () => {
    const d = editDraft({}, 'caption', 'Minha legenda', server);
    expect(Object.keys(d)).toEqual(['caption']);
    const novo = { ...server, hashtags: '#outra' };
    expect(shownValues(d, novo)).toEqual({ caption: 'Minha legenda', hashtags: '#outra', date: server.date });
  });

  test('o PATCH leva só os campos mexidos', () => {
    expect(captionPatch({})).toEqual({});
    const d = editDraft({}, 'hashtags', '#a, b #a', server);
    expect(captionPatch(d)).toEqual({ hashtags: ['a', 'b'] });
    const comData = editDraft(d, 'date', '', server);
    expect(captionPatch(comData)).toEqual({ hashtags: ['a', 'b'], scheduledFor: null });
  });

  test('a base é o servidor de quando a edição começou; voltar ao valor do servidor descarta', () => {
    const d1 = editDraft({}, 'caption', 'A', server);
    const d2 = editDraft(d1, 'caption', 'AB', { ...server, caption: 'mudou' });
    expect(d2.caption).toEqual({ value: 'AB', base: 'Legenda gerada' });
    expect(editDraft(d2, 'caption', 'Legenda gerada', server)).toEqual({});
  });

  test('servidor mudou por baixo: o campo aparece como desatualizado até descartar ou manter', () => {
    const d = editDraft(editDraft({}, 'caption', 'Minha', server), 'date', '', server);
    const novo = { ...server, caption: 'Nova do roteiro' };
    expect(staleFields(d, server)).toEqual([]);
    expect(staleFields(d, novo)).toEqual(['caption']);
    expect(dropFields(d, ['caption'])).toEqual({ date: { value: '', base: server.date } });
    const mantido = rebaseFields(d, ['caption'], novo);
    expect(mantido.caption).toEqual({ value: 'Minha', base: 'Nova do roteiro' });
    expect(staleFields(mantido, novo)).toEqual([]);
  });

  test('depois de salvar: sai o que foi enviado, fica o que foi digitado durante o envio', () => {
    const enviado: CaptionDrafts = editDraft(editDraft({}, 'caption', 'Salva', server), 'hashtags', '#x', server);
    const salvo = { ...server, caption: 'Salva', hashtags: '#x' };
    expect(clearSaved(enviado, enviado, salvo)).toEqual({});
    // continuou digitando a legenda enquanto o PATCH ia: fica, reancorada no que foi salvo
    const depois = editDraft(enviado, 'caption', 'Salva e mais', server);
    expect(clearSaved(depois, enviado, salvo)).toEqual({ caption: { value: 'Salva e mais', base: 'Salva' } });
    // campo que não foi no PATCH não é tocado
    const comData = editDraft(enviado, 'date', '', server);
    expect(clearSaved(comData, enviado, salvo)).toEqual({ date: { value: '', base: server.date } });
  });
});

describe('datas', () => {
  test('próxima segunda é sempre depois de hoje', () => {
    expect(nextMonday(new Date(2026, 8, 27, 15))).toBe('2026-09-28'); // domingo
    expect(nextMonday(new Date(2026, 8, 28, 9))).toBe('2026-10-05'); // segunda
    expect(nextMonday(new Date(2026, 8, 30, 23))).toBe('2026-10-05'); // quarta
    expect(nextMonday(new Date(2026, 11, 31))).toBe('2027-01-04'); // virada de ano
  });

  test('isMonday valida o formato e o dia', () => {
    expect(isMonday('2026-09-28')).toBe(true);
    expect(isMonday('2026-09-29')).toBe(false);
    expect(isMonday('28/09/2026')).toBe(false);
  });

  test('shiftMonth atravessa a virada de ano', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-09', 0)).toBe('2026-09');
  });

  test('validade vencida compara o dia local', () => {
    const hoje = new Date(2026, 8, 27, 10);
    expect(isExpired(null, hoje)).toBe(false);
    expect(isExpired('2026-09-26', hoje)).toBe(true);
    expect(isExpired('2026-09-27', hoje)).toBe(false);
  });
});

describe('custos', () => {
  test('dólar com duas casas; fração de centavo ganha casas extras', () => {
    expect(plain(formatUsd(0.1234))).toBe('US$ 0,12');
    expect(plain(formatUsd(0.0034))).toBe('US$ 0,0034');
    expect(plain(formatUsd(0))).toBe('US$ 0,00');
    expect(plain(formatUsd(12.5))).toBe('US$ 12,50');
  });

  test('real aproximado usa a cotação de referência', () => {
    expect(plain(formatBrl(usdToBrl(1)))).toBe('R$ 5,19');
    expect(plain(formatBrl(usdToBrl(2, 5)))).toBe('R$ 10,00');
  });

  test('peças mais caras primeiro, com limite', () => {
    const rows = [
      { pieceId: 'a', keyword: 'A', format: 'post', costUsd: 0.1 },
      { pieceId: 'b', keyword: 'B', format: 'reels', costUsd: 1.2 },
      { pieceId: 'c', keyword: 'C', format: 'carrossel', costUsd: 0.4 },
    ];
    expect(topPieces(rows, 2).map((r) => r.pieceId)).toEqual(['b', 'c']);
  });
});

describe('texto e paleta', () => {
  test('hashtags sem #, sem repetição e no máximo 5', () => {
    expect(parseHashtags('#saude, #plano saude  #PME')).toEqual(['saude', 'plano', 'PME']);
    expect(parseHashtags('a b c d e f g')).toHaveLength(5);
    expect(parseHashtags('   ')).toEqual([]);
    expect(formatHashtags(['a', 'b'])).toBe('#a #b');
  });

  test('cor aceita só #RRGGBB, normalizada em minúsculas', () => {
    expect(normalizeHex('AbC123')).toBe('#abc123');
    expect(normalizeHex(' #0A0B0C ')).toBe('#0a0b0c');
    expect(normalizeHex('#abc')).toBeNull();
    expect(normalizeHex('azul')).toBeNull();
  });

  test('paleta limpa descarta papel vazio ou inválido e mantém as extraídas', () => {
    expect(
      cleanPalette({ primaria: '#112233', destaque: '', texto: 'preto', fundoEscuro: 'AABBCC', extraidas: ['#112233'] }),
    ).toEqual({ primaria: '#112233', fundoEscuro: '#aabbcc', extraidas: ['#112233'] });
  });
});

describe('rascunho da identidade', () => {
  const brand: ContentBrand = {
    name: 'VANTAGE',
    logoMediaId: null,
    logoUrl: null,
    logoDarkMediaId: null,
    logoDarkUrl: null,
    palette: {},
    slogan: '',
    signature: '',
    tone: '',
    defaultChannelId: null,
    ctaChannel: 'whatsapp',
    whatsappNumber: '',
    ctaWord: 'PLANO',
    ctaWordBusiness: 'EMPRESA',
    publishHour: 9,
    timezone: 'America/Manaus',
    autoApprove: false,
  };

  test('paleta vazia = nenhum papel e nenhuma cor extraída', () => {
    expect(isPaletteEmpty({})).toBe(true);
    expect(isPaletteEmpty({ extraidas: ['#112233'] })).toBe(false);
    expect(isPaletteEmpty({ texto: '#112233' })).toBe(false);
  });

  test('papel preenchido com código inválido bloqueia; vazio não', () => {
    expect(invalidPaletteRoles({ primaria: '#12', destaque: '', texto: '#aabbcc' })).toEqual(['primaria']);
  });

  test('corpo do PUT apara textos, limpa a paleta e deixa só dígitos no WhatsApp', () => {
    const d = brandDraft(brand);
    d.name = '  VANTAGE  ';
    d.whatsappNumber = '+55 (92) 99999-0000';
    d.palette = { primaria: 'AABBCC', destaque: '' };
    const body = brandPatchFrom(d);
    expect(body.name).toBe('VANTAGE');
    expect(body.whatsappNumber).toBe('5592999990000');
    expect(body.palette).toEqual({ primaria: '#aabbcc' });
  });

  test('palavra do CTA sai como o gatilho do ManyChat espera', () => {
    expect(ctaWordFrom(' saúde ')).toBe('SAUDE');
    expect(ctaWordFrom('Plano-1')).toBe('PLANO');
    const d = brandDraft(brand);
    d.ctaWord = 'Saúde';
    expect(brandPatchFrom(d).ctaWord).toBe('SAUDE');
  });

  test('o rascunho recém-lido é igual ao servidor; editar o torna diferente', () => {
    const d = brandDraft(brand);
    expect(sameDraft(d, brandDraft(brand))).toBe(true);
    expect(sameDraft({ ...d, autoApprove: true }, brandDraft(brand))).toBe(false);
    // espaço sobrando não conta como alteração: o PUT aparou do mesmo jeito
    expect(sameDraft({ ...d, tone: ' ' }, brandDraft(brand))).toBe(true);
  });
});

describe('roteiro', () => {
  test('lê slides e cenas em ordem, com campos ausentes vazios', () => {
    const s = readScript({
      hook: 'Gancho',
      slides: [
        { ordem: 2, titulo: 'Dois', texto: 't2' },
        { ordem: 1, tipo: 'capa', titulo: 'Um', itens: ['x', 3] },
      ],
      cenas: [{ ordem: 1, duracao_s: 5, locucao: 'fala', texto_tela: 'tela', visual: 'cena' }],
    });
    expect(s?.hook).toBe('Gancho');
    expect(s?.slides.map((x) => x.titulo)).toEqual(['Um', 'Dois']);
    expect(s?.slides[0]?.itens).toEqual(['x']);
    expect(s?.cenas[0]).toEqual({ ordem: 1, duracao: 5, locucao: 'fala', textoTela: 'tela', visual: 'cena' });
    expect(s?.pendencias).toEqual([]);
  });

  test('roteiro ausente ou malformado não quebra a tela', () => {
    expect(readScript(null)).toBeNull();
    expect(readScript({ slides: 'x', cenas: null })).toEqual({
      hook: '',
      story: '',
      offer: '',
      slides: [],
      cenas: [],
      pendencias: [],
    });
  });
});

describe('prompts', () => {
  const v = (name: ContentPrompt['name'], version: number, active: boolean): ContentPrompt => ({
    id: `${name}-${version}`,
    name,
    version,
    system: `s${version}`,
    active,
    createdAt: '2026-09-27T12:00:00.000Z',
  });

  test('separa a versão ativa do histórico, mais nova primeiro', () => {
    const g = groupPrompts([v('roteiro', 1, false), v('roteiro', 3, true), v('roteiro', 2, false), v('pauta', 1, true)]);
    expect(g.roteiro.active?.version).toBe(3);
    expect(g.roteiro.history.map((p) => p.version)).toEqual([2, 1]);
    expect(g.pauta.history).toEqual([]);
    expect(g.revisor.active).toBeNull();
  });

  test('sem versão marcada como ativa, a mais nova assume', () => {
    const g = groupPrompts([v('legenda', 1, false), v('legenda', 2, false)]);
    expect(g.legenda.active?.version).toBe(2);
  });
});

describe('publicação incerta', () => {
  test('peça em erro com publicação NEEDS_REVIEW só oferece a confirmação', () => {
    const piece = { status: 'erro' as const, script: { hook: 'h' } };
    expect(needsPublicationCheck(piece, 'NEEDS_REVIEW')).toBe(true);
    expect(actionsFor(piece, 'NEEDS_REVIEW')).toEqual([]);
    expect(actionsFor(piece, 'FAILED').length).toBeGreaterThan(0);
    expect(needsPublicationCheck({ status: 'agendado' }, 'NEEDS_REVIEW')).toBe(false);
  });
});

describe('link do post na confirmação', () => {
  test('aceita só post do Instagram com https', () => {
    expect(isInstagramLink('https://www.instagram.com/p/abc/')).toBe(true);
    expect(isInstagramLink('https://m.instagram.com/reel/abc')).toBe(true);
    expect(isInstagramLink('instagram.com/p/abc')).toBe(false);
    expect(isInstagramLink('https://instagr.am/p/abc')).toBe(false);
  });
});
