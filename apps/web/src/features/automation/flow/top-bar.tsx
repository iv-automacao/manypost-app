'use client';

import { FlaskConical, Pause, Play, Redo2, Trash2, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useApiErrorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { useDeleteAutomation, useSetAutomationStatus } from '../hooks';
import { LIMITS, type Status, statusVariant } from '../logic';
import { saveBlockedByErrors } from './canvas-logic';
import type { Flow, FlowReminder, Problem, ShapeIssue } from './logic';
import { ReminderButton } from './reminder-button';

export function TopBar({
  id,
  name,
  onName,
  status,
  flow,
  problems,
  shape,
  dirty,
  saving,
  canUndo,
  canRedo,
  hasTesters,
  onUndo,
  onRedo,
  onSave,
  onSimulate,
  onFocus,
  onReminder,
  onSeal,
  readOnly,
}: {
  id: string | undefined;
  name: string;
  onName: (v: string) => void;
  status: Status;
  flow: Flow;
  problems: Problem[];
  shape: ShapeIssue[];
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasTesters: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSimulate: () => void;
  onFocus: (nodeId: string) => void;
  onReminder: (next: FlowReminder | undefined, opts?: { merge?: boolean }) => void;
  onSeal: () => void;
  readOnly: boolean;
}) {
  const t = useTranslations('automation');
  const tf = useTranslations('automation.flow');
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const setStatus = useSetAutomationStatus(id);
  const remove = useDeleteAutomation();
  const errors = problems.filter((p) => p.severity === 'error').length + shape.length;
  const titleOf = (nodeId?: string | null) => {
    const n = flow.nodes.find((x) => x.id === nodeId);
    return n ? tf(`node.${n.type}`) : nodeId === 'trigger' ? tf('node.trigger') : tf('general');
  };
  const change = (s: Status) =>
    setStatus.mutate(s, {
      onSuccess: () => toast.success(t(`statusChanged.${s}`)),
      onError: (e) => toast.error(errorMessage(e)),
    });
  const blocked = !id || dirty || errors > 0;
  // em teste/ativa a API recusa fluxo com erro (`automation.flow_invalid`): nem tenta
  const saveBlocked = saveBlockedByErrors(status, errors);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Input
          value={name}
          onChange={(e) => onName(e.target.value)}
          maxLength={LIMITS.name}
          aria-label={tf('namePlaceholder')}
          placeholder={tf('namePlaceholder')}
          className="max-w-xs"
          disabled={readOnly}
        />
        <Badge variant={statusVariant(status)}>{t(`status.${status}`)}</Badge>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'cursor-pointer rounded-compact px-2 py-1 text-meta font-medium transition-colors duration-200',
                errors ? 'bg-state-failed-tint text-state-failed' : problems.length ? 'bg-state-review-tint text-state-review' : 'bg-surface-2 text-graphite',
              )}
            >
              {tf('problems', { count: errors || problems.length })}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-80 flex-col gap-2">
            <p className="text-compact font-medium text-ink">{tf('problemsTitle')}</p>
            {[...shape.map((s) => ({ nodeId: s.nodeId, text: tf(`shape.${s.key}`), error: true })), ...problems.map((p) => ({ nodeId: p.nodeId ?? null, text: tf(`problem.${p.code}`), error: p.severity === 'error' }))].map((x, i) => (
              <button
                key={i}
                type="button"
                disabled={!x.nodeId}
                onClick={() => x.nodeId && onFocus(x.nodeId)}
                className="flex cursor-pointer flex-col items-start gap-0.5 rounded-compact px-2 py-1.5 text-left transition-colors duration-200 hover:bg-surface-2 disabled:cursor-default"
              >
                <span className="text-meta text-graphite">{titleOf(x.nodeId)}</span>
                <span className={cn('text-compact', x.error ? 'text-state-failed' : 'text-state-review')}>{x.text}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
        {dirty ? <span className="text-meta text-graphite">{tf('unsaved')}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={tf('undo')} title={tf('undo')} disabled={!canUndo} onClick={onUndo}>
              <Undo2 aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={tf('redo')} title={tf('redo')} disabled={!canRedo} onClick={onRedo}>
              <Redo2 aria-hidden />
            </Button>
          </>
        ) : null}
        <ReminderButton reminder={flow.reminder} onChange={onReminder} onSeal={onSeal} readOnly={readOnly} />
        <Button variant="outline" size="sm" onClick={onSimulate}>
          {tf('simulate')}
        </Button>
        {!readOnly ? (
          <>
            {saveBlocked && dirty ? <span className="text-meta text-state-failed">{tf('saveBlockedActive')}</span> : null}
            <Button size="sm" variant={dirty ? 'primary' : 'outline'} disabled={!dirty || shape.length > 0 || !name.trim() || saveBlocked} isLoading={saving} onClick={onSave}>
              {tf('save')}
            </Button>
          </>
        ) : null}
        {id && !readOnly ? (
          <>
            {status !== 'TEST' ? (
              <Button variant="outline" size="sm" disabled={blocked || !hasTesters} isLoading={setStatus.isPending && setStatus.variables === 'TEST'} onClick={() => change('TEST')}>
                <FlaskConical aria-hidden />
                {t('actionTest')}
              </Button>
            ) : null}
            {status !== 'ACTIVE' ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={blocked} isLoading={setStatus.isPending && setStatus.variables === 'ACTIVE'}>
                    <Play aria-hidden />
                    {t('actionActivate')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('activateTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('activateDescription')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-compact text-ink">
                    <li>{t('activateCheck1')}</li>
                    <li>{t('activateCheck2')}</li>
                    <li>{t('activateCheck3')}</li>
                  </ul>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => change('ACTIVE')}>{t('activateConfirm')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            {status === 'ACTIVE' || status === 'TEST' ? (
              <Button variant="outline" size="sm" isLoading={setStatus.isPending && setStatus.variables === 'PAUSED'} onClick={() => change('PAUSED')}>
                <Pause aria-hidden />
                {t('actionPause')}
              </Button>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('actionDelete')}>
                  <Trash2 aria-hidden />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      remove.mutate(id, {
                        onSuccess: () => router.push('/automacoes'),
                        onError: (e) => toast.error(errorMessage(e)),
                      })
                    }
                  >
                    {t('deleteConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </div>
    </div>
  );
}
