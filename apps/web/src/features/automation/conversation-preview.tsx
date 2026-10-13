'use client';

import { ExternalLink, MessageCircle, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { type Draft, previewConversation } from './logic';

/**
 * Pré-visualização da conversa (exceção representacional nomeada: imita o Instagram, não o produto).
 * Mostra exatamente o que a pessoa recebe — inclusive o aviso de mensagem automática.
 */
export function ConversationPreview({ draft, account }: { draft: Draft; account: string }) {
  const t = useTranslations('automation');
  const bubbles = previewConversation(draft, { disclosure: t('disclosureText'), textModeHint: t('textModeHint') });
  const comment = bubbles.filter((b) => b.side === 'comment' || b.side === 'reply');
  const direct = bubbles.filter((b) => b.side === 'brand' || b.side === 'user');

  return (
    <Card className="flex flex-col gap-4 p-5" aria-label={t('previewTitle')}>
      <div className="flex flex-col gap-1">
        <h3 className="text-panel font-medium text-ink">{t('previewTitle')}</h3>
        <p className="text-meta text-graphite">{t('previewHint')}</p>
      </div>

      <section className="flex flex-col gap-2" aria-label={t('previewComments')}>
        <p className="flex items-center gap-1.5 text-meta font-medium text-graphite">
          <MessageCircle className="size-3.5" aria-hidden />
          {t('previewComments')}
        </p>
        {comment.map((b, i) => (
          <div key={i} className={cn('flex flex-col gap-0.5', b.side === 'reply' && 'pl-6')}>
            <span className="text-meta font-semibold text-ink">{b.side === 'comment' ? '@cliente' : account}</span>
            <span className="whitespace-pre-line text-compact text-ink">{b.text}</span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4" aria-label={t('previewDirect')}>
        <p className="flex items-center gap-1.5 text-meta font-medium text-graphite">
          <Send className="size-3.5" aria-hidden />
          {t('previewDirect')}
        </p>
        <ol className="flex flex-col gap-2">
          {direct.map((b, i) => (
            <li key={i} className={cn('flex max-w-[85%] flex-col gap-1.5', b.side === 'user' ? 'self-end items-end' : 'self-start')}>
              <span
                className={cn(
                  'whitespace-pre-line rounded-card px-3 py-2 text-compact',
                  b.side === 'user' ? 'bg-accent-tint text-ink' : 'bg-surface-2 text-ink',
                )}
              >
                {b.text}
              </span>
              {b.buttons?.length ? (
                <span className="flex w-full flex-col gap-1">
                  {b.buttons.map((title, j) => (
                    <span
                      key={j}
                      className="flex items-center justify-center gap-1 rounded-compact border border-line bg-surface px-3 py-1.5 text-meta font-medium text-accent"
                    >
                      {title}
                      {b.link ? <ExternalLink className="size-3" aria-hidden /> : null}
                    </span>
                  ))}
                </span>
              ) : null}
              {b.chips?.length ? (
                <span className="flex flex-wrap gap-1">
                  {b.chips.map((title, j) => (
                    <span key={j} className="rounded-compact border border-line-strong px-2.5 py-1 text-meta text-ink">
                      {title}
                    </span>
                  ))}
                </span>
              ) : null}
              {b.chips?.length ? <span className="text-meta text-graphite">{t('chipsWarning')}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
