'use client';

import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useChannels } from '@/features/channels/hooks';
import { ChannelSelect, NoEligibleChannel, useEngagementChannel } from '@/features/engagement/shared';
import { useApiErrorMessage } from '@/lib/api/errors';
import { useAutomation, useCreateAutomation, useUpdateAutomation } from '../hooks';
import type { Status } from '../logic';
import { isInternalNavigation } from './canvas-logic';
import { FlowEditor, useNodeTexts, type EditorDoc } from './editor';
import { useFlowHistory } from './history';
import {
  TRIGGER_NODE_ID,
  defaultTrigger,
  emptyFlow,
  normalizeFlow,
  shapeIssues,
  triggerIssues,
  validateFlow,
  type NodeTexts,
} from './logic';
import { Simulator } from './simulator';
import { TopBar } from './top-bar';

/** abaixo de 768 px o canvas é só leitura (design D8) */
function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(max-width: 767px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(max-width: 767px)').matches,
    () => false,
  );
}

type ApiAutomation = NonNullable<ReturnType<typeof useAutomation>['data']>;

function docFromApi(a: ApiAutomation, texts: NodeTexts): EditorDoc {
  const t0 = a.triggers[0];
  return {
    name: a.name,
    flow: a.flow ? normalizeFlow(a.flow as { nodes?: unknown[]; edges?: unknown[]; reminder?: unknown }) : emptyFlow(texts),
    trigger: t0
      ? { mediaIds: t0.config.mediaIds ?? [], keywords: t0.config.keywords ?? [], publicReplies: t0.config.publicReplies ?? [] }
      : defaultTrigger(),
    triggerPosition: t0?.position ?? { x: -360, y: 0 },
    testUsernames: a.testUsernames,
  };
}

export function AutomationEditorPage({ id }: { id?: string }) {
  const t = useTranslations('automation');
  const errorMessage = useApiErrorMessage();
  const automation = useAutomation(id);
  const ch = useEngagementChannel('comments');
  const texts = useNodeTexts();

  if (id && automation.isPending) return <Skeleton className="h-[560px] rounded-lg" />;
  if (id && automation.isError) return <p className="text-compact text-state-failed">{errorMessage(automation.error)}</p>;
  if (!id && ch.isPending) return <Skeleton className="h-[560px] rounded-lg" />;
  if (!id && !ch.selected) return <NoEligibleChannel />;

  const channelId = id ? automation.data!.channelId : ch.selected!.id;
  const initial: EditorDoc = id
    ? docFromApi(automation.data!, texts)
    : { name: t('newTitle'), flow: emptyFlow(texts), trigger: defaultTrigger(), triggerPosition: { x: -360, y: 0 }, testUsernames: [] };
  return (
    <div className="flex flex-col gap-3">
      {!id && ch.list.length > 1 ? <ChannelSelect channels={ch.list} value={ch.selected!.id} onChange={ch.select} /> : null}
      <EditorShell
        key={`${id ?? 'nova'}:${channelId}`}
        id={id}
        channelId={channelId}
        status={id ? (automation.data!.status as Status) : 'DRAFT'}
        initial={initial}
        invalidStored={Boolean(id) && automation.data!.flow == null}
        texts={texts}
      />
    </div>
  );
}

