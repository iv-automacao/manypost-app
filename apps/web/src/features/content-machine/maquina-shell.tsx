'use client';

import { BookOpen, Palette, ReceiptText, ScrollText, SquareKanban, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';
import type { IconType } from '@/types';
import { RefreshNotice } from './field';
import { useOverview } from './hooks';
import { SECTIONS, sectionFor, type SectionKey } from './logic';

const ICONS: Record<SectionKey, IconType> = {
  board: SquareKanban,
  identity: Palette,
  foundation: BookOpen,
  prompts: ScrollText,
  spend: ReceiptText,
};

const CAPABILITIES = ['text', 'renderer', 'video'] as const;

/**
 * Moldura da área Máquina: o cabeçalho da tela, as seções (cada uma com a sua rota) e o aviso
 * das capacidades que esta instalação não tem. A visão geral carregada aqui também é a chamada
 * que configura a organização na primeira visita.
 */
export function MaquinaShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const pathname = usePathname();
  const overview = useOverview();
  const current = sectionFor(pathname);
  const caps = overview.data?.capabilities;
  const missing = caps ? CAPABILITIES.filter((k) => !caps[k]) : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('pageDescription')} />

      <nav
        aria-label={t('sectionsLabel')}
        className="flex h-10 w-fit max-w-full items-center gap-1 overflow-x-auto rounded-md border border-line bg-surface-2 p-1"
      >
        {SECTIONS.map(({ key, href }) => {
          const Icon = ICONS[key];
          const active = key === current;
          return (
            <Link
              key={key}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex h-full shrink-0 items-center gap-2 whitespace-nowrap rounded-sm px-3 text-compact font-semibold outline-none transition-colors duration-200',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                active ? 'bg-surface text-ink' : 'text-graphite hover:text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {t(`sections.${key}`)}
            </Link>
          );
        })}
      </nav>

      {missing.length > 0 ? (
        <Alert>
          <TriangleAlert aria-hidden />
          <div>
            <AlertTitle>{t('capabilities.title')}</AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {missing.map((k) => (
                  <li key={k}>{t(`capabilities.${k}`)}</li>
                ))}
              </ul>
            </AlertDescription>
          </div>
        </Alert>
      ) : null}

      {/* refetch que falhou com a visão geral em cache: só um aviso discreto, as telas seguem montadas */}
      {overview.isError && overview.data ? <RefreshNotice onRetry={() => void overview.refetch()} /> : null}
      {overview.isError && !overview.data ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AlertDescription>{t('loadError')}</AlertDescription>
            <Button variant="outline" size="sm" onClick={() => void overview.refetch()}>
              {tc('retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {children}
    </div>
  );
}
