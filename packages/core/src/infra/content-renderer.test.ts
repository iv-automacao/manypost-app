import { describe, expect, it } from 'bun:test';
import { makeContentRenderer } from './content-renderer';

const brand = { name: 'Marca', logoUrl: 'https://x/logo.png', logoDarkUrl: null, palette: { primaria: '#0073ca' }, slogan: 's', signature: 'a' };

const fake = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    return new Response(body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
  };
  return { f, chamadas };
};

describe('cliente do renderizador', () => {
  it('render devolve os bytes das imagens e manda a marca com a chave no header', async () => {
    const { f, chamadas } = fake({ imagens: [{ png_base64: btoa('abc'), largura: 1080, altura: 1920 }] });
    const r = await makeContentRenderer({ baseUrl: 'http://render:8000/', apiKey: 'k' }, f).render({ format: 'story', kicker: 'Marca', slides: [], cta: 'x', brand });
    expect(new TextDecoder().decode(r[0]!.bytes)).toBe('abc');
    expect(r[0]!.height).toBe(1920);
    expect(chamadas[0]!.url).toBe('http://render:8000/v2/render');
    expect((chamadas[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(String(chamadas[0]!.init.body)).marca.paleta.primaria).toBe('#0073ca');
  });

  it('lint traduz os achados e marca erro', async () => {
    const { f } = fake({ roteiro: { hook: 'h' }, legenda: 'l', hashtags: ['a'], achados: [{ nivel: 'erro', codigo: 'SEM_CTA', detalhe: 'd' }, { nivel: 'aviso', codigo: 'X', detalhe: 'y' }] });
    const r = await makeContentRenderer({ baseUrl: 'http://r', apiKey: 'k' }, f).lint({ script: {}, caption: '', hashtags: [], keyword: 'K', format: 'post', ctaChannel: 'direct' });
    expect(r.hasError).toBe(true);
    expect(r.findings).toEqual([{ nivel: 'erro', codigo: 'SEM_CTA', msg: 'd' }, { nivel: 'aviso', codigo: 'X', msg: 'y' }]);
  });

  it('montagem do reels devolve os bytes e a duração do header', async () => {
    const { f } = fake(new Uint8Array([1, 2, 3]), 200, { 'x-duracao-s': '21.5' });
    const r = await makeContentRenderer({ baseUrl: 'http://r', apiKey: 'k' }, f).assembleReel({ clipUrls: ['a'], closing: { title: 't', text: 'x', cta: 'c', brand } });
    expect(r.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.durationSec).toBe(21.5);
  });

  it('4xx não é retentável; 5xx é', async () => {
    const r4 = await makeContentRenderer({ baseUrl: 'http://r', apiKey: 'k' }, fake({ detail: 'formato' }, 400).f).palette({ imageUrl: 'u' }).catch((e) => e);
    const r5 = await makeContentRenderer({ baseUrl: 'http://r', apiKey: 'k' }, fake({}, 502).f).palette({ imageUrl: 'u' }).catch((e) => e);
    expect(r4.detail.retryable).toBe(false);
    expect(r5.detail.retryable).toBe(true);
  });
});
