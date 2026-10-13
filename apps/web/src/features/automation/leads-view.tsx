'use client';

import { Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiErrorMessage } from '@/lib/api/errors';
import { relativeTime } from '@/lib/datetime';
import { useAutomations, useLeads } from './hooks';
import { RUN_STATUSES, type RunStatus, answerEntries, runStatusVariant } from './logic';

const ALL = 'all';

export function LeadsView() {
  const t = useTranslations('leads');
  const ta = useTranslations('automation');
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const errorMessage = useApiErrorMessage();
  const automationId = params.get('automacao') ?? undefined;
  const statusParam = params.get('status');
  const status = (RUN_STATUSES as readonly string[]).includes(statusParam ?? '') ? (statusParam as RunStatus) : undefined;
  const automations = useAutomations();
  const leads = useLeads({ ...(automationId ? { automationId } : {}), ...(status ? { status } : {}) });

  const setFilter = (key: 'automacao' | 'status', value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) next.delete(key);
    else next.set(key, value);
    router.replace(`/leads${next.size ? `?${next.toString()}` : ''}`);
  };
  const order = (id: string) => {
    const a = automations.data?.items.find((x) => x.id === id);
    return a?.flow?.nodes.flatMap((n) => (n.type === 'question' ? [n.data.field] : [])) ?? [];
  };
  const items = leads.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Select value={automationId ?? ALL} onValueChange={(v) => setFilter('automacao', v)}>
              <SelectTrigger className="w-56" aria-label={t('filterAutomation')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('allAutomations')}</SelectItem>
                {automations.data?.items.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status ?? ALL} onValueChange={(v) => setFilter('status', v)}>
              <SelectTrigger className="w-44" aria-label={t('filterStatus')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('allStatuses')}</SelectItem>
                {RUN_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`status.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {leads.isPending ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : leads.isError ? (
        <p className="text-compact text-state-failed">{errorMessage(leads.error)}</p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-surface-2 px-6 py-16 text-center">
          <Users className="size-8 text-mist" aria-hidden />
          <p className="max-w-md text-compact leading-relaxed text-graphite">{t('empty')}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((l) => {
            const answers = answerEntries(l.answers, order(l.automationId));
            return (
              <li key={l.id}>
                <Card className="flex flex-col gap-3 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-compact font-semibold text-ink">
                        {l.participantUsername ? `@${l.participantUsername}` : t('unknownUser')}
                      </span>
                      <Badge variant={runStatusVariant(l.status)}>{t(`status.${l.status}`)}</Badge>
                    </div>
                    <span className="text-meta text-graphite">
                      {[l.automationName ?? ta('deleted'), relativeTime(l.createdAt, locale)].join(' · ')}
                    </span>
                  </div>
                  <p className="text-meta text-graphite">
                    {t('comment')}: <span className="text-ink">{l.commentText || '—'}</span>
                  </p>
                  {answers.length ? (
                    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {answers.map(([k, v]) => (
                        <div key={k} className="flex min-w-0 gap-2 text-compact">
                          <dt className="shrink-0 text-graphite">{k}</dt>
                          <dd className="min-w-0 truncate text-ink">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-meta text-graphite">{t('noAnswers')}</p>
                  )}
                  {l.lastError && l.status !== 'COMPLETED' ? (
                    <p className="text-meta text-state-failed">{l.lastError}</p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {leads.hasNextPage ? (
        <Button variant="outline" size="sm" onClick={() => void leads.fetchNextPage()} isLoading={leads.isFetchingNextPage}>
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
