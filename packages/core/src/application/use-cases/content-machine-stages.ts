import { ErrorCodes, type ContentPieceStatus } from '@manypost/contracts';
import { z } from 'zod';
import { isAutomatic } from '../../domain/content-machine/content-piece-state';
import { DomainError } from '../../domain/shared/result';
import { sniffMedia } from '../../infra/media/sniff';
import type {
  ContentBrandRecord,
  ContentLintFinding,
  ContentMediaRef,
  ContentPiecePatch,
  ContentPieceRecord,
  ContentReview,
  VideoRequest,
} from '../ports/content-machine';
import {
  agora,
  enqueuePiece,
  foundationText,
  generateJson,
  loadBrand,
  renderBrandFor,
  requireRenderer,
  type ContentMachineDeps,
} from './content-machine';
import { VIDEO_STYLE } from './content-machine-defaults';
import { persistMediaBytes } from './media';

/**
 * Execução das etapas da máquina (design D3). Uma chamada = uma etapa de uma peça:
 *
 *   ideia → roteiro (texto + legenda + lint) → producao (arte ou vídeo) → aprovado | revisao → agendado
 *
 * A posse é um UPDATE condicional com trava; quem não consegue a trava desiste em silêncio, porque
 * outra execução já está cuidando da peça. Toda troca de status é condicional ao status lido, e
 * vira linha em `content_piece_events`.
 */

/** trava de uma etapa: cobre a espera do vídeo com folga */
const LEASE_SEC = 20 * 60;
/** falha retentável tenta de novo sozinha até aqui; depois vira `erro` para uma pessoa olhar */
const MAX_AUTO_RETRIES = 2;
const VIDEO_POLL_MS = 10_000;

const Slide = z.object({
  ordem: z.number().int(),
  tipo: z.string().default('ideia'),
  titulo: z.string().default(''),
  texto: z.string().default(''),
  itens: z.array(z.string()).default([]),
});
const Cena = z.object({
  ordem: z.number().int(),
  duracao_s: z.number().default(6),
  locucao: z.string().min(1),
  texto_tela: z.string().default(''),
  visual: z.string().min(1),
});
const Roteiro = z.object({
  hook: z.string().default(''),
  story: z.string().default(''),
  offer: z.string().default(''),
  slides: z.array(Slide).default([]),
  cenas: z.array(Cena).default([]),
  alt_capa: z.string().default(''),
  pendencias: z.array(z.string()).default([]),
});
type RoteiroT = z.infer<typeof Roteiro>;
const Legenda = z.object({ legenda: z.string().min(1), hashtags: z.array(z.string()).default([]), cta: z.string().default('') });
const Revisao = z.object({
  aprovado: z.boolean(),
  flags: z.array(z.object({ codigo: z.string(), trecho: z.string().default(''), motivo: z.string().default('') })).default([]),
  motivo: z.string().default(''),
});

const invalido = (o: string) =>
  new DomainError(ErrorCodes.ContentGenerationFailed, `O modelo devolveu ${o} fora do formato esperado.`, { retryable: true });

const ctaTexto = (brand: ContentBrandRecord, keyword: string) =>
  brand.ctaChannel === 'whatsapp' ? `Chama no WhatsApp com ${keyword}` : `Manda ${keyword} no direct`;

const linkWhatsapp = (brand: ContentBrandRecord, keyword: string) =>
  brand.ctaChannel === 'whatsapp' && brand.whatsappNumber
    ? `https://wa.me/${brand.whatsappNumber.replace(/\D/g, '')}?text=${encodeURIComponent(keyword)}`
    : '';

const feedbackTexto = (piece: ContentPieceRecord) =>
  piece.feedback.length ? `AJUSTES PEDIDOS (do mais antigo ao mais novo):\n${piece.feedback.map((f) => `- [${f.stage}] ${f.text}`).join('\n')}` : '';

// ------------------------------------------------------------------ etapa 1: roteiro

