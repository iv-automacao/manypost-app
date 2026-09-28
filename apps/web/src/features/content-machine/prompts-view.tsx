'use client';

import { ChevronDown, CircleAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useApiErrorMessage } from '@/lib/api/errors';
import { relativeTime } from '@/lib/datetime';
import { RefreshNotice, SectionTitle } from './field';
import { useHooks, useOverview, usePrompts, useUpdatePrompt } from './hooks';
import { PROMPT_NAMES, groupPrompts, type PromptGroup } from './logic';
import type { PromptName } from './types';

/** Prompts versionados de cada etapa + fórmulas de gancho (somente leitura). */
export function PromptsView() {
  const t = useTranslations('maquina.prompts');
  const tc = useTranslations('common');
  const overview = useOverview();
  const prompts = usePrompts();

  // sem visão geral nenhuma: o shell mostra o erro. Com ela em cache, refetch que falhou não desmonta os editores
  if (overview.isError && !overview.data) return null;
  if (overview.isPending || prompts.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (!prompts.data) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AlertDescription>{t('loadError')}</AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void prompts.refetch()}>
            {tc('retry')}
          </Button>
        </div>
      </Alert>
    );
  }

  const groups = groupPrompts(prompts.data);
  return (
    <div className="flex flex-col gap-4">
      {prompts.isError ? <RefreshNotice onRetry={() => void prompts.refetch()} /> : null}
      <p className="max-w-reading text-compact leading-relaxed text-graphite">{t('description')}</p>
      {PROMPT_NAMES.map((name) => (
        <PromptEditor key={name} name={name} group={groups[name]} />
      ))}
      <HookFormulas />
    </div>
  );
}

function PromptEditor({ name, group }: { name: PromptName; group: PromptGroup }) {
  const t = useTranslations('maquina.prompts');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();
  const update = useUpdatePrompt();
  const [draft, setDraft] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const server = group.active?.system ?? '';
  const value = draft ?? server;
  const dirty = draft !== null && draft !== server;
  const title = t(`names.${name}.title`);
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const historyId = `cm-prompt-history-${name}`;

  const save = () =>
    update.mutate(
      { name, system: value },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success(t('saved', { title }));
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SectionTitle>{title}</SectionTitle>
          <p className="text-meta leading-relaxed text-graphite">{t(`names.${name}.hint`)}</p>
        </div>
        <Badge variant={group.active ? 'accent' : 'neutral'} className="tabular-nums">
          {group.active
            ? t('activeVersion', { version: group.active.version, when: relativeTime(group.active.createdAt, locale) })
            : t('noVersion')}
        </Badge>
      </div>
      <Textarea
        aria-label={title}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-64"
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {group.history.length > 0 ? (
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            aria-expanded={historyOpen}
            aria-controls={historyId}
            className="flex cursor-pointer items-center gap-1 text-meta font-medium text-graphite outline-none transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('history', { count: group.history.length })}
            <ChevronDown className={historyOpen ? 'size-4 rotate-180 transition-transform duration-200' : 'size-4 transition-transform duration-200'} aria-hidden />
          </button>
        ) : (
          <span />
        )}
        <Button variant="outline" size="sm" onClick={save} disabled={!dirty || !value.trim()} isLoading={update.isPending}>
          {t('save')}
        </Button>
      </div>
      {historyOpen ? (
        <ol id={historyId} className="flex flex-col gap-2 border-t border-line pt-3">
          {group.history.map((v) => (
            <li key={v.id} className="flex flex-col gap-2 rounded-control bg-surface-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-meta font-medium tabular-nums text-graphite">
                  {t('versionLabel', { version: v.version, date: fmt.format(new Date(v.createdAt)) })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(v.system);
                    toast.info(t('restored'));
                  }}
                >
                  {t('restore')}
                </Button>
              </div>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-meta leading-relaxed text-ink">
                {v.system}
              </pre>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}

function HookFormulas() {
  const t = useTranslations('maquina.prompts');
  const hooks = useHooks();
  const list = [...(hooks.data ?? [])].sort((a, b) => b.score - a.score);

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('hooksTitle')}</SectionTitle>
        <p className="text-meta leading-relaxed text-graphite">{t('hooksDescription')}</p>
      </div>
      {hooks.isPending ? <Skeleton className="h-32 rounded-control" /> : null}
      {hooks.isSuccess && list.length === 0 ? <p className="text-compact text-graphite">{t('hooksEmpty')}</p> : null}
      {list.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {list.map((h) => (
            <li key={h.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <span className="text-compact font-medium text-ink">{h.formula}</span>
              {h.template ? (
                <span className="text-compact leading-relaxed text-ink">
                  <span className="text-graphite">{t('hookTemplate')}: </span>
                  {h.template}
                </span>
              ) : null}
              {h.example ? (
                <span className="text-compact leading-relaxed text-ink">
                  <span className="text-graphite">{t('hookExample')}: </span>
                  {h.example}
                </span>
              ) : null}
              <span className="text-meta tabular-nums text-graphite">
                {t('hookMeta', { pillar: h.pillar || '—', origin: h.origin || '—', score: h.score, uses: h.uses })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
