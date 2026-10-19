'use client';

import { BellRing, ExternalLink, RotateCcw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { canSimulateSilence, sendSim, simulateSilence, startSim, tapForTitle, type Flow, type SimState } from './logic';

/**
 * Simulação local (design D8): roda o mesmo passo do motor sobre o fluxo em edição, sem chamar a API
 * nem a ponte. "Testar daqui" começa no balão escolhido.
 */
export function Simulator({ flow, startAt, onClose }: { flow: Flow; startAt: string | null; onClose: () => void }) {
  const t = useTranslations('automation.flow');
  const first = useMemo(() => startSim(flow, { username: 'cliente', startAt }), [flow, startAt]);
  const [state, setState] = useState<SimState>(first);
  const [text, setText] = useState('');
  const startNode = startAt ? flow.nodes.find((n) => n.id === startAt) : null;
  const lastBrand = [...state.transcript].reverse().find((x) => x.from === 'brand');

  const send = () => {
    if (!text.trim()) return;
    setState((s) => sendSim(s, { text }));
    setText('');
  };
  const tap = (title: string) => {
    const handle = tapForTitle(state.flow, state.nodeId, title);
    setState((s) => sendSim(s, handle ? { tap: handle } : { text: title }));
  };

  return (
    <aside aria-label={t('sim.title')} className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <span className="text-panel font-medium text-ink">{t('sim.title')}</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={t('sim.restart')} title={t('sim.restart')} onClick={() => setState(startSim(flow, { username: 'cliente', startAt }))}>
            <RotateCcw aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}>
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        <p className="text-meta text-graphite">{t('sim.nothingSent')}</p>
        {startNode ? <p className="text-meta text-graphite">{t('sim.fromNode', { node: t(`node.${startNode.type}`) })}</p> : null}
        <ol className="flex flex-col gap-2">
          {state.transcript.map((x, i) =>
            x.from === 'action' ? (
              <li key={i} className="self-start text-meta text-graphite">
                {x.action.kind === 'send_data' ? t('sim.actionSend', { label: x.action.label }) : t('sim.actionNotify', { text: x.action.text })}
              </li>
            ) : x.from === 'typing' ? (
              <li key={i} className="self-start text-meta text-graphite">
                {t('sim.typing', { seconds: x.seconds })}
              </li>
            ) : (
              <li key={i} className={cn('flex max-w-[85%] flex-col gap-1', x.from === 'user' ? 'items-end self-end' : 'self-start')}>
                <span className={cn('whitespace-pre-line rounded-card px-3 py-2 text-compact text-ink', x.from === 'user' ? 'bg-accent-tint' : 'bg-surface-2')}>
                  {x.msg.text}
                </span>
                {x.msg.buttons?.map((b, j) =>
                  x.msg.urls?.[j] ? (
                    <a key={j} href={x.msg.urls[j]} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1 rounded-compact border border-line px-3 py-1.5 text-meta font-medium text-accent">
                      {b}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    <button
                      key={j}
                      type="button"
                      disabled={x !== lastBrand || state.status !== 'waiting'}
                      onClick={() => tap(b)}
                      className="cursor-pointer rounded-compact border border-line bg-surface px-3 py-1.5 text-meta font-medium text-accent transition-colors duration-200 hover:bg-accent-tint disabled:cursor-default disabled:opacity-60"
                    >
                      {b}
                    </button>
                  ),
                )}
                {x.msg.quick?.length ? (
                  <span className="flex flex-wrap gap-1">
                    {x.msg.quick.map((q, j) => (
                      <button
                        key={j}
                        type="button"
                        disabled={x !== lastBrand || state.status !== 'waiting'}
                        onClick={() => tap(q)}
                        className="cursor-pointer rounded-compact border border-line-strong px-2.5 py-1 text-meta text-ink transition-colors duration-200 hover:bg-surface-2 disabled:cursor-default disabled:opacity-60"
                      >
                        {q}
                      </button>
                    ))}
                  </span>
                ) : null}
              </li>
            ),
          )}
        </ol>
        {canSimulateSilence(state) ? (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setState((s) => simulateSilence(s))}>
            <BellRing aria-hidden />
            {t('sim.silence')}
          </Button>
        ) : null}
        {state.status !== 'waiting' ? (
          <p className={cn('text-meta', state.status === 'completed' ? 'text-state-published' : 'text-state-failed')}>{t(`sim.${state.status}`)}</p>
        ) : null}
      </div>
      <form
        className="flex gap-2 border-t border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('sim.placeholder')} disabled={state.status !== 'waiting'} />
        <Button type="submit" size="sm" disabled={state.status !== 'waiting' || !text.trim()}>
          {t('sim.send')}
        </Button>
      </form>
      <section className="flex flex-col gap-1 border-t border-line px-4 py-3">
        <span className="text-meta font-medium text-graphite">{t('sim.fields')}</span>
        {Object.keys(state.answers).length === 0 ? (
          <span className="text-meta text-graphite">{t('sim.noFields')}</span>
        ) : (
          Object.entries(state.answers).map(([k, v]) => (
            <span key={k} className="text-meta text-ink">
              <span className="text-graphite">{k}:</span> {v}
            </span>
          ))
        )}
      </section>
    </aside>
  );
}
