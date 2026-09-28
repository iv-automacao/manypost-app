'use client';

import { CalendarRange, ChevronDown, CircleAlert, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { NewIdeaDialog, PlanWeekDialog } from './create-dialogs';
import { RefreshNotice } from './field';
import { PIECES_LIMIT, usePieces } from './hooks';
import { BOARD_COLUMNS, SIDE_GROUPS, groupByStatus, isAutomatic, type SideGroup } from './logic';
import { PieceCard } from './piece-card';
import { PieceSheet } from './piece-sheet';
import { STATUS_DOT } from './status-ui';
import type { ContentPiece } from './types';

function Count({ n }: { n: number }) {
  return <span className="rounded-key bg-surface-2 px-1.5 py-0.5 text-meta tabular-nums text-graphite">{n}</span>;
}

/**
 * Quadro da máquina: uma coluna por etapa da esteira, numa superfície única com rolagem
 * horizontal quando falta largura. Erro e reprovado ficam fora da esteira, em grupos recolhíveis
 * abaixo — erro aberto por padrão, porque pede ação.
 */
export function BoardView() {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const pieces = usePieces();
  const [openId, setOpenId] = useState<string | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [aberto, setAberto] = useState<Record<SideGroup, boolean>>({ erro: true, reprovado: false });

  const list = useMemo(() => pieces.data ?? [], [pieces.data]);
  const groups = useMemo(() => groupByStatus(list), [list]);
  const ativas = list.filter((p) => p.running || isAutomatic(p.status)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-compact tabular-nums text-graphite">
          {pieces.data ? t('board.summary', { total: list.length, active: ativas }) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setPlanOpen(true)}>
            <CalendarRange aria-hidden />
            {t('board.planWeek')}
          </Button>
          <Button onClick={() => setIdeaOpen(true)}>
            <Plus aria-hidden />
            {t('board.newIdea')}
          </Button>
        </div>
      </div>

      {pieces.isPending ? (
        <Skeleton className="h-96 rounded-card" />
      ) : !pieces.data ? (
        // sem nada em cache: aí sim o erro ocupa o lugar do quadro
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AlertDescription>{t('board.loadError')}</AlertDescription>
            <Button variant="outline" size="sm" onClick={() => void pieces.refetch()}>
              {tc('retry')}
            </Button>
          </div>
        </Alert>
      ) : (
        <>
          {/* refetch que falhou com quadro em cache: aviso discreto, o quadro continua na tela */}
          {pieces.isError ? <RefreshNotice onRetry={() => void pieces.refetch()} /> : null}
          {list.length === 0 ? (
            <p className="rounded-card border border-line bg-surface px-4 py-3 text-compact text-graphite">
              {t('board.empty')}
            </p>
          ) : null}
          {list.length >= PIECES_LIMIT ? (
            <p className="text-meta text-graphite">{t('board.truncated', { count: PIECES_LIMIT })}</p>
          ) : null}

          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <div className="flex min-w-max 2xl:min-w-0">
              {BOARD_COLUMNS.map((status) => (
                <section
                  key={status}
                  aria-label={t(`status.${status}`)}
                  className="flex w-60 shrink-0 flex-col gap-3 border-l border-line px-3 pb-3 first:border-l-0 2xl:w-auto 2xl:min-w-0 2xl:flex-1"
                >
                  <h2 className="flex min-h-11 items-center justify-between gap-2 border-b border-line px-1 text-panel font-medium text-ink">
                    <span className="flex items-center gap-2">
                      <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />
                      {t(`status.${status}`)}
                    </span>
                    <Count n={groups[status].length} />
                  </h2>
                  {groups[status].length > 0 ? (
                    groups[status].map((p) => <PieceCard key={p.id} piece={p} onOpen={setOpenId} />)
                  ) : (
                    <p className="px-1 text-meta text-graphite">{t('board.emptyColumn')}</p>
                  )}
                </section>
              ))}
            </div>
          </div>

          {SIDE_GROUPS.map((g) =>
            groups[g].length > 0 ? (
              <SideGroupSection
                key={g}
                group={g}
                pieces={groups[g]}
                open={aberto[g]}
                onToggle={() => setAberto((s) => ({ ...s, [g]: !s[g] }))}
                onOpen={setOpenId}
              />
            ) : null,
          )}
        </>
      )}

      <NewIdeaDialog open={ideaOpen} onOpenChange={setIdeaOpen} />
      <PlanWeekDialog open={planOpen} onOpenChange={setPlanOpen} />
      <PieceSheet pieceId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function SideGroupSection({
  group,
  pieces,
  open,
  onToggle,
  onOpen,
}: {
  group: SideGroup;
  pieces: ContentPiece[];
  open: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('maquina');
  const regionId = `cm-side-${group}`;
  return (
    <section className="rounded-card border border-line bg-surface">
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={regionId}
          className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-card px-4 py-3 text-left outline-none transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="flex items-center gap-2 text-panel font-medium text-ink">
            <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[group])} aria-hidden />
            {t(`board.sideGroups.${group}`)}
            <Count n={pieces.length} />
          </span>
          <span className="flex items-center gap-1 text-meta text-graphite">
            {open ? t('board.hide') : t('board.show')}
            <ChevronDown className={cn('size-4 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
          </span>
        </button>
      </h2>
      {open ? (
        <div id={regionId} className="grid gap-3 border-t border-line p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {pieces.map((p) => (
            <PieceCard key={p.id} piece={p} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
