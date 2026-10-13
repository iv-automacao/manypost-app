'use client';

import { Clock, Flag, GitBranch, ImageIcon, Link2, MessageSquare, TextCursorInput, UserPlus, Zap, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import type { BlockKind } from './logic';

export const BLOCKS: Array<{ kind: BlockKind; icon: LucideIcon }> = [
  { kind: 'message', icon: MessageSquare },
  { kind: 'question', icon: TextCursorInput },
  { kind: 'condition', icon: GitBranch },
  { kind: 'link', icon: Link2 },
  { kind: 'follow', icon: UserPlus },
  { kind: 'end', icon: Flag },
];
/** blocos das entregas 3 e 4 — aparecem desabilitados */
export const SOON: Array<{ key: 'delay' | 'media' | 'action'; icon: LucideIcon }> = [
  { key: 'delay', icon: Clock },
  { key: 'media', icon: ImageIcon },
  { key: 'action', icon: Zap },
];

export function NextStepMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick: (k: BlockKind) => void; onClose: () => void }) {
  const t = useTranslations('automation.flow');
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 380);
  return (
    <>
      <button type="button" aria-label={t('close')} className="fixed inset-0 z-40 cursor-pointer" onClick={onClose} />
      <div role="menu" aria-label={t('nextStep')} className="fixed z-50 flex w-56 flex-col gap-1 rounded-control border border-line-strong bg-surface p-2" style={{ left, top }}>
        <p className="px-2 py-1 text-meta font-medium text-graphite">{t('nextStep')}</p>
        {BLOCKS.map((b) => (
          <button
            key={b.kind}
            type="button"
            role="menuitem"
            onClick={() => onPick(b.kind)}
            className="flex cursor-pointer items-center gap-2 rounded-compact px-2 py-1.5 text-left text-compact text-ink transition-colors duration-200 hover:bg-surface-2"
          >
            <b.icon className="size-4 text-accent" aria-hidden />
            {t(`block.${b.kind}`)}
          </button>
        ))}
        {SOON.map((s) => (
          <span key={s.key} className="flex items-center gap-2 px-2 py-1.5 text-compact text-mist" aria-disabled>
            <s.icon className="size-4" aria-hidden />
            {t(`block.${s.key}`)}
            <span className="ml-auto text-meta">{t('soon')}</span>
          </span>
        ))}
      </div>
    </>
  );
}
