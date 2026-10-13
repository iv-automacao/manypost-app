'use client';

import { Handle, NodeToolbar, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import {
  Copy,
  FlaskConical,
  Flag,
  GitBranch,
  Link2,
  MessageSquare,
  MessageSquareText,
  Plus,
  TextCursorInput,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { LIMITS } from '../logic';
import { useFlowActions } from './actions';
import { CONDITION_OPS, TRIGGER_NODE_ID, type NodeOf, type TriggerConfig } from './logic';
import { NodeSettings } from './node-settings';

const INPUT =
  'nodrag w-full rounded-compact border border-transparent bg-surface-2 px-2 py-1.5 text-compact text-ink outline-none transition-colors duration-200 focus:border-accent';

function InlineText({ nodeId, value, placeholder, field = 'text' }: { nodeId: string; value: string; placeholder: string; field?: string }) {
  const a = useFlowActions();
  if (a.readOnly) return <p className="whitespace-pre-line text-compact text-ink">{value}</p>;
  return (
    <textarea
      className={cn(INPUT, 'nowheel resize-none')}
      value={value}
      rows={Math.min(8, Math.max(2, value.split('\n').length))}
      maxLength={LIMITS.messageText}
      placeholder={placeholder}
      onChange={(e) => a.update(nodeId, { [field]: e.target.value }, { merge: true })}
      onBlur={a.seal}
    />
  );
}

function InlineInput({ value, placeholder, maxLength, onChange }: { value: string; placeholder: string; maxLength?: number; onChange: (v: string) => void }) {
  const a = useFlowActions();
  if (a.readOnly) return <span className="text-compact text-ink">{value}</span>;
  return (
    <input className={INPUT} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} onBlur={a.seal} />
  );
}

/** linha com saída (bolinha à direita) */
function OutputRow({ handleId, label, children }: { handleId: string; label?: string; children?: ReactNode }) {
  const a = useFlowActions();
  return (
    <div className="relative flex items-center gap-2">
      {children ?? <span className="flex-1 text-meta text-graphite">{label}</span>}
      <Handle type="source" id={handleId} position={Position.Right} className="flow-handle" isConnectable={!a.readOnly} style={{ right: -18 }} />
    </div>
  );
}

function ToolbarButton({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 cursor-pointer items-center justify-center rounded-compact text-ink transition-colors duration-200 hover:bg-surface-2 hover:text-accent"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function NodeShell({
  id,
  selected,
  icon: Icon,
  title,
  settings,
  fixed = false,
  target = true,
  children,
}: {
  id: string;
  selected: boolean;
  icon: LucideIcon;
  title: string;
  settings?: ReactNode;
  /** abertura e gatilho: sem duplicar/excluir */
  fixed?: boolean;
  target?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const problems = a.problems.get(id) ?? [];
  const shape = a.shape.get(id) ?? [];
  const hasError = shape.length > 0 || problems.some((p) => p.severity === 'error');
  return (
    <div
      className={cn(
        'flex w-72 flex-col gap-2 rounded-card border bg-surface p-3',
        selected ? 'border-accent' : hasError ? 'border-destructive' : 'border-line-strong',
      )}
    >
      {!a.readOnly && id !== TRIGGER_NODE_ID ? (
        <NodeToolbar isVisible={selected} position={Position.Top} className="flex gap-1 rounded-control border border-line bg-surface p-1">
          {!fixed ? <ToolbarButton label={t('duplicate')} icon={Copy} onClick={() => a.duplicate(id)} /> : null}
          <ToolbarButton label={t('testFromHere')} icon={FlaskConical} onClick={() => a.testFrom(id)} />
          {!fixed ? <ToolbarButton label={t('delete')} icon={Trash2} onClick={() => a.remove(id)} /> : null}
        </NodeToolbar>
      ) : null}
      {target ? <Handle type="target" position={Position.Left} className="flow-handle" isConnectable={!a.readOnly} /> : null}
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-meta font-medium text-graphite">
          <Icon className="size-3.5 text-accent" aria-hidden />
          {title}
        </span>
        {settings}
      </header>
      {children}
      {shape.map((k) => (
        <p key={k} className="text-meta text-destructive">
          {t(`shape.${k}`)}
        </p>
      ))}
      {problems.map((p, i) => (
        <p key={`${p.code}-${i}`} className={cn('text-meta', p.severity === 'error' ? 'text-destructive' : 'text-state-review')}>
          {t(`problem.${p.code}`)}
        </p>
      ))}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="flex flex-1 items-center justify-center rounded-compact border border-line bg-surface px-3 py-1.5 text-meta font-medium text-accent">
      {children}
    </span>
  );
}

type P<T extends 'opening' | 'message' | 'question' | 'condition' | 'link' | 'end'> = NodeProps<Node<{ node: NodeOf<T> } & Record<string, unknown>, T>>;

function OpeningView({ id, data, selected }: P<'opening'>) {
  const t = useTranslations('automation.flow');
  const n = data.node;
  return (
    <NodeShell id={id} selected={selected} fixed icon={MessageSquareText} title={t('node.opening')} settings={<NodeSettings node={n} />}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      {n.data.mode === 'button' ? (
        <OutputRow handleId="next">
          <Chip>{n.data.buttonTitle}</Chip>
        </OutputRow>
      ) : (
        <>
          <p className="text-meta text-graphite">{t('openingHint')}</p>
          <OutputRow handleId="next" label={t('output.reply')} />
        </>
      )}
    </NodeShell>
  );
}

function MessageView({ id, data, selected }: P<'message'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const max = n.data.format === 'buttons' ? LIMITS.maxButtons : LIMITS.maxOptions;
  return (
    <NodeShell id={id} selected={selected} icon={MessageSquare} title={t('node.message')} settings={<NodeSettings node={n} />}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      {n.data.format === 'none' ? (
        <OutputRow handleId="next" label={t('output.next')} />
      ) : (
        <div className="flex flex-col gap-1">
          {n.data.options.map((o) => (
            <OutputRow key={o.id} handleId={o.id}>
              <InlineInput
                value={o.title}
                placeholder={t('placeholder.option')}
                maxLength={LIMITS.buttonTitle}
                onChange={(v) =>
                  a.update(id, { options: n.data.options.map((x) => (x.id === o.id ? { ...x, title: v } : x)) }, { merge: true })
                }
              />
              {!a.readOnly && n.data.options.length > 1 ? (
                <button
                  type="button"
                  aria-label={t('removeOption')}
                  onClick={() => a.removeOption(id, o.id)}
                  className="nodrag flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-compact text-graphite transition-colors duration-200 hover:text-destructive"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </OutputRow>
          ))}
          {!a.readOnly && n.data.options.length < max ? (
            <button
              type="button"
              onClick={() => a.addOption(id)}
              className="nodrag flex cursor-pointer items-center gap-1 self-start rounded-compact px-2 py-1 text-meta font-medium text-accent transition-colors duration-200 hover:bg-accent-tint"
            >
              <Plus className="size-3.5" aria-hidden />
              {t('addOption')}
            </button>
          ) : null}
          {/* sempre visível: uma ligação `typed` existente continua valendo mesmo em "pedir de novo" */}
          <OutputRow handleId="typed" label={t('output.typed')} />
        </div>
      )}
      {n.data.saveTo ? <p className="text-meta text-graphite">{t('savesTo', { field: n.data.saveTo })}</p> : null}
    </NodeShell>
  );
}

function QuestionView({ id, data, selected }: P<'question'>) {
  const t = useTranslations('automation.flow');
  const n = data.node;
  return (
    <NodeShell id={id} selected={selected} icon={TextCursorInput} title={t('node.question')} settings={<NodeSettings node={n} />}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      <p className="text-meta text-graphite">
        {t('savesTo', { field: n.data.field })} · {t(`settingsPanel.validation.${n.data.validate}`)}
      </p>
      <OutputRow handleId="next" label={t('output.answered')} />
    </NodeShell>
  );
}

function ConditionView({ id, data, selected }: P<'condition'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const needsValue = n.data.op === 'equals' || n.data.op === 'contains';
  return (
    <NodeShell id={id} selected={selected} icon={GitBranch} title={t('node.condition')}>
      {a.fields.length === 0 ? (
        <p className="text-meta text-graphite">{t('condition.noFields')}</p>
      ) : (
        <div className="nodrag nokey flex flex-col gap-2">
          <Select value={n.data.field || undefined} onValueChange={(v) => a.update(id, { field: v })} disabled={a.readOnly}>
            <SelectTrigger aria-label={t('condition.field')}>
              <SelectValue placeholder={t('condition.field')} />
            </SelectTrigger>
            <SelectContent>
              {a.fields.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={n.data.op} onValueChange={(v) => a.update(id, { op: v })} disabled={a.readOnly}>
            <SelectTrigger aria-label={t('node.condition')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITION_OPS.map((op) => (
                <SelectItem key={op} value={op}>
                  {t(`condition.op.${op}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsValue ? (
            <InlineInput value={n.data.value} placeholder={t('placeholder.value')} maxLength={LIMITS.conditionValue} onChange={(v) => a.update(id, { value: v }, { merge: true })} />
          ) : null}
        </div>
      )}
      <OutputRow handleId="yes" label={t('output.yes')} />
      <OutputRow handleId="no" label={t('output.no')} />
    </NodeShell>
  );
}

function LinkView({ id, data, selected }: P<'link'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const target = n.data.target;
  const setTarget = (next: NodeOf<'link'>['data']['target'], merge = false) => a.update(id, { target: next }, { merge });
  return (
    <NodeShell id={id} selected={selected} icon={Link2} title={t('node.link')}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      {!a.readOnly ? (
        <div className="nodrag flex gap-1">
          {(['whatsapp', 'url'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={target.kind === k}
              onClick={() => target.kind !== k && setTarget(k === 'url' ? { kind: 'url', url: '' } : { kind: 'whatsapp', phone: '', message: '' })}
              className={cn(
                'flex-1 cursor-pointer rounded-compact border px-2 py-1 text-meta font-medium transition-colors duration-200',
                target.kind === k ? 'border-accent bg-accent-tint text-accent' : 'border-line text-graphite hover:bg-surface-2',
              )}
            >
              {t(`link.${k}`)}
            </button>
          ))}
        </div>
      ) : null}
      {target.kind === 'whatsapp' ? (
        <>
          <InlineInput value={target.phone} placeholder={t('placeholder.phone')} maxLength={15} onChange={(v) => setTarget({ ...target, phone: v.replace(/\D/g, '') }, true)} />
          <InlineInput value={target.message} placeholder={t('placeholder.waMessage')} maxLength={LIMITS.whatsappMessage} onChange={(v) => setTarget({ ...target, message: v }, true)} />
        </>
      ) : (
        <InlineInput value={target.url} placeholder={t('placeholder.url')} maxLength={2000} onChange={(v) => setTarget({ kind: 'url', url: v.trim() }, true)} />
      )}
      <OutputRow handleId="next">
        <InlineInput value={n.data.buttonTitle} placeholder={t('link.buttonTitle')} maxLength={LIMITS.buttonTitle} onChange={(v) => a.update(id, { buttonTitle: v }, { merge: true })} />
      </OutputRow>
      <p className="text-meta text-graphite">{t('output.nextOptional')}</p>
    </NodeShell>
  );
}

function EndView({ id, data, selected }: P<'end'>) {
  const t = useTranslations('automation.flow');
  const n = data.node;
  return (
    <NodeShell id={id} selected={selected} icon={Flag} title={t('node.end')}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.endText')} />
      <p className="text-meta text-graphite">{t('endHint')}</p>
    </NodeShell>
  );
}

function TriggerView({ selected, data }: NodeProps<Node<{ trigger: TriggerConfig }, 'trigger'>>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const tr = data.trigger;
  return (
    <NodeShell id={TRIGGER_NODE_ID} selected={selected} fixed target={false} icon={Zap} title={t('node.trigger')}>
      <p className="text-compact text-ink">
        {tr.mediaIds.length ? t('trigger.posts', { count: tr.mediaIds.length }) : t('trigger.anyPost')}
        {' · '}
        {tr.keywords.length ? tr.keywords.slice(0, 4).join(', ') : t('trigger.anyComment')}
      </p>
      <p className="text-meta text-graphite">{t('trigger.repliesSummary', { count: tr.publicReplies.length })}</p>
      {!a.readOnly ? (
        <button
          type="button"
          onClick={a.openTrigger}
          className="nodrag cursor-pointer self-start rounded-compact px-2 py-1 text-meta font-medium text-accent transition-colors duration-200 hover:bg-accent-tint"
        >
          {t('trigger.edit')}
        </button>
      ) : null}
      <div className="relative h-0">
        <Handle type="source" id="next" position={Position.Right} className="flow-handle" isConnectable={false} style={{ right: -18 }} />
      </div>
    </NodeShell>
  );
}

export const NODE_TYPES = {
  trigger: TriggerView,
  opening: OpeningView,
  message: MessageView,
  question: QuestionView,
  condition: ConditionView,
  link: LinkView,
  end: EndView,
} as unknown as NodeTypes;