function EditorShell({
  id,
  channelId,
  status,
  initial,
  invalidStored,
  texts,
}: {
  id?: string;
  channelId: string;
  status: Status;
  initial: EditorDoc;
  /** o fluxo guardado não passou no parse: o editor abre vazio e o primeiro salvar o substitui */
  invalidStored: boolean;
  texts: NodeTexts;
}) {
  const t = useTranslations('automation');
  const tf = useTranslations('automation.flow');
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const channels = useChannels();
  const username = channels.data?.find((c) => c.id === channelId)?.username ?? null;
  const history = useFlowHistory(initial);
  const doc = history.present;
  const create = useCreateAutomation();
  const update = useUpdateAutomation(id);
  const readOnly = useNarrow();
  const problems = useMemo(() => validateFlow(doc.flow), [doc.flow]);
  const shape = useMemo(
    () => [...shapeIssues(doc.flow), ...triggerIssues(doc.trigger).map((key) => ({ nodeId: TRIGGER_NODE_ID, key }))],
    [doc.flow, doc.trigger],
  );
  const [sim, setSim] = useState<{ startAt: string | null; n: number } | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [storedInvalid, setStoredInvalid] = useState(invalidStored);

  // desfazer/refazer fora de campos de texto (os campos têm o próprio desfazer)
  const { undo, redo } = history;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [undo, redo]);

  // aviso do navegador ao fechar a aba com alterações
  useEffect(() => {
    if (!history.dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [history.dirty]);

  // com alterações, qualquer link interno (menu lateral, logo, voltar) pergunta antes de sair; fase de captura para
  // rodar antes do roteador do Next e poder cancelar a navegação
  useEffect(() => {
    if (!history.dirty) return;
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return;
      const a = e.target.closest('a[href]');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (!isInternalNavigation({ href: a.href, target: a.target, download: a.hasAttribute('download') }, e, window.location.href)) return;
      if (!window.confirm(tf('leaveDescription'))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, [history.dirty, tf]);

  const save = () => {
    // o fluxo guardado era inválido: salvar o substitui, então a primeira vez pede confirmação explícita
    if (storedInvalid && !window.confirm(tf('invalidStoredFlowConfirm'))) return;
    const sent = doc;
    const body = {
      name: doc.name.trim(),
      flow: doc.flow,
      triggers: [{ kind: 'comment' as const, config: doc.trigger, position: doc.triggerPosition }],
      testUsernames: doc.testUsernames,
    };
    const onError = (e: unknown) => toast.error(errorMessage(e));
    if (id) {
      update.mutate(body, {
        onSuccess: () => {
          history.markSaved(sent);
          setStoredInvalid(false);
          toast.success(tf('saved'));
          if (status === 'ACTIVE') toast.message(tf('activeSaveWarning'));
        },
        onError,
      });
    } else {
      create.mutate(
        { channelId, ...body },
        {
          onSuccess: (a) => {
            history.markSaved(sent);
            toast.success(t('created'));
            router.replace(`/automacoes/${(a as { id: string }).id}`);
          },
          onError,
        },
      );
    }
  };

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/automacoes">
            <ArrowLeft aria-hidden />
            {t('back')}
          </Link>
        </Button>
      </div>
      <TopBar
        id={id}
        name={doc.name}
        onName={(name) => history.set({ ...doc, name }, { merge: true })}
        status={status}
        flow={doc.flow}
        problems={problems}
        shape={shape}
        dirty={history.dirty}
        saving={create.isPending || update.isPending}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        hasTesters={doc.testUsernames.length > 0}
        onUndo={history.undo}
        onRedo={history.redo}
        onSave={save}
        onSimulate={() => setSim((s) => ({ startAt: null, n: (s?.n ?? 0) + 1 }))}
        onFocus={(nodeId) => setFocus((f) => ({ id: nodeId, n: (f?.n ?? 0) + 1 }))}
        onReminder={(reminder, opts) => {
          const { reminder: _old, ...rest } = doc.flow;
          history.set({ ...doc, flow: reminder ? { ...rest, reminder } : rest }, opts);
        }}
        readOnly={readOnly}
      />
      {storedInvalid ? (
        <p role="alert" className="rounded-control bg-state-review-tint px-3 py-2 text-meta text-state-review">
          {tf('invalidStoredFlow')}
        </p>
      ) : null}
      {readOnly ? <p className="rounded-control bg-surface-2 px-3 py-2 text-meta text-graphite">{tf('readOnly')}</p> : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-card border border-line">
        <div className="min-w-0 flex-1">
          <FlowEditor
            doc={doc}
            onChange={history.set}
            onSeal={history.seal}
            readOnly={readOnly}
            channelId={channelId}
            username={username}
            problems={problems}
            shape={shape}
            focus={focus}
            onTestFrom={(nodeId) => setSim((s) => ({ startAt: nodeId, n: (s?.n ?? 0) + 1 }))}
            texts={texts}
          />
        </div>
        {sim ? <Simulator key={sim.n} flow={doc.flow} startAt={sim.startAt} onClose={() => setSim(null)} /> : null}
      </div>
    </div>
  );
}
