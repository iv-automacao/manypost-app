'use client';

import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionTitle } from './field';
import { useSpend } from './hooks';
import {
  USD_TO_BRL,
  formatBrl,
  formatUsd,
  monthKey,
  servicesByCost,
  shiftMonth,
  topPieces,
  usdToBrl,
} from './logic';
import { PieceSheet } from './piece-sheet';

const th = 'py-2 pr-3 text-left text-meta font-medium text-graphite last:pr-0';
const td = 'py-2 pr-3 text-compact text-ink last:pr-0';

/** Gasto do mês por serviço/modelo e as peças mais caras; o valor em reais é aproximado. */
export function SpendView() {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const locale = useLocale();
  const atual = monthKey(new Date());
  const [month, setMonth] = useState(atual);
  const [openId, setOpenId] = useState<string | null>(null);
  const spend = useSpend(month);
  const data = spend.data;

  const [y, m] = month.split('-').map(Number);
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(y ?? 1970, (m ?? 1) - 1, 1),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-reading text-compact leading-relaxed text-graphite">{t('spend.description')}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label={t('spend.previous')}
            onClick={() => setMonth((v) => shiftMonth(v, -1))}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Input
            type="month"
            aria-label={t('spend.month')}
            value={month}
            max={atual}
            onChange={(e) => (/^\d{4}-\d{2}$/.test(e.target.value) ? setMonth(e.target.value) : undefined)}
            className="w-44 tabular-nums"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label={t('spend.next')}
            onClick={() => setMonth((v) => shiftMonth(v, 1))}
            disabled={month >= atual}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>

      {spend.isPending ? (
        <Skeleton className="h-64 rounded-card" />
      ) : spend.isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AlertDescription>{t('spend.loadError')}</AlertDescription>
            <Button variant="outline" size="sm" onClick={() => void spend.refetch()}>
              {tc('retry')}
            </Button>
          </div>
        </Alert>
      ) : data ? (
        <>
          <div className="flex flex-col gap-1 rounded-kpi bg-kpi-lilac p-5">
            <span className="text-compact text-graphite">
              {t('spend.total')} · {monthLabel}
            </span>
            <span className="text-figure font-medium tabular-nums text-ink">{formatUsd(data.totalUsd, locale)}</span>
            <span className="text-meta tabular-nums text-graphite">
              {t('spend.approx', {
                brl: formatBrl(usdToBrl(data.totalUsd), locale),
                rate: formatBrl(USD_TO_BRL, locale),
              })}
            </span>
          </div>

          {data.byService.length === 0 && data.pieces.length === 0 ? (
            <p className="rounded-card border border-line bg-surface px-4 py-3 text-compact text-graphite">
              {t('spend.empty')}
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="flex min-w-0 flex-col gap-3 p-5">
                <SectionTitle>{t('spend.byService')}</SectionTitle>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-line">
                      <tr>
                        <th className={th}>{t('spend.service')}</th>
                        <th className={th}>{t('spend.model')}</th>
                        <th className={`${th} text-right`}>{t('spend.calls')}</th>
                        <th className={`${th} text-right`}>{t('spend.cost')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {servicesByCost(data.byService).map((r) => (
                        <tr key={`${r.service}-${r.model}`}>
                          <td className={td}>{r.service}</td>
                          <td className={`${td} text-graphite`}>{r.model}</td>
                          <td className={`${td} text-right tabular-nums`}>{r.count}</td>
                          <td className={`${td} text-right tabular-nums`}>{formatUsd(r.costUsd, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card className="flex min-w-0 flex-col gap-3 p-5">
                <SectionTitle>{t('spend.topPieces')}</SectionTitle>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-line">
                      <tr>
                        <th className={th}>{t('spend.piece')}</th>
                        <th className={th}>{t('spend.format')}</th>
                        <th className={`${th} text-right`}>{t('spend.cost')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {topPieces(data.pieces).map((r) => (
                        <tr key={r.pieceId}>
                          <td className={td}>
                            <button
                              type="button"
                              onClick={() => setOpenId(r.pieceId)}
                              className="cursor-pointer font-medium tabular-nums text-accent outline-none hover:text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {r.keyword || r.pieceId.slice(0, 8)}
                            </button>
                          </td>
                          <td className={`${td} text-graphite`}>
                            {t.has(`format.${r.format}`) ? t(`format.${r.format}`) : r.format}
                          </td>
                          <td className={`${td} text-right tabular-nums`}>{formatUsd(r.costUsd, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </>
      ) : null}

      <PieceSheet pieceId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
