'use client';

import { useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BLOCKS, SOON } from './next-step-menu';
import type { BlockKind } from './logic';

export const DRAG_MIME = 'application/x-manypost-block';

/** paleta compacta de ícones: clicar insere no centro; arrastar insere onde soltar */
export function Dock({ onAdd }: { onAdd: (kind: BlockKind) => void }) {
  const t = useTranslations('automation.flow');
  return (
    <TooltipProvider delayDuration={150}>
    <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-control border border-line bg-surface p-1">
      {BLOCKS.map((b) => (
        <Tooltip key={b.kind}>
          <TooltipTrigger asChild>
            <button
              type="button"
              draggable
              aria-label={t(`block.${b.kind}`)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, b.kind);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(b.kind)}
              className="flex size-10 cursor-pointer items-center justify-center rounded-compact text-ink transition-colors duration-200 hover:bg-surface-2 hover:text-accent"
            >
              <b.icon className="size-5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t(`block.${b.kind}`)}</TooltipContent>
        </Tooltip>
      ))}
      {SOON.map((s) => (
        <Tooltip key={s.key}>
          <TooltipTrigger asChild>
            <span className="flex size-10 items-center justify-center text-mist" aria-label={`${t(`block.${s.key}`)} (${t('soon')})`}>
              <s.icon className="size-5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            {t(`block.${s.key}`)} — {t('soon')}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
    </TooltipProvider>
  );
}
