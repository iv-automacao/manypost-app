'use client';

import { Plus, Workflow } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useChannels } from '@/features/channels/hooks';
import { useApiErrorMessage } from '@/lib/api/errors';
import { relativeTime } from '@/lib/datetime';
import { useAutomations } from './hooks';
import { statusVariant } from './logic';

export function AutomationsView() {
  const t = useTranslations('automation');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();
  const automations = useAutomations();
  const channels = useChannels();
  const handle = (channelId: string) => {
    const c = channels.data?.find((x) => x.id === channelId);
    return c?.username ? `@${c.username}` : (c?.name ?? '');
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Button asChild>
            <Link href="/automacoes/nova">
              <Plus aria-hidden />
              {t('new')}
            </Link>
          </Button>
        }
      />
      {automations.isPending ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : automations.isError ? (
        <p className="text-compact text-state-failed">{errorMessage(automations.error)}</p>
      ) : automations.data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-surface-2 px-6 py-16 text-center">
          <Workflow className="size-8 text-mist" aria-hidden />
          <p className="max-w-md text-compact leading-relaxed text-graphite">{t('empty')}</p>
          <Button asChild variant="outline" size="sm">
            <Link href="/automacoes/nova">{t('new')}</Link>
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {automations.data.items.map((a) => {
            const keywords = a.triggers[0]?.config.keywords ?? [];
            const media = a.triggers[0]?.config.mediaIds ?? [];
            const blocks = a.flow?.nodes.length ?? 0;
            return (
              <li key={a.id}>
                <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/automacoes/${a.id}`}
                        className="text-panel font-medium text-ink outline-none hover:text-accent focus-visible:underline"
                      >
                        {a.name}
                      </Link>
                      <Badge variant={statusVariant(a.status)}>{t(`status.${a.status}`)}</Badge>
                    </div>
                    <p className="text-meta text-graphite">
                      {[
                        handle(a.channelId),
                        media.length ? t('summaryPosts', { count: media.length }) : t('summaryAnyPost'),
                        keywords.length ? t('summaryKeywords', { list: keywords.slice(0, 3).join(', ') }) : t('summaryAnyComment'),
                        t('summaryBlocks', { count: blocks }),
                        t('updated', { when: relativeTime(a.updatedAt, locale) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {a.flow === null ? <p className="text-meta text-state-failed">{t('invalidConfig')}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/leads?automacao=${a.id}`}>{t('seeLeads')}</Link>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/automacoes/${a.id}`}>{t('edit')}</Link>
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
