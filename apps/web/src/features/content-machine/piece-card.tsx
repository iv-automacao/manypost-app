'use client';

import { Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { coverOf, flagsCount, formatUsd } from './logic';
import type { ContentPiece } from './types';

/**
 * Card de uma peça. É um único `<button>` (sem controles internos): toda ação acontece no
 * detalhe, então não há checkbox ou menu que tornariam a marcação inválida. Por isso o conteúdo
 * usa só elementos de frase (`span`), nunca `p`/`div`.
 */
export function PieceCard({ piece, onOpen }: { piece: ContentPiece; onOpen: (id: string) => void }) {
  const t = useTranslations('maquina');
  const locale = useLocale();
  const cover = coverOf(piece);
  const flags = flagsCount(piece);
  const quando = piece.scheduledFor
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
        new Date(piece.scheduledFor),
      )
    : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(piece.id)}
      className="flex w-full cursor-pointer flex-col gap-2 rounded-card border border-line bg-surface p-3 text-left outline-none transition-colors duration-200 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="flex items-center justify-between gap-2">
        <Badge variant="accent">{t(`format.${piece.format}`)}</Badge>
        <span className="truncate text-meta font-medium tabular-nums text-graphite">{piece.keyword}</span>
      </span>

      {cover ? (
        cover.kind === 'video' ? (
          <span className="relative block aspect-preview w-full overflow-hidden rounded-control bg-surface-2">
            {/* preload=metadata desenha o primeiro quadro como capa */}
            <video src={cover.url} muted preload="metadata" className="size-full object-cover" aria-label={t('card.video')} />
            <span className="absolute bottom-1.5 right-1.5 grid size-5 place-items-center rounded-key bg-night/60">
              <Play className="size-3 text-paper" aria-hidden />
            </span>
          </span>
        ) : (
          <span className="block aspect-preview w-full overflow-hidden rounded-control bg-surface-2">
            <img src={cover.url} alt="" loading="lazy" className="size-full object-cover" />
          </span>
        )
      ) : null}

      <span className="line-clamp-3 text-compact leading-relaxed text-ink">{piece.hook || '…'}</span>

      {piece.status === 'erro' && piece.error ? (
        <span className="line-clamp-2 text-meta leading-relaxed text-state-failed">{piece.error}</span>
      ) : null}

      <span className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {piece.running ? (
            <span className="flex items-center gap-1 text-meta font-medium text-accent">
              <span className="size-2 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none" aria-hidden />
              {t('card.running')}
            </span>
          ) : null}
          {piece.status === 'revisao' && flags > 0 ? <Badge variant="review">{t('card.flags', { count: flags })}</Badge> : null}
          {quando ? <span className="text-meta tabular-nums text-graphite">{quando}</span> : null}
        </span>
        <span className="text-meta tabular-nums text-graphite">{formatUsd(piece.costUsd, locale)}</span>
      </span>
    </button>
  );
}
