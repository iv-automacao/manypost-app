import { ErrorCodes } from '@manypost/contracts';
import type {
  BrandPalette,
  ContentLintFinding,
  ContentRenderer,
  RenderBrand,
} from '../application/ports/content-machine';
import { DomainError } from '../domain/shared/result';

/**
 * Cliente HTTP do renderizador de artes (openspec add-content-machine, design D4).
 *
 * O renderizador é um serviço do operador (navegador headless + ffmpeg), por isso a URL é
 * configuração e pode apontar para a rede interna. A chave vai só no header e nunca em erro.
 */
export interface ContentRendererConfig {
  baseUrl: string;
  apiKey: string;
  /** render e lint são rápidos; montar reels baixa clipes e codifica vídeo */
  timeoutMs?: number;
  reelTimeoutMs?: number;
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const falhou = (o: string, retryable = true) =>
  new DomainError(ErrorCodes.ContentGenerationFailed, `Renderizador: ${o}.`, { retryable });

const marca = (b: RenderBrand) => ({
  nome: b.name,
  logo_url: b.logoUrl,
  logo_escura_url: b.logoDarkUrl,
  paleta: {
    primaria: b.palette.primaria ?? null,
    destaque: b.palette.destaque ?? null,
    fundo_escuro: b.palette.fundoEscuro ?? null,
    fundo_claro: b.palette.fundoClaro ?? null,
    texto: b.palette.texto ?? null,
    texto_suave: b.palette.textoSuave ?? null,
  },
  slogan: b.slogan,
  assinatura: b.signature,
});

const base64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export function makeContentRenderer(config: ContentRendererConfig, fetchImpl: FetchLike = fetch): ContentRenderer {
  const url = (p: string) => `${config.baseUrl.replace(/\/+$/, '')}/${p}`;

  const post = async (path: string, body: unknown, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status < 500) {
          // 4xx = o pedido não passa repetindo (imagem ilegível, clipe acima do limite): a mensagem
          // do serviço já é para gente, em pt-BR
          const corpo = (await res.json().catch(() => null)) as { detail?: unknown } | null;
          const detalhe = typeof corpo?.detail === 'string' ? corpo.detail : `o renderizador recusou o pedido (status ${res.status})`;
          throw new DomainError(ErrorCodes.ContentInvalidInput, `${detalhe.charAt(0).toUpperCase()}${detalhe.slice(1)}.`.replace(/\.\.$/, '.'), {
            retryable: false,
            status: res.status,
          });
        }
        throw falhou(`status ${res.status}`, true);
      }
      return res;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw falhou('tempo esgotado');
      throw falhou('sem conexão');
    } finally {
      clearTimeout(timer);
    }
  };
  const json = async (path: string, body: unknown, timeoutMs = config.timeoutMs ?? 90_000) => {
    const res = await post(path, body, timeoutMs);
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw falhou('resposta ilegível');
    }
  };

  return {
    async render(req) {
      const r = await json('v2/render', {
        formato: req.format,
        kicker: req.kicker,
        slides: req.slides,
        cta: req.cta,
        marca: marca(req.brand),
      });
      const imagens = r.imagens;
      if (!Array.isArray(imagens)) throw falhou('render sem imagens');
      return imagens.map((i: { png_base64?: string; largura?: number; altura?: number }) => {
        if (typeof i.png_base64 !== 'string') throw falhou('imagem sem conteúdo');
        return { bytes: base64(i.png_base64), width: Number(i.largura) || 1080, height: Number(i.altura) || 1350 };
      });
    },

    async lint(req) {
      const r = await json('lint', {
        roteiro: req.script,
        legenda: req.caption,
        hashtags: req.hashtags,
        cta_keyword: req.keyword,
        formato: req.format,
        canal_cta: req.ctaChannel,
      });
      const achados = Array.isArray(r.achados) ? (r.achados as Array<Record<string, unknown>>) : [];
      const findings: ContentLintFinding[] = achados.map((a) => ({
        nivel: a.nivel === 'erro' ? 'erro' : 'aviso',
        codigo: String(a.codigo ?? 'LINT'),
        msg: String(a.detalhe ?? a.msg ?? ''),
      }));
      return {
        script: (r.roteiro as Record<string, unknown>) ?? req.script,
        caption: typeof r.legenda === 'string' ? r.legenda : req.caption,
        hashtags: Array.isArray(r.hashtags) ? (r.hashtags as string[]) : req.hashtags,
        findings,
        hasError: findings.some((f) => f.nivel === 'erro'),
      };
    },

    async palette(req) {
      const r = await json('paleta', { image_url: req.imageUrl });
      const cores = Array.isArray(r.cores) ? (r.cores as string[]) : [];
      const s = (r.sugestao ?? {}) as Record<string, string | undefined>;
      const suggestion: BrandPalette = {
        ...(s.primaria ? { primaria: s.primaria } : {}),
        ...(s.destaque ? { destaque: s.destaque } : {}),
        ...(s.fundo_escuro ? { fundoEscuro: s.fundo_escuro } : {}),
        ...(s.fundo_claro ? { fundoClaro: s.fundo_claro } : {}),
        ...(s.texto ? { texto: s.texto } : {}),
        ...(s.texto_suave ? { textoSuave: s.texto_suave } : {}),
      };
      return { colors: cores, suggestion };
    },

    async assembleReel(req) {
      const res = await post(
        'montar-reel',
        {
          clipes: req.clipUrls,
          fechamento: { titulo: req.closing.title, texto: req.closing.text, cta: req.closing.cta, marca: marca(req.closing.brand) },
        },
        config.reelTimeoutMs ?? 5 * 60_000,
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw falhou('reels vazio');
      return { bytes, durationSec: Number(res.headers.get('x-duracao-s')) || 0 };
    },
  };
}
