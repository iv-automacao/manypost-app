'use client';

import { CircleAlert, ExternalLink, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorCode, type ApiProblem } from '@/lib/api/client';
import { useApiErrorMessage } from '@/lib/api/errors';
import { Field, RefreshNotice, SectionTitle } from './field';
import { useDecidePiece, useEditPiece, usePiece } from './hooks';
import {
  CAPTION_TOTAL_MAX,
  actionsFor,
  captionLock,
  needsPublicationCheck,
  captionPatch,
  captionValues,
  clearSaved,
  dropFields,
  editDraft,
  formatBrl,
  formatHashtags,
  formatUsd,
  orderedMedia,
  parseHashtags,
  publishedText,
  readScript,
  rebaseFields,
  shownValues,
  staleFields,
  usdToBrl,
  type CaptionDrafts,
  type CaptionField,
  type PieceAction,
} from './logic';
import { STATUS_BADGE } from './status-ui';
import type { ContentPiece, ContentPieceEvent, PieceDecision } from './types';

/** Detalhe de uma peça num painel lateral; `pieceId === null` fecha. */
export function PieceSheet({ pieceId, onClose }: { pieceId: string | null; onClose: () => void }) {
  return (
    <Sheet open={pieceId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="max-w-2xl">{pieceId ? <PieceDetail id={pieceId} /> : null}</SheetContent>
    </Sheet>
  );
}

function PieceDetail({ id }: { id: string }) {
  const [drafts, setDrafts] = useState<CaptionDrafts>({});
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const locale = useLocale();
  const detail = usePiece(id);

  if (detail.isPending) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>{tc('loading')}</SheetTitle>
          <SheetDescription className="sr-only">{tc('loading')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <Skeleton className="h-48 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
        </div>
      </>
    );
  }

  // erro só vira tela de erro sem nada em cache; com a peça carregada, o refetch que falhou vira
  // um aviso discreto e o rascunho da legenda continua montado
  if (!detail.data) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>{t('piece.loadError')}</SheetTitle>
          <SheetDescription className="sr-only">{t('piece.loadError')}</SheetDescription>
        </SheetHeader>
        <div className="p-4 sm:p-6">
          <Button variant="outline" onClick={() => void detail.refetch()}>
            {tc('retry')}
          </Button>
        </div>
      </>
    );
  }

  const { piece, events } = detail.data;
  return (
    <>
      <SheetHeader className="pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_BADGE[piece.status]}>{t(`status.${piece.status}`)}</Badge>
          <Badge variant="accent">{t(`format.${piece.format}`)}</Badge>
          <span className="text-meta font-medium tabular-nums text-graphite">{piece.keyword}</span>
        </div>
        <SheetTitle className="leading-snug">{piece.hook || '…'}</SheetTitle>
        <SheetDescription className="tabular-nums">
          {t('piece.cost')}: {formatUsd(piece.costUsd, locale)} ·{' '}
          {t('piece.approx', { brl: formatBrl(usdToBrl(piece.costUsd), locale) })}
        </SheetDescription>
        {piece.permalink ? (
          <a
            href={piece.permalink}
            target="_blank"
            rel="noreferrer"
            className="flex w-fit items-center gap-1 text-compact font-medium text-accent outline-none hover:text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('piece.permalink')}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </SheetHeader>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-col gap-6">
          {detail.isError ? <RefreshNotice onRetry={() => void detail.refetch()} /> : null}
          {piece.running ? (
            <Alert>
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              <div>
                <AlertDescription>{t('piece.running')}</AlertDescription>
              </div>
            </Alert>
          ) : null}
          {piece.error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <div>
                <AlertTitle>{t('piece.errorTitle')}</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap">{piece.error}</AlertDescription>
              </div>
            </Alert>
          ) : null}
          <MediaSection piece={piece} />
          <CaptionSection key={piece.id} piece={piece} drafts={drafts} setDrafts={setDrafts} />
          <ScriptSection piece={piece} />
          <ReviewSection piece={piece} />
          <FeedbackSection piece={piece} />
          <EventsSection events={events} />
        </div>
      </div>

      <PieceActions
        piece={piece}
        publicationState={detail.data.publication?.state ?? null}
        unsaved={Object.keys(drafts).length > 0}
        onDiscard={() => setDrafts({})}
      />
    </>
  );
}

