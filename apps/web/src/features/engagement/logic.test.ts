import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_METRIC_KEYS,
  REPLY_MAX,
  captionPreview,
  eligibleChannels,
  hasNegativeTotal,
  hiddenComments,
  mediaKindKey,
  formatMetric,
  needsReconnect,
  replyState,
  reachBars,
} from './logic';

const canal = (id: string, provider: string, status = 'ACTIVE') => ({
  id,
  provider,
  externalId: id,
  name: id,
  username: null,
  avatarUrl: null,
  status,
  scopes: [],
});
const rede = (id: string, comments: boolean, insights: boolean) => ({ id, engagement: { comments, insights } });

describe('eligibleChannels', () => {
  const canais = [
    canal('ig', 'instagram-standalone'),
    canal('fb', 'facebook'),
    canal('ig2', 'instagram-standalone', 'REFRESH_REQUIRED'),
    canal('ig3', 'instagram-standalone', 'DISABLED'),
  ];
  const redes = [rede('instagram-standalone', true, true), rede('facebook', false, false)];

  test('só redes com a capacidade; quem precisa reconectar continua listado, desativado não', () => {
    expect(eligibleChannels(canais, redes, 'comments').map((c) => c.id)).toEqual(['ig', 'ig2']);
  });

  test('sem catálogo ainda, ninguém é elegível', () => {
    expect(eligibleChannels(canais, undefined, 'insights')).toEqual([]);
  });
});

describe('needsReconnect', () => {
  test.each([
    [{ title: 'channel.refresh_required' }, true],
    [{ title: 'channel.missing_scopes' }, true],
    [{ title: 'channel.provider_failed' }, false],
    [new Error('rede'), false],
    [null, false],
  ])('%o → %p', (err, expected) => {
    expect(needsReconnect(err)).toBe(expected);
  });
});

describe('formatMetric', () => {
  test('null nunca vira zero', () => {
    expect(formatMetric(null, 'pt-BR')).toBe('—');
    expect(formatMetric(undefined, 'pt-BR')).toBe('—');
  });
  test('formata no locale', () => {
    expect(formatMetric(12345, 'pt-BR')).toBe('12.345');
    expect(formatMetric(0, 'pt-BR')).toBe('0');
  });
});

describe('replyState', () => {
  test('vazio ou só espaço não envia', () => {
    expect(replyState('   ').canSend).toBe(false);
  });
  test('conta caracteres depois do trim e barra acima do limite', () => {
    expect(replyState('  oi  ')).toEqual({ length: 2, canSend: true, over: false });
    const longo = replyState('a'.repeat(REPLY_MAX + 1));
    expect(longo.over).toBe(true);
    expect(longo.canSend).toBe(false);
  });
});

describe('captionPreview', () => {
  test('primeira linha, cortada com reticências', () => {
    expect(captionPreview('Plano de saúde\nsegunda linha', 40)).toBe('Plano de saúde');
    expect(captionPreview('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(captionPreview(undefined, 10)).toBe('');
  });
});

describe('reachBars', () => {
  test('altura relativa ao maior dia, com piso visível para valores > 0', () => {
    const bars = reachBars([
      { date: '2026-10-01', value: 0 },
      { date: '2026-10-02', value: 50 },
      { date: '2026-10-03', value: 100 },
    ]);
    expect(bars.map((b) => b.pct)).toEqual([0, 50, 100]);
  });
  test('série toda zerada não divide por zero', () => {
    expect(reachBars([{ date: 'd', value: 0 }])[0]?.pct).toBe(0);
  });
  test('valor pequeno ainda aparece', () => {
    expect(reachBars([{ date: 'a', value: 1 }, { date: 'b', value: 1000 }])[0]?.pct).toBe(2);
  });
});

test('ordem dos totais da conta segue a da API', () => {
  expect(ACCOUNT_METRIC_KEYS[0]).toBe('reach');
  expect(ACCOUNT_METRIC_KEYS).toContain('saves');
});

describe('mediaKindKey', () => {
  test('reels e story pelo productType; o resto pelo mediaType (carrossel vem como FEED)', () => {
    expect(mediaKindKey({ mediaType: 'VIDEO', productType: 'REELS' })).toBe('REELS');
    expect(mediaKindKey({ mediaType: 'CAROUSEL_ALBUM', productType: 'FEED' })).toBe('CAROUSEL_ALBUM');
    expect(mediaKindKey({ mediaType: 'IMAGE' })).toBe('IMAGE');
  });
});

describe('hasNegativeTotal', () => {
  test('a Meta devolve totais líquidos (salvamento desfeito desconta)', () => {
    expect(hasNegativeTotal({ saves: -3, reach: 10, views: null })).toBe(true);
    expect(hasNegativeTotal({ saves: 0, views: null })).toBe(false);
  });
});

describe('hiddenComments', () => {
  test('quantos a rede conta mas não entregou', () => {
    expect(hiddenComments(5, 0)).toBe(5);
    expect(hiddenComments(5, 5)).toBe(0);
    expect(hiddenComments(undefined, 0)).toBe(0);
    expect(hiddenComments(2, 3)).toBe(0);
  });
});