async function etapaRoteiro(deps: ContentMachineDeps, piece: ContentPieceRecord, brand: ContentBrandRecord) {
  const ctx = { orgId: piece.orgId, pieceId: piece.id, brandName: brand.name };
  const pauta = {
    formato: piece.format,
    pilar: piece.pillar,
    icp: piece.icp,
    praca: piece.market,
    consciencia: piece.awareness,
    gancho: piece.hook,
    angulo: piece.plan.angulo ?? '',
  };
  let correcoes: ContentLintFinding[] = [];
  let resultado: { script: RoteiroT; caption: string; hashtags: string[]; findings: ContentLintFinding[] } | null = null;

  // uma tentativa + uma correção com os achados do lint (design D3)
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const corrigir = correcoes.length
      ? `CORRIJA estes problemas da versão anterior:\n${correcoes.map((f) => `- ${f.codigo}: ${f.msg}`).join('\n')}`
      : '';
    const roteiroBruto = await generateJson(deps, ctx, 'roteiro', [
      `FUNDAÇÃO:\n${await foundationText(deps, piece.orgId, ['produtos', 'icp', 'personagem', 'marca', 'escada'])}`,
      `PAUTA: ${JSON.stringify(pauta)}`,
      `CTA_KEYWORD: ${piece.keyword}`,
      `CANAL_CTA: ${brand.ctaChannel}`,
      feedbackTexto(piece),
      corrigir,
    ].filter(Boolean).join('\n\n'));
    const roteiro = Roteiro.safeParse(roteiroBruto);
    if (!roteiro.success) throw invalido('o roteiro');
    if (piece.format === 'reels' ? roteiro.data.cenas.length === 0 : roteiro.data.slides.length === 0) {
      throw invalido(piece.format === 'reels' ? 'o roteiro sem cenas' : 'o roteiro sem slides');
    }

    const legendaBruta = await generateJson(deps, ctx, 'legenda', [
      `FUNDAÇÃO:\n${await foundationText(deps, piece.orgId, ['marca', 'escada'])}`,
      `ROTEIRO: ${JSON.stringify(roteiro.data)}`,
      `CTA_KEYWORD: ${piece.keyword}`,
      `CANAL_CTA: ${brand.ctaChannel}`,
      `LINK_WHATSAPP: ${linkWhatsapp(brand, piece.keyword)}`,
      feedbackTexto(piece),
    ].filter(Boolean).join('\n\n'));
    const legenda = Legenda.safeParse(legendaBruta);
    if (!legenda.success) throw invalido('a legenda');

    let script = roteiro.data;
    let caption = legenda.data.legenda;
    let hashtags = legenda.data.hashtags.map((h) => h.replace(/^#/, '').trim()).filter(Boolean).slice(0, 5);
    let findings: ContentLintFinding[] = [];
    if (deps.renderer) {
      const lint = await deps.renderer.lint({ script, caption, hashtags, keyword: piece.keyword, format: piece.format, ctaChannel: brand.ctaChannel });
      const limpo = Roteiro.safeParse(lint.script);
      if (limpo.success) script = limpo.data;
      caption = lint.caption;
      hashtags = lint.hashtags;
      findings = lint.findings;
      if (lint.hasError && tentativa === 0) {
        correcoes = lint.findings.filter((f) => f.nivel === 'erro');
        continue;
      }
    }
    resultado = { script, caption, hashtags, findings };
    break;
  }

  const r = resultado!;
  return {
    to: 'roteiro' as const,
    patch: {
      script: r.script as unknown as Record<string, unknown>,
      caption: r.caption,
      hashtags: r.hashtags,
      // o lint viaja com a peça: o revisor e a pessoa veem o que sobrou
      review: r.findings.length ? { aprovado: false, flags: [], motivo: '', lint: r.findings } : null,
    } satisfies ContentPiecePatch,
    detail: { slides: r.script.slides.length, cenas: r.script.cenas.length, achados: r.findings.length },
  };
}

// ------------------------------------------------------------------ etapa 2: produção

async function persistirImagens(deps: ContentMachineDeps, piece: ContentPieceRecord, imagens: Array<{ bytes: Uint8Array; width: number; height: number }>, alt: string) {
  const refs: ContentMediaRef[] = [];
  for (const [i, img] of imagens.entries()) {
    const tipo = sniffMedia(img.bytes);
    if (!tipo || tipo.kind !== 'image') throw new DomainError(ErrorCodes.ContentGenerationFailed, 'o renderizador devolveu algo que não é imagem', { retryable: true });
    const m = await persistMediaBytes(deps, {
      orgId: piece.orgId,
      bytes: img.bytes,
      mime: tipo.mime,
      width: tipo.width ?? img.width,
      height: tipo.height ?? img.height,
      alt: i === 0 && alt ? alt.slice(0, 1000) : null,
      source: 'ai',
      generationPrompt: `máquina de conteúdo · ${piece.keyword} · arte ${i + 1}`,
      generationModel: 'renderizador',
    });
    refs.push({ mediaId: m.id, kind: 'image', order: i + 1 });
  }
  return refs;
}

async function etapaArte(deps: ContentMachineDeps, piece: ContentPieceRecord, brand: ContentBrandRecord) {
  const script = Roteiro.parse(piece.script ?? {});
  const format = piece.format === 'reels' ? 'post' : piece.format;
  const imagens = await requireRenderer(deps).render({
    format,
    kicker: brand.name,
    slides: format === 'carrossel' ? script.slides : script.slides.slice(0, 1),
    cta: format === 'carrossel' ? '' : script.offer || ctaTexto(brand, piece.keyword),
    brand: await renderBrandFor(deps, brand),
  });
  if (imagens.length === 0) throw new DomainError(ErrorCodes.ContentGenerationFailed, 'o renderizador não devolveu imagens', { retryable: true });
  const media = await persistirImagens(deps, piece, imagens, script.alt_capa);
  return { to: 'producao' as const, patch: { media } satisfies ContentPiecePatch, detail: { imagens: media.length } };
}

interface ClipeEstado {
  ordem: number;
  requestId: string;
  estado: 'pending' | 'done' | 'failed';
  url?: string;
  motivo?: string;
  custoUsd: number;
}

/**
 * Reels: um clipe por cena, com narração gerada junto da imagem. O id de cada pedido é gravado
 * ANTES de esperar — se o processo cair, a próxima execução retoma a consulta em vez de pagar de novo.
 */
async function etapaVideo(deps: ContentMachineDeps, piece: ContentPieceRecord, brand: ContentBrandRecord) {
  if (!deps.video) throw new DomainError(ErrorCodes.ContentNotConfigured, 'Gerador de vídeo não configurado (VIDEO_PROVIDER_KEY).');
  const video = deps.video;
  const renderer = requireRenderer(deps);
  const script = Roteiro.parse(piece.script ?? {});
  const cenas = [...script.cenas].sort((a, b) => a.ordem - b.ordem).slice(0, 5);
  const salvo = ((piece.plan.video as { clipes?: ClipeEstado[] } | undefined)?.clipes ?? []).filter((c) => c.estado !== 'failed');
  const clipes: ClipeEstado[] = [...salvo];
  const salvar = () => deps.repo.update(piece.orgId, piece.id, { plan: { ...piece.plan, video: { clipes } } });

  for (const cena of cenas) {
    if (clipes.some((c) => c.ordem === cena.ordem)) continue;
    const pedido: VideoRequest = {
      prompt: `${cena.visual} ${VIDEO_STYLE}"${cena.locucao}"`,
      durationSec: 6,
      aspect: '9:16',
      resolution: '720p',
      audio: true,
    };
    const custo = await video.estimate(pedido);
    const { requestId } = await video.submit(pedido);
    clipes.push({ ordem: cena.ordem, requestId, estado: 'pending', custoUsd: custo });
    await salvar();
    await deps.repo.addSpend({ orgId: piece.orgId, pieceId: piece.id, service: 'video', model: video.model, externalId: requestId, costUsd: custo, detail: { cena: cena.ordem, duracaoS: pedido.durationSec } });
  }

  const dormir = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const prazo = agora(deps).getTime() + (deps.videoWaitMs ?? 8 * 60_000);
  while (clipes.some((c) => c.estado === 'pending')) {
    for (const c of clipes.filter((x) => x.estado === 'pending')) {
      const s = await video.status(c.requestId);
      if (s.state === 'done') Object.assign(c, { estado: 'done', url: s.videoUrl });
      if (s.state === 'failed') {
        Object.assign(c, { estado: 'failed', motivo: s.reason });
        // pedido que falhou ou foi moderado não é cobrado: estorna o que foi registrado
        await deps.repo.addSpend({ orgId: piece.orgId, pieceId: piece.id, service: 'video', model: video.model, externalId: `${c.requestId}:estorno`, costUsd: -c.custoUsd, detail: { motivo: s.reason } });
      }
    }
    await salvar();
    if (clipes.some((c) => c.estado === 'failed')) {
      const f = clipes.find((c) => c.estado === 'failed')!;
      throw new DomainError(ErrorCodes.ContentGenerationFailed, `vídeo da cena ${f.ordem} falhou: ${f.motivo ?? 'sem motivo'}`, { retryable: true });
    }
    if (!clipes.some((c) => c.estado === 'pending')) break;
    if (agora(deps).getTime() > prazo) return { pending: true as const };
    await dormir(VIDEO_POLL_MS);
  }

  const reel = await renderer.assembleReel({
    clipUrls: [...clipes].sort((a, b) => a.ordem - b.ordem).map((c) => c.url!),
    closing: {
      title: brand.slogan || script.hook,
      text: script.story.slice(0, 140),
      cta: ctaTexto(brand, piece.keyword),
      brand: await renderBrandFor(deps, brand),
    },
  });
  const tipo = sniffMedia(reel.bytes);
  if (!tipo || tipo.kind !== 'video') throw new DomainError(ErrorCodes.ContentGenerationFailed, 'a montagem do reels não devolveu vídeo', { retryable: true });
  if (reel.bytes.byteLength > deps.videoMaxBytes) throw new DomainError(ErrorCodes.MediaTooLarge, 'o reels montado passou do limite de vídeo');
  const m = await persistMediaBytes(deps, {
    orgId: piece.orgId,
    bytes: reel.bytes,
    mime: tipo.mime,
    width: tipo.width ?? 1080,
    height: tipo.height ?? 1920,
    alt: script.alt_capa || null,
    source: 'ai',
    generationPrompt: cenas.map((c) => c.locucao).join(' / ').slice(0, 4000),
    generationModel: video.model,
  });
  return {
    to: 'producao' as const,
    patch: { media: [{ mediaId: m.id, kind: 'video', order: 1 }] } satisfies ContentPiecePatch,
    detail: { clipes: clipes.length, duracaoS: reel.durationSec },
  };
}

// ------------------------------------------------------------------ etapa 3: revisão

async function etapaRevisao(deps: ContentMachineDeps, piece: ContentPieceRecord, brand: ContentBrandRecord) {
  const hoje = agora(deps).toISOString().slice(0, 10);
  const lint = piece.review?.lint ?? [];
  let review: ContentReview;
  try {
    const bruto = await generateJson(deps, { orgId: piece.orgId, pieceId: piece.id, brandName: brand.name }, 'revisor', [
      `DATA_HOJE: ${hoje}`,
      `FUNDAÇÃO:\n${await foundationText(deps, piece.orgId, ['produtos', 'marca', 'escada'])}`,
      `PEÇA: ${JSON.stringify({ formato: piece.format, roteiro: piece.script, legenda: piece.caption, hashtags: piece.hashtags, midias: piece.media.map((m) => ({ tipo: m.kind, ordem: m.order })) })}`,
      `CTA_KEYWORD: ${piece.keyword}`,
    ].join('\n\n'));
    const lido = Revisao.safeParse(bruto);
    review = lido.success
      ? { ...lido.data, aprovado: lido.data.aprovado && lido.data.flags.length === 0 }
      : { aprovado: false, flags: [], motivo: 'O revisor respondeu fora do formato; precisa de olho humano.' };
  } catch (err) {
    if (err instanceof DomainError && err.code === ErrorCodes.ContentGenerationFailed) {
      review = { aprovado: false, flags: [], motivo: 'O revisor não respondeu em formato válido; precisa de olho humano.' };
    } else throw err;
  }
  // erro de lint que sobrou depois da correção também segura a peça
  const errosLint = lint.filter((f) => f.nivel === 'erro');
  if (errosLint.length) {
    review.aprovado = false;
    review.flags = [...review.flags, ...errosLint.map((f) => ({ codigo: `LINT_${f.codigo}`, trecho: '', motivo: f.msg }))];
  }
  review.lint = lint;
  const segue = review.aprovado && brand.autoApprove;
  return {
    to: (segue ? 'aprovado' : 'revisao') as ContentPieceStatus,
    patch: { review } satisfies ContentPiecePatch,
    detail: { aprovado: review.aprovado, flags: review.flags.map((f) => f.codigo), automatico: brand.autoApprove },
  };
}

// ------------------------------------------------------------------ etapa 4: agendamento

async function etapaAgendar(deps: ContentMachineDeps, piece: ContentPieceRecord, brand: ContentBrandRecord) {
  const channelId = piece.channelId ?? brand.defaultChannelId;
  if (!channelId) throw new DomainError(ErrorCodes.ContentNotConfigured, 'Defina o canal padrão da máquina (identidade) ou o canal da peça.');
  const [canal] = await deps.channels.findMany(piece.orgId, [channelId]);
  if (!canal) throw new DomainError(ErrorCodes.NotFound, 'canal da peça não encontrado');
  if (piece.media.length === 0) throw new DomainError(ErrorCodes.ContentGenerationFailed, 'a peça não tem mídia para publicar');

  // data do slot se ainda está no futuro; senão, daqui a 2 minutos
  const minimo = new Date(agora(deps).getTime() + 2 * 60_000);
  const publishAt = piece.scheduledFor && piece.scheduledFor > minimo ? piece.scheduledFor : minimo;
  const hashtags = piece.hashtags.map((h) => `#${h}`).join(' ');
  const text = [piece.caption.trim(), hashtags].filter(Boolean).join('\n\n');
  const instagram = canal.provider.startsWith('instagram');
  const group = await deps.schedulePost({
    orgId: piece.orgId,
    authorId: null,
    text,
    channelIds: [channelId],
    publishAt,
    timezone: brand.timezone,
    origin: 'AUTOMATION',
    mediaIds: [...piece.media].sort((a, b) => a.order - b.order).map((m) => m.mediaId),
    ...(instagram ? { settingsByChannel: { [channelId]: { postType: piece.format === 'story' ? 'story' : 'feed' } } } : {}),
  });
  if (!group) throw new DomainError(ErrorCodes.ContentGenerationFailed, 'o agendamento não devolveu o post');
  return {
    to: 'agendado' as const,
    patch: { postGroupId: group.id, scheduledFor: publishAt, channelId } satisfies ContentPiecePatch,
    detail: { publicaEm: publishAt.toISOString(), canal: canal.name },
  };
}

// ------------------------------------------------------------------ orquestração

type StageOut =
  | { to: ContentPieceStatus; patch: ContentPiecePatch; detail: Record<string, unknown> }
  | { pending: true };

const ETAPA: Record<string, string> = { ideia: 'roteiro', roteiro: 'producao', producao: 'revisao', aprovado: 'agendamento' };

export const makeRunContentStage = (deps: ContentMachineDeps) =>
  async (orgId: string, pieceId: string): Promise<void> => {
    const atual = await deps.repo.getPiece(orgId, pieceId);
    if (!atual || !isAutomatic(atual.status)) return;
    const piece = await deps.repo.claim(orgId, pieceId, atual.status, LEASE_SEC);
    if (!piece) return; // outra execução está com ela

    const stage = ETAPA[piece.status]!;
    try {
      const brand = await loadBrand(deps, orgId);
      let out: StageOut;
      switch (piece.status) {
        case 'ideia':
          out = await etapaRoteiro(deps, piece, brand);
          break;
        case 'roteiro':
          out = piece.format === 'reels' ? await etapaVideo(deps, piece, brand) : await etapaArte(deps, piece, brand);
          break;
        case 'producao':
          out = await etapaRevisao(deps, piece, brand);
          break;
        default:
          out = await etapaAgendar(deps, piece, brand);
      }
      if ('pending' in out) {
        // vídeo ainda gerando: solta a trava e volta em 1 minuto
        await deps.repo.release(orgId, pieceId);
        await enqueuePiece(deps, orgId, piece, new Date(agora(deps).getTime() + 60_000));
        return;
      }
      const nova = await deps.repo.transition(orgId, pieceId, piece.status, out.to, { ...out.patch, error: null, resetAttempts: true }, { stage, detail: out.detail });
      if (nova) await enqueuePiece(deps, orgId, nova);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retentavel =
        !(err instanceof DomainError) ||
        err.detail?.retryable === true ||
        err.code === ErrorCodes.AiProviderFailed ||
        err.code === ErrorCodes.AiInvalidResponse;
      deps.log?.('warn', 'content-machine: etapa falhou', { pieceId, stage, code: err instanceof DomainError ? err.code : 'unexpected', retentavel });
      if (retentavel && piece.attempts < MAX_AUTO_RETRIES) {
        await deps.repo.release(orgId, pieceId, { incrementAttempts: true, error: msg.slice(0, 1000) });
        await enqueuePiece(deps, orgId, piece, new Date(agora(deps).getTime() + 60_000 * (piece.attempts + 1)));
        return;
      }
      await deps.repo.transition(orgId, pieceId, piece.status, 'erro', { error: msg.slice(0, 1000), incrementAttempts: true }, { stage, detail: { erro: msg.slice(0, 300) } });
    }
  };

/**
 * Sweeper (a cada minuto): reenfileira peça automática parada e acompanha a publicação das
 * agendadas. Idempotente — rodar duas vezes não faz nada a mais.
 */
export const makeSweepContent = (deps: ContentMachineDeps) =>
  async (): Promise<{ requeued: number; published: number; failed: number }> => {
    const now = agora(deps);
    let requeued = 0;
    let published = 0;
    let failed = 0;
    for (const p of await deps.repo.stalled(now, 5 * 60)) {
      const piece = await deps.repo.getPiece(p.orgId, p.id);
      if (!piece) continue;
      await enqueuePiece(deps, p.orgId, piece);
      requeued++;
    }
    for (const p of await deps.repo.scheduled()) {
      if (!p.postGroupId) continue;
      const group = await deps.publishing.getGroup(p.orgId, p.postGroupId);
      const pub = group?.publications[0];
      if (!group || !pub) continue;
      if (pub.state === 'PUBLISHED') {
        const ok = await deps.repo.transition(p.orgId, p.id, 'agendado', 'publicado', { publishedAt: now, permalink: pub.releaseUrl }, { stage: 'publicacao', detail: { url: pub.releaseUrl } });
        if (ok) published++;
      } else if (pub.state === 'FAILED' || pub.state === 'CANCELLED' || group.state === 'CANCELLED') {
        const ok = await deps.repo.transition(p.orgId, p.id, 'agendado', 'erro', { error: pub.errorMessage ?? `publicação ${pub.state.toLowerCase()}` }, { stage: 'publicacao', detail: { estado: pub.state } });
        if (ok) failed++;
      }
    }
    return { requeued, published, failed };
  };
