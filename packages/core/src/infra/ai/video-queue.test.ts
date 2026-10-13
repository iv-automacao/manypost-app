import { describe, expect, it } from 'bun:test';
import { makeVideoQueueProvider } from './video-queue';

const config = { baseUrl: 'https://video.example', apiKey: 'id:segredo-de-teste', model: 'modelo/t2v', timeoutMs: 1000 };
const pedido = { prompt: 'cena', durationSec: 6, aspect: '9:16' as const, resolution: '720p' as const, audio: true };

function fakeFetch(respostas: Array<{ status?: number; body: unknown }>) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const r = respostas.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { f, chamadas };
}

describe('adapter de vídeo por fila', () => {
  it('envia os argumentos do modelo com a chave só no header', async () => {
    const { f, chamadas } = fakeFetch([{ body: { request_id: 'r1', status_url: 'x', cancel_url: 'y' } }]);
    const r = await makeVideoQueueProvider(config, f).submit(pedido);
    expect(r.requestId).toBe('r1');
    expect(chamadas[0]!.url).toBe('https://video.example/modelo/t2v');
    expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({ prompt: 'cena', duration: 6, resolution: '720p', aspect_ratio: '9:16', generate_audio: true });
    expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe('Key id:segredo-de-teste');
  });

  it('traduz os estados do provedor; moderado e cancelado são falha', async () => {
    const { f } = fakeFetch([
      { body: { status: 'in_progress' } },
      { body: { status: 'completed', video: { url: 'https://cdn/v.mp4' } } },
      { body: { status: 'nsfw' } },
      { body: { status: 'completed' } },
    ]);
    const p = makeVideoQueueProvider(config, f);
    expect(await p.status('a')).toEqual({ state: 'pending' });
    expect(await p.status('a')).toEqual({ state: 'done', videoUrl: 'https://cdn/v.mp4' });
    expect((await p.status('a')).state).toBe('failed');
    expect((await p.status('a')).state).toBe('failed');
  });

  it('estimativa cai na tabela por segundo quando o provedor não informa valor', async () => {
    const { f } = fakeFetch([{ body: { descricao: 'por segundo' } }, { status: 500, body: {} }, { body: { usd: 1.5 } }]);
    const p = makeVideoQueueProvider(config, f);
    expect(await p.estimate(pedido)).toBeCloseTo(0.4622 * 6, 4);
    expect(await p.estimate(pedido)).toBeCloseTo(0.4622 * 6, 4);
    expect(await p.estimate(pedido)).toBe(1.5);
  });

  it('erro HTTP não vaza a chave', async () => {
    const { f } = fakeFetch([{ status: 403, body: { detail: 'id:segredo-de-teste inválida' } }]);
    const erro = await makeVideoQueueProvider(config, f).submit(pedido).catch((e: Error) => e);
    expect(String((erro as Error).message)).not.toContain('segredo');
    expect((erro as { detail?: { retryable?: boolean } }).detail?.retryable).toBe(false);
  });
});
