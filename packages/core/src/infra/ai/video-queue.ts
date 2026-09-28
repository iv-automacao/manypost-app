/**
 * Adapter de geração de vídeo por fila assíncrona (API da Higgsfield: submit → status).
 *
 * O modelo padrão (Seedance 2.5 texto-para-vídeo) gera imagem e narração juntos. A chave é
 * `id:segredo` e vai no header `Authorization: Key …`; ela nunca aparece em erro nem em log.
 * Pedido moderado, cancelado ou com falha é erro — nunca sucesso sem vídeo.
 */
import type { VideoGenerationProvider, VideoJobState, VideoRequest } from '../../application/ports/content-machine';
import { DomainError } from '../../domain/shared/result';
import { invalidResponse, isRetryableStatus, joinUrl, providerFailed, type FetchLike } from './shared';

export interface VideoQueueConfig {
  baseUrl: string;
  /** `id:segredo` */
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** preço por segundo quando o /estimate não devolve valor (tabela lida em 27/09/2026) */
const USD_POR_SEGUNDO: Record<VideoRequest['resolution'], number> = { '480p': 0.2056, '720p': 0.4622 };

const argumentos = (r: VideoRequest) => ({
  prompt: r.prompt,
  duration: r.durationSec,
  resolution: r.resolution,
  aspect_ratio: r.aspect,
  generate_audio: r.audio,
});

export function makeVideoQueueProvider(config: VideoQueueConfig, fetchImpl: FetchLike = fetch): VideoGenerationProvider {
  const chamar = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchImpl(joinUrl(config.baseUrl, path), {
        method,
        headers: {
          authorization: `Key ${config.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 402/403 aqui costuma ser saldo: repetir não resolve
        throw providerFailed(`vídeo: status ${res.status}`, isRetryableStatus(res.status), { status: res.status });
      }
      try {
        return await res.json();
      } catch {
        throw invalidResponse();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw providerFailed('vídeo: tempo esgotado', true);
      if (error instanceof DomainError) throw error;
      throw providerFailed('vídeo: falha de conexão', true);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    model: config.model,

    async estimate(req) {
      const tabela = USD_POR_SEGUNDO[req.resolution] * req.durationSec;
      try {
        const r = (await chamar('POST', `estimate/${config.model}`, argumentos(req))) as { usd?: unknown };
        const usd = Number(r.usd);
        return Number.isFinite(usd) && usd > 0 ? usd : tabela;
      } catch {
        // estimativa é informação de custo, não condição para gerar
        return tabela;
      }
    },

    async submit(req) {
      const r = (await chamar('POST', config.model, argumentos(req))) as { request_id?: unknown };
      if (typeof r.request_id !== 'string' || !r.request_id) throw invalidResponse();
      return { requestId: r.request_id };
    },

    async status(requestId): Promise<VideoJobState> {
      const r = (await chamar('GET', `requests/${encodeURIComponent(requestId)}/status`)) as {
        status?: string;
        video?: { url?: string };
        error?: string;
      };
      switch (r.status) {
        case 'queued':
        case 'in_progress':
          return { state: 'pending' };
        case 'completed':
          return r.video?.url ? { state: 'done', videoUrl: r.video.url } : { state: 'failed', reason: 'concluído sem vídeo' };
        case 'nsfw':
          return { state: 'failed', reason: 'moderado pelo provedor' };
        case 'canceled':
          return { state: 'failed', reason: 'cancelado' };
        case 'failed':
          return { state: 'failed', reason: (r.error ?? 'falhou no provedor').slice(0, 200) };
        default:
          throw invalidResponse();
      }
    },
  };
}
