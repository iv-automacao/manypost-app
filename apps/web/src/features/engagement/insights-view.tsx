'use client';

import { BarChart3, Eye, Heart, Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { components } from '@/lib/api/schema';
import { relativeTime } from '@/lib/datetime';
import type { IconType } from '@/types';
import { useAccountInsights, useMediaInsights } from './hooks';
import {
  ACCOUNT_METRIC_KEYS,
  MEDIA_METRIC_KEYS,
  PERIODS,
  type Period,
  captionPreview,
  formatMetric,
  reachBars,
} from './logic';
import {
  ChannelIdentity,
  ChannelSelect,
  EngagementError,
  NoEligibleChannel,
  useEngagementChannel,
} from './shared';

type AccountInsights = components['schemas']['AccountInsights'];

const th = 'py-2 pr-3 text-left text-meta font-medium text-graphite last:pr-0';
const td = 'py-2 pr-3 text-compact text-ink last:pr-0';

/** destaques no topo; o resto dos totais vai para o cartão "Conta no período" */
const HEADLINE: Array<{ key: 'reach' | 'views' | 'total_interactions'; icon: IconType }> = [
  { key: 'reach', icon: BarChart3 },
  { key: 'views', icon: Eye },
  { key: 'total_interactions', icon: Heart },
];

function Kpi({ label, value, icon: Icon, tone }: { label: string; value: string; icon: IconType; tone: string }) {
  return (
    <div className={`flex min-h-32 flex-col gap-3 rounded-kpi p-4 ${tone}`}>
      <span className="flex items-center gap-3 text-compact font-medium text-ink">
        <span className="grid size-12 shrink-0 place-items-center rounded-control bg-surface">
          <Icon className="size-5 text-ink" aria-hidden />
        </span>
        {label}
      </span>
      <span className="mt-auto text-figure font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}

function AccountBlock({ data }: { data: AccountInsights }) {
  const t = useTranslations('insightsPage');
  const locale = useLocale();
  const metric = (key: string) => (t.has(`metric.${key}`) ? t(`metric.${key}`) : key);
  const rest = ACCOUNT_METRIC_KEYS.filter((k) => !HEADLINE.some((h) => h.key === k));
  const bars = reachBars(data.dailyReach);
  const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={t('followers')}
          value={formatMetric(data.followersCount, locale)}
          icon={Users}
          tone="bg-kpi-lilac"
        />
        {HEADLINE.map((h, i) => (
          <Kpi
            key={h.key}
            label={metric(h.key)}
            value={formatMetric(data.totals[h.key], locale)}
            icon={h.icon}
            tone={i % 2 === 0 ? 'bg-kpi-blue' : 'bg-kpi-lilac'}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card className="flex min-w-0 flex-col gap-3 p-5">
          <h2 className="text-panel font-medium text-ink">{t('account')}</h2>
          <dl className="flex flex-col divide-y divide-line">
            {rest.map((k) => (
              <div key={k} className="flex items-center justify-between gap-3 py-2">
                <dt className="text-compact text-graphite">{metric(k)}</dt>
                <dd
                  className="text-compact font-medium tabular-nums text-ink"
                  title={data.totals[k] === null ? t('metricMissing') : undefined}
                >
                  {formatMetric(data.totals[k], locale)}
                </dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-compact text-graphite">{t('posts')}</dt>
              <dd className="text-compact font-medium tabular-nums text-ink">
                {formatMetric(data.mediaCount, locale)}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="flex min-w-0 flex-col gap-3 p-5">
          <h2 className="text-panel font-medium text-ink">{t('dailyReach')}</h2>
          {bars.length === 0 ? (
            <p className="text-compact text-graphite">{t('dailyReachEmpty')}</p>
          ) : (
            <>
              <ul className="flex h-40 items-end gap-1" aria-label={t('dailyReach')}>
                {bars.map((b) => (
                  <li key={b.date} className="flex h-full min-w-0 flex-1 items-end">
                    <span
                      className="w-full rounded-key bg-accent transition-colors duration-200 hover:bg-accent-hover"
                      style={{ height: `${b.pct}%` }}
                      title={t('dayValue', {
                        date: dateFmt.format(new Date(b.date)),
                        value: formatMetric(b.value, locale),
                      })}
                    />
                    <span className="sr-only">
                      {t('dayValue', { date: dateFmt.format(new Date(b.date)), value: formatMetric(b.value, locale) })}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex justify-between text-axis tabular-nums text-graphite">
                <span>{dateFmt.format(new Date(bars[0]!.date))}</span>
                <span>{dateFmt.format(new Date(bars.at(-1)!.date))}</span>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function PerPostTable({ channelId }: { channelId: string }) {
  const t = useTranslations('insightsPage');
  const te = useTranslations('engagement');
  const locale = useLocale();
  const posts = useMediaInsights(channelId);
  const metric = (key: string) => (t.has(`metric.${key}`) ? t(`metric.${key}`) : key);

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-5">
      <h2 className="text-panel font-medium text-ink">{t('perPost')}</h2>
      {posts.isPending ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : posts.isError ? (
        <EngagementError error={posts.error} onRetry={() => void posts.refetch()} />
      ) : (
        (() => {
          const rows = posts.data.pages.flatMap((p) => p.items);
          if (rows.length === 0) return <p className="text-compact text-graphite">{t('noPosts')}</p>;
          return (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-line">
                    <tr>
                      <th className={th}>{t('post')}</th>
                      <th className={th}>{t('date')}</th>
                      {MEDIA_METRIC_KEYS.map((k) => (
                        <th key={k} className={`${th} text-right`}>
                          {metric(k)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map(({ media, metrics, unavailableReason }) => (
                      <tr key={media.id}>
                        <td className={`${td} max-w-xs`}>
                          <div className="flex flex-col gap-1">
                            {media.permalink ? (
                              <a
                                href={media.permalink}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate text-ink underline-offset-2 transition-colors duration-200 hover:text-accent hover:underline"
                              >
                                {captionPreview(media.caption, 60) || te('noCaption')}
                              </a>
                            ) : (
                              <span className="truncate">{captionPreview(media.caption, 60) || te('noCaption')}</span>
                            )}
                            <span className="text-meta text-graphite">
                              {te.has(`mediaType.${media.productType ?? media.mediaType}`)
                                ? te(`mediaType.${media.productType ?? media.mediaType}`)
                                : media.mediaType}
                              {unavailableReason ? ` · ${t('unavailable')}: ${unavailableReason}` : ''}
                            </span>
                          </div>
                        </td>
                        <td className={`${td} whitespace-nowrap text-graphite`}>
                          {media.timestamp ? relativeTime(media.timestamp, locale) : '—'}
                        </td>
                        {MEDIA_METRIC_KEYS.map((k) => (
                          <td key={k} className={`${td} text-right tabular-nums`}>
                            {formatMetric(metrics[k], locale)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {posts.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void posts.fetchNextPage()}
                  isLoading={posts.isFetchingNextPage}
                >
                  {te('loadMore')}
                </Button>
              ) : null}
            </>
          );
        })()
      )}
    </Card>
  );
}

function InsightsBoard({ channelId, days }: { channelId: string; days: Period }) {
  const account = useAccountInsights(channelId, days);
  return (
    <div className="flex flex-col gap-6">
      {account.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 rounded-kpi" />
          ))}
        </div>
      ) : account.isError ? (
        <EngagementError error={account.error} onRetry={() => void account.refetch()} />
      ) : (
        <AccountBlock data={account.data} />
      )}
      <PerPostTable channelId={channelId} />
    </div>
  );
}

export function InsightsView() {
  const t = useTranslations('insightsPage');
  const ch = useEngagementChannel('insights');
  const [days, setDays] = useState<Period>(28);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ChannelSelect channels={ch.list} value={ch.selected?.id} onChange={ch.select} />
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as Period)}>
              <SelectTrigger className="w-44" aria-label={t('period')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {t('periodOption', { days: p })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      {ch.isPending ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : ch.error ? (
        <EngagementError error={ch.error} onRetry={ch.refetch} />
      ) : !ch.selected ? (
        <NoEligibleChannel />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ChannelIdentity channel={ch.selected} />
            <p className="text-meta text-graphite">{t('delayNote')}</p>
          </div>
          <InsightsBoard key={ch.selected.id} channelId={ch.selected.id} days={days} />
        </>
      )}
    </div>
  );
}
