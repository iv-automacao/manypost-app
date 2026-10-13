'use client';

import { Check, ImageIcon, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentMedia } from '@/features/engagement/hooks';
import { captionPreview } from '@/features/engagement/logic';
import { EngagementError } from '@/features/engagement/shared';
import { cn } from '@/lib/utils';
import { LIMITS, splitKeywords, splitUsernames } from '../logic';
import type { TriggerConfig } from './logic';

/** seletor de posts recentes (movido do editor antigo, sem mudança de comportamento) */
function MediaPicker({
  channelId,
  selected,
  onToggle,
}: {
  channelId: string;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const t = useTranslations('automation');
  const te = useTranslations('engagement');
  const media = useRecentMedia(channelId);
  if (media.isPending) return <Skeleton className="h-32 rounded-lg" />;
  if (media.isError) return <EngagementError error={media.error} onRetry={() => void media.refetch()} />;
  const items = media.data.pages.flatMap((p) => p.items);
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {items.map((m) => {
          const on = selected.includes(m.id);
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onToggle(m.id)}
                aria-pressed={on}
                title={captionPreview(m.caption, 80) || te('noCaption')}
                className={cn(
                  'relative flex aspect-square w-full cursor-pointer items-center justify-center overflow-hidden rounded-compact border-2 bg-surface-2 outline-none transition-colors duration-200',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  on ? 'border-accent' : 'border-transparent hover:border-line-strong',
                )}
              >
                {m.previewUrl ? (
                  <img src={m.previewUrl} alt="" className="size-full object-cover" />
                ) : (
                  <ImageIcon className="size-5 text-mist" aria-hidden />
                )}
                {on ? (
                  <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-compact bg-accent text-paper">
                    <Check className="size-3.5" aria-hidden />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-meta text-graphite">{t('mediaSelected', { count: selected.length })}</span>
        {media.hasNextPage ? (
          <Button variant="outline" size="sm" onClick={() => void media.fetchNextPage()} isLoading={media.isFetchingNextPage}>
            {te('loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function TriggerPanel({
  open,
  onOpenChange,
  channelId,
  trigger,
  testUsernames,
  onTrigger,
  onTestUsernames,
  onSeal,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channelId: string;
  trigger: TriggerConfig;
  testUsernames: string[];
  onTrigger: (t: TriggerConfig, opts?: { merge?: boolean }) => void;
  onTestUsernames: (list: string[]) => void;
  onSeal: () => void;
}) {
  const t = useTranslations('automation.flow');
  const [keywords, setKeywords] = useState(trigger.keywords.join(', '));
  const [testers, setTesters] = useState(testUsernames.map((u) => `@${u}`).join(', '));
  // desfazer/refazer troca o gatilho por fora: o texto local acompanha, a não ser que a pessoa esteja digitando
  const kwKey = trigger.keywords.join(', ');
  const testKey = testUsernames.map((u) => `@${u}`).join(', ');
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (focused.current !== 'keywords') setKeywords(kwKey);
  }, [kwKey]);
  useEffect(() => {
    if (focused.current !== 'testers') setTesters(testKey);
  }, [testKey]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('trigger.title')}</SheetTitle>
          <SheetDescription>{t('trigger.description')}</SheetDescription>
        </SheetHeader>
        <section className="flex flex-col gap-2">
          <h3 className="text-compact font-medium text-ink">{t('trigger.media')}</h3>
          <p className="text-meta text-graphite">{t('trigger.mediaHint')}</p>
          <MediaPicker
            channelId={channelId}
            selected={trigger.mediaIds}
            onToggle={(id) =>
              onTrigger({
                ...trigger,
                mediaIds: trigger.mediaIds.includes(id) ? trigger.mediaIds.filter((x) => x !== id) : [...trigger.mediaIds, id],
              })
            }
          />
        </section>
        <Label className="flex flex-col gap-1 text-compact">
          {t('trigger.keywords')}
          <Input
            value={keywords}
            onFocus={() => (focused.current = 'keywords')}
            onChange={(e) => setKeywords(e.target.value)}
            onBlur={() => {
              focused.current = null;
              onTrigger({ ...trigger, keywords: splitKeywords(keywords) });
              onSeal();
            }}
          />
          <span className="text-meta text-graphite">{t('trigger.keywordsHint')}</span>
        </Label>
        <section className="flex flex-col gap-2">
          <h3 className="text-compact font-medium text-ink">{t('trigger.publicReplies')}</h3>
          <p className="text-meta text-graphite">{t('trigger.publicRepliesHint')}</p>
          {trigger.publicReplies.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r}
                maxLength={LIMITS.publicReply}
                onChange={(e) =>
                  onTrigger({ ...trigger, publicReplies: trigger.publicReplies.map((x, j) => (j === i ? e.target.value : x)) }, { merge: true })
                }
                onBlur={onSeal}
              />
              <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={() => onTrigger({ ...trigger, publicReplies: trigger.publicReplies.filter((_, j) => j !== i) })}>
                <X aria-hidden />
              </Button>
            </div>
          ))}
          {trigger.publicReplies.length < LIMITS.maxPublicReplies ? (
            <Button variant="outline" size="sm" className="self-start" onClick={() => onTrigger({ ...trigger, publicReplies: [...trigger.publicReplies, ''] })}>
              <Plus aria-hidden />
              {t('trigger.addReply')}
            </Button>
          ) : null}
        </section>
        <Label className="flex flex-col gap-1 text-compact">
          {t('trigger.testUsers')}
          <Input
            value={testers}
            onFocus={() => (focused.current = 'testers')}
            onChange={(e) => setTesters(e.target.value)}
            onBlur={() => {
              focused.current = null;
              onTestUsernames(splitUsernames(testers));
              onSeal();
            }}
          />
          <span className="text-meta text-graphite">{t('trigger.testUsersHint')}</span>
        </Label>
      </SheetContent>
    </Sheet>
  );
}