// ------------------------------------------------------------------ mídia

function MediaSection({ piece }: { piece: ContentPiece }) {
  const t = useTranslations('maquina');
  const media = orderedMedia(piece.media);
  const videos = media.filter((m) => m.kind === 'video');
  const images = media.filter((m) => m.kind === 'image');

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('piece.media')}</SectionTitle>
      {media.length === 0 ? <p className="text-compact text-graphite">{t('piece.noMedia')}</p> : null}
      {videos.map((v) => (
        <video
          key={v.mediaId}
          src={v.url}
          controls
          preload="metadata"
          aria-label={t('piece.videoLabel')}
          className="max-h-[70dvh] w-full rounded-control border border-line bg-night"
        />
      ))}
      {images.length > 0 ? (
        <ol className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
          {images.map((img, i) => (
            <li key={img.mediaId} className="flex w-60 shrink-0 snap-start flex-col gap-1">
              <a
                href={img.url}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-control border border-line bg-surface-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <img
                  src={img.url}
                  alt={t('piece.imageAlt', { n: i + 1 })}
                  loading="lazy"
                  className="h-auto w-full"
                />
              </a>
              {images.length > 1 ? (
                <span className="text-meta tabular-nums text-graphite">
                  {t('piece.slideOf', { n: i + 1, total: images.length })}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ legenda

function CaptionSection({
  piece,
  drafts,
  setDrafts,
}: {
  piece: ContentPiece;
  /** rascunho POR CAMPO: só o que a pessoa mexeu; o resto mostra o servidor (e acompanha o polling) */
  drafts: CaptionDrafts;
  setDrafts: Dispatch<SetStateAction<CaptionDrafts>>;
}) {
  const t = useTranslations('maquina');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();
  const edit = useEditPiece();
  const lock = captionLock(piece);
  const dirty = Object.keys(drafts).length > 0;
  // etapa rodando é passageiro: com rascunho aberto o formulário fica montado (só leitura), para não
  // perder foco nem o texto; as outras travas mostram o texto final
  const transitorio = lock === 'running' && dirty;
  // durante o salvamento os campos não mudam: voltar ao valor antigo no meio perderia a edição
  const somenteLeitura = transitorio || edit.isPending;

  if (lock !== null && !transitorio) {
    return (
      <section className="flex flex-col gap-3">
        <SectionTitle>{t('piece.caption')}</SectionTitle>
        {lock !== 'closed' ? (
          <p className="text-meta leading-relaxed text-graphite">{t(`piece.locked.${lock}`)}</p>
        ) : null}
        <p className="whitespace-pre-wrap text-compact leading-relaxed text-ink">
          {piece.caption || t('piece.noCaption')}
        </p>
        {piece.hashtags.length > 0 ? (
          <p className="text-compact text-accent">{formatHashtags(piece.hashtags)}</p>
        ) : null}
        <p className="text-meta tabular-nums text-graphite">
          {t('piece.scheduledFor')}:{' '}
          {piece.scheduledFor
            ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(piece.scheduledFor),
              )
            : t('piece.noDate')}
        </p>
      </section>
    );
  }

  const server = captionValues(piece);
  const value = shownValues(drafts, server);
  const change = (field: CaptionField, next: string) => {
    if (somenteLeitura) return;
    setDrafts((d) => editDraft(d, field, next, server));
  };
  const stale = staleFields(drafts, server);
  // o limite do Instagram vale para o texto publicado inteiro, não só para a legenda
  const total = publishedText(value.caption, parseHashtags(value.hashtags)).length;
  const over = total - CAPTION_TOTAL_MAX;
  const fieldLabel: Record<CaptionField, string> = {
    caption: t('piece.caption'),
    hashtags: t('piece.hashtags'),
    date: t('piece.scheduledFor'),
  };

  // a recusa do total (400) chega com o código genérico de post, cuja tradução fala de "canais";
  // nesse caso o texto da API (que diz o total) é mais útil. 409 cai no padrão: detalhe da API.
  const saveError = (err: unknown) => {
    const detail = (err as ApiProblem | undefined)?.detail;
    return errorCode(err) === 'post.invalid_settings' && detail ? detail : errorMessage(err);
  };

  const save = () => {
    const sent = drafts;
    edit.mutate(
      { id: piece.id, patch: captionPatch(sent) },
      {
        onSuccess: (saved) => {
          setDrafts((d) => clearSaved(d, sent, captionValues(saved)));
          toast.success(t('piece.saved'));
        },
        onError: (err) => toast.error(saveError(err)),
      },
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('piece.caption')}</SectionTitle>
      {transitorio ? <p className="text-meta leading-relaxed text-graphite">{t('piece.locked.running')}</p> : null}
      {stale.length > 0 ? (
        <Alert>
          <CircleAlert aria-hidden />
          <div className="flex flex-col gap-2">
            <AlertTitle>{t('piece.staleTitle')}</AlertTitle>
            <AlertDescription>
              {t('piece.stale', {
                fields: new Intl.ListFormat(locale, { type: 'conjunction' }).format(stale.map((f) => fieldLabel[f])),
              })}
            </AlertDescription>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setDrafts((d) => dropFields(d, stale))}>
                {t('piece.discardDraft')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDrafts((d) => rebaseFields(d, stale, server))}>
                {t('piece.keepDraft')}
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}
      <Textarea
        aria-label={t('piece.caption')}
        aria-describedby="cm-piece-total"
        aria-invalid={over > 0 || undefined}
        value={value.caption}
        onChange={(e) => change('caption', e.target.value)}
        readOnly={somenteLeitura}
        placeholder={t('piece.noCaption')}
        maxLength={CAPTION_TOTAL_MAX}
        className="min-h-40"
      />
      <div id="cm-piece-total" className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-meta">
          <span className="text-graphite">{t('piece.totalHint')}</span>
          <span className={over > 0 ? 'font-medium tabular-nums text-state-failed' : 'tabular-nums text-graphite'}>
            {t('piece.total', { count: total, max: CAPTION_TOTAL_MAX })}
          </span>
        </div>
        {over > 0 ? (
          <p className="text-meta leading-relaxed text-state-failed">{t('piece.totalOver', { over })}</p>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cm-piece-hashtags" label={t('piece.hashtags')} hint={t('piece.hashtagsHint')}>
          <Input
            id="cm-piece-hashtags"
            value={value.hashtags}
            onChange={(e) => change('hashtags', e.target.value)}
            readOnly={somenteLeitura}
          />
        </Field>
        <Field id="cm-piece-date" label={t('piece.scheduledFor')} hint={value.date ? undefined : t('piece.noDate')}>
          <DateTimePicker id="cm-piece-date" value={value.date} onChange={(date) => change('date', date)} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="outline" onClick={save} disabled={!dirty || over > 0 || transitorio} isLoading={edit.isPending}>
          {t('piece.save')}
        </Button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ roteiro

function ScriptSection({ piece }: { piece: ContentPiece }) {
  const t = useTranslations('maquina');
  const script = readScript(piece.script);
  const topo = script
    ? ([
        ['hook', script.hook],
        ['story', script.story],
        ['offer', script.offer],
      ] as const).filter(([, v]) => v.trim())
    : [];

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('piece.script')}</SectionTitle>
      {!script ? <p className="text-compact text-graphite">{t('piece.scriptEmpty')}</p> : null}
      {topo.length > 0 ? (
        <dl className="flex flex-col gap-3">
          {topo.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1">
              <dt className="text-meta font-medium text-graphite">{t(`piece.${k}`)}</dt>
              <dd className="whitespace-pre-wrap text-compact leading-relaxed text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {script && script.slides.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {script.slides.map((s) => (
            <li key={s.ordem} className="flex flex-col gap-1 rounded-control border border-line p-3">
              <span className="text-meta font-medium text-graphite">
                {t('piece.slideLabel', { n: s.ordem })}
                {s.tipo ? ` · ${s.tipo}` : ''}
              </span>
              {s.titulo ? <span className="text-compact font-medium text-ink">{s.titulo}</span> : null}
              {s.texto ? <span className="whitespace-pre-wrap text-compact leading-relaxed text-ink">{s.texto}</span> : null}
              {s.itens.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-4 text-compact text-ink">
                  {s.itens.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {script && script.cenas.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {script.cenas.map((c) => (
            <li key={c.ordem} className="flex flex-col gap-2 rounded-control border border-line p-3">
              <span className="text-meta font-medium tabular-nums text-graphite">
                {t('piece.sceneLabel', { n: c.ordem, seconds: c.duracao })}
              </span>
              <dl className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
                <dt className="text-meta font-medium text-graphite">{t('piece.voiceover')}</dt>
                <dd className="text-compact leading-relaxed text-ink">{c.locucao}</dd>
                {c.textoTela ? (
                  <>
                    <dt className="text-meta font-medium text-graphite">{t('piece.onScreen')}</dt>
                    <dd className="text-compact leading-relaxed text-ink">{c.textoTela}</dd>
                  </>
                ) : null}
                <dt className="text-meta font-medium text-graphite">{t('piece.visual')}</dt>
                <dd className="text-compact leading-relaxed text-graphite">{c.visual}</dd>
              </dl>
            </li>
          ))}
        </ol>
      ) : null}
      {script && script.pendencias.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-control bg-state-review-tint p-3">
          <span className="text-meta font-medium text-state-review">{t('piece.pending')}</span>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-compact text-ink">
            {script.pendencias.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ revisão

function ReviewSection({ piece }: { piece: ContentPiece }) {
  const t = useTranslations('maquina');
  const review = piece.review;
  if (!review) return null;
  const lint = review.lint ?? [];

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('piece.review')}</SectionTitle>
      <p className={review.aprovado ? 'text-compact text-state-published' : 'text-compact text-state-review'}>
        {review.aprovado ? t('piece.reviewApproved') : t('piece.reviewHeld')}
        {review.motivo ? ` ${review.motivo}` : ''}
      </p>
      {review.flags.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-meta font-medium text-graphite">{t('piece.flags')}</span>
          <ul className="flex flex-col gap-2">
            {review.flags.map((f, i) => (
              <li key={`${f.codigo}-${i}`} className="flex flex-col gap-1 rounded-control border border-line p-3">
                <Badge variant="review" className="w-fit">
                  {f.codigo}
                </Badge>
                {f.trecho ? <q className="text-compact italic text-ink">{f.trecho}</q> : null}
                {f.motivo ? <span className="text-compact leading-relaxed text-graphite">{f.motivo}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {lint.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-meta font-medium text-graphite">{t('piece.lint')}</span>
          <ul className="flex flex-col gap-2">
            {lint.map((f, i) => (
              <li key={`${f.codigo}-${i}`} className="flex flex-wrap items-start gap-2">
                <Badge variant={f.nivel === 'erro' ? 'failed' : 'review'}>{t(`piece.lintLevel.${f.nivel}`)}</Badge>
                <span className="min-w-0 flex-1 text-compact leading-relaxed text-ink">
                  <span className="font-medium">{f.codigo}</span> · {f.msg}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ ajustes e histórico

function FeedbackSection({ piece }: { piece: ContentPiece }) {
  const t = useTranslations('maquina');
  const locale = useLocale();
  if (piece.feedback.length === 0) return null;
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('piece.feedback')}</SectionTitle>
      <ul className="flex flex-col gap-2">
        {[...piece.feedback].reverse().map((f) => (
          <li key={`${f.at}-${f.stage}`} className="flex flex-col gap-1 rounded-control bg-surface-2 p-3">
            <span className="text-meta tabular-nums text-graphite">
              {t.has(`piece.feedbackStage.${f.stage}`) ? t(`piece.feedbackStage.${f.stage}`) : f.stage} ·{' '}
              {fmt.format(new Date(f.at))}
            </span>
            <span className="whitespace-pre-wrap text-compact leading-relaxed text-ink">{f.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** motivo/erro gravado no evento, quando é texto */
function eventNote(e: ContentPieceEvent): string | null {
  for (const k of ['motivo', 'erro', 'error']) {
    const v = e.detail[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function EventsSection({ events }: { events: ContentPieceEvent[] }) {
  const t = useTranslations('maquina');
  const locale = useLocale();
  if (events.length === 0) return null;
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const label = (s: string | null) => (s && t.has(`status.${s}`) ? t(`status.${s}`) : (s ?? '—'));
  const ordered = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('piece.events')}</SectionTitle>
      <ol className="flex flex-col border-l border-line">
        {ordered.map((e) => {
          const note = eventNote(e);
          return (
            <li key={e.id} className="flex flex-col gap-1 py-2 pl-4">
              <span className="text-compact text-ink">
                {e.fromStatus ? `${label(e.fromStatus)} → ` : ''}
                {label(e.toStatus)}
              </span>
              <span className="text-meta tabular-nums text-graphite">
                {e.stage} · {fmt.format(new Date(e.createdAt))}
              </span>
              {note ? <span className="text-meta leading-relaxed text-graphite">{note}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ decisões

type Pedido = { tipo: 'redo'; stage: 'roteiro' | 'producao' } | { tipo: 'reject' };

function PieceActions({
  piece,
  publicationState,
  unsaved,
  onDiscard,
}: {
  piece: ContentPiece;
  publicationState: string | null;
  unsaved: boolean;
  onDiscard: () => void;
}) {
  const t = useTranslations('maquina');
  const errorMessage = useApiErrorMessage();
  const decide = useDecidePiece();
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [link, setLink] = useState('');
  const actions = actionsFor(piece, publicationState);

  if (needsPublicationCheck(piece, publicationState)) {
    const resolver = (published: boolean) =>
      decide.mutate(
        {
          id: piece.id,
          decision: { action: 'resolvePublication', published, ...(published && link.trim() ? { permalink: link.trim() } : {}) },
        },
        {
          onSuccess: () => toast.success(published ? t('actions.resolvedPublished') : t('actions.resolvedNotPublished')),
          onError: (err) => toast.error(errorMessage(err)),
        },
      );
    return (
      <SheetFooter className="flex-col items-stretch gap-3 sm:flex-col">
        <p className="text-compact leading-relaxed text-ink">{t('actions.resolveHint')}</p>
        <Field id="cm-piece-permalink" label={t('actions.permalinkLabel')} hint={t('actions.permalinkHint')}>
          <Input
            id="cm-piece-permalink"
            type="url"
            inputMode="url"
            placeholder="https://www.instagram.com/p/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => resolver(false)} disabled={decide.isPending}>
            {t('actions.notPublished')}
          </Button>
          <Button onClick={() => resolver(true)} disabled={decide.isPending} isLoading={decide.isPending}>
            {t('actions.published')}
          </Button>
        </div>
      </SheetFooter>
    );
  }
  if (actions.length === 0) return null;

  const redoProductionLabel = piece.format === 'reels' ? t('actions.redoVideo') : t('actions.redoArt');
  const label: Record<PieceAction, string> = {
    approve: t('actions.approve'),
    retry: t('actions.retry'),
    redoScript: t('actions.redoScript'),
    redoProduction: redoProductionLabel,
    reject: t('actions.reject'),
  };
  const done: Record<PieceDecision['action'], string> = {
    approve: t('actions.approved'),
    retry: t('actions.retried'),
    redo: t('actions.redone'),
    reject: t('actions.rejected'),
    resolvePublication: t('actions.resolvedPublished'),
  };

  const send = (decision: PieceDecision) =>
    decide.mutate(
      { id: piece.id, decision },
      {
        onSuccess: () => {
          toast.success(done[decision.action]);
          setPedido(null);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  const run = (a: PieceAction) => {
    if (a === 'approve') send({ action: 'approve' });
    else if (a === 'retry') send({ action: 'retry' });
    else if (a === 'redoScript') setPedido({ tipo: 'redo', stage: 'roteiro' });
    else if (a === 'redoProduction') setPedido({ tipo: 'redo', stage: 'producao' });
    else setPedido({ tipo: 'reject' });
  };

  return (
    <SheetFooter className="sm:flex-wrap">
      {unsaved ? (
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <p className="text-meta leading-relaxed text-graphite">{t('piece.unsavedBeforeDecision')}</p>
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            {t('piece.discardDraft')}
          </Button>
        </div>
      ) : null}
      {actions.map((a) => (
        <Button
          key={a}
          variant={a === 'approve' || a === 'retry' ? 'primary' : 'outline'}
          className={a === 'reject' ? 'text-state-failed' : undefined}
          onClick={() => run(a)}
          disabled={decide.isPending || unsaved}
          isLoading={decide.isPending && (a === 'approve' || a === 'retry') && pedido === null}
        >
          {label[a]}
        </Button>
      ))}
      <DecisionDialog
        pedido={pedido}
        redoTitle={pedido?.tipo === 'redo' && pedido.stage === 'producao' ? redoProductionLabel : t('actions.redoScript')}
        pending={decide.isPending}
        onClose={() => setPedido(null)}
        onSubmit={(text) => {
          if (!pedido) return;
          if (pedido.tipo === 'redo') send({ action: 'redo', stage: pedido.stage, feedback: text });
          else send({ action: 'reject', ...(text ? { reason: text } : {}) });
        }}
      />
    </SheetFooter>
  );
}

/** Refazer exige dizer o que muda; reprovar aceita um motivo opcional. */
function DecisionDialog({
  pedido,
  redoTitle,
  pending,
  onClose,
  onSubmit,
}: {
  pedido: Pedido | null;
  redoTitle: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  return (
    <Dialog open={pedido !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        {/* o formulário só monta com o diálogo aberto: cada pedido começa com o texto vazio */}
        {pedido ? (
          <DecisionForm
            redo={pedido.tipo === 'redo'}
            redoTitle={redoTitle}
            pending={pending}
            onClose={onClose}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DecisionForm({
  redo,
  redoTitle,
  pending,
  onClose,
  onSubmit,
}: {
  redo: boolean;
  redoTitle: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const [text, setText] = useState('');
  const valid = !redo || text.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(text.trim());
      }}
    >
      <DialogHeader>
        <DialogTitle>{redo ? redoTitle : t('actions.rejectTitle')}</DialogTitle>
        <DialogDescription>{redo ? t('actions.redoDescription') : t('actions.rejectDescription')}</DialogDescription>
      </DialogHeader>
      <Field id="cm-decision-text" label={redo ? t('actions.feedback') : t('actions.reason')} optional={!redo}>
        <Textarea
          id="cm-decision-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={redo ? t('actions.feedbackPlaceholder') : t('actions.reasonPlaceholder')}
          maxLength={redo ? 2000 : 500}
          required={redo}
          autoFocus
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tc('cancel')}
        </Button>
        <Button type="submit" variant={redo ? 'primary' : 'destructive'} disabled={!valid} isLoading={pending}>
          {redo ? t('actions.redoSubmit') : t('actions.rejectSubmit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
