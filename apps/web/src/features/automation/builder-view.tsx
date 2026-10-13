'use client';

import { ArrowDown, ArrowUp, Check, FlaskConical, ImageIcon, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
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
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useRecentMedia } from '@/features/engagement/hooks';
import { captionPreview } from '@/features/engagement/logic';
import { EngagementError, NoEligibleChannel, useEngagementChannel } from '@/features/engagement/shared';
import { useApiErrorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { ConversationPreview } from './conversation-preview';
import {
  useAutomation,
  useCreateAutomation,
  useDeleteAutomation,
  useSetAutomationStatus,
  useUpdateAutomation,
} from './hooks';
import {
  LIMITS,
  TEXT_VALIDATIONS,
  type Draft,
  type Question,
  type Status,
  configFromDraft,
  draftFromConfig,
  draftIssues,
  emptyDraft,
  fieldFromPrompt,
  splitKeywords,
  splitUsernames,
  statusVariant,
} from './logic';

function Field({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-meta leading-relaxed text-graphite">{hint}</p> : null}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-panel font-medium text-ink">{title}</h3>
        {description ? <p className="text-compact text-graphite">{description}</p> : null}
      </div>
      {children}
    </Card>
  );
}

/** grade dos posts recentes para escolher onde a automação vale */
function MediaPicker({
  channelId,
  selected,
  onToggle,
}: {
  channelId: string;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const t = useTranslations('automation');
  const te = useTranslations('engagement');
  const media = useRecentMedia(channelId);
  if (media.isPending) return <Skeleton className="h-32 rounded-lg" />;
  if (media.isError) return <EngagementError error={media.error} onRetry={() => void media.refetch()} />;
  const items = media.data.pages.flatMap((p) => p.items);
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {items.map((m) => {
          const on = selected.includes(m.id);
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onToggle(m.id)}
                aria-pressed={on}
                title={captionPreview(m.caption, 80) || te('noCaption')}
                className={cn(
                  'relative flex aspect-square w-full cursor-pointer items-center justify-center overflow-hidden rounded-compact border-2 bg-surface-2 outline-none transition-colors duration-200',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  on ? 'border-accent' : 'border-transparent hover:border-line-strong',
                )}
              >
                {m.previewUrl ? (
                  <img src={m.previewUrl} alt="" className="size-full object-cover" />
                ) : (
                  <ImageIcon className="size-5 text-mist" aria-hidden />
                )}
                {on ? (
                  <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-compact bg-accent text-paper">
                    <Check className="size-3.5" aria-hidden />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-meta text-graphite">{t('mediaSelected', { count: selected.length })}</span>
        {media.hasNextPage ? (
          <Button variant="outline" size="sm" onClick={() => void media.fetchNextPage()} isLoading={media.isFetchingNextPage}>
            {te('loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function QuestionEditor({
  q,
  index,
  total,
  taken,
  onChange,
  onMove,
  onRemove,
}: {
  q: Question;
  index: number;
  total: number;
  taken: string[];
  onChange: (q: Question) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('automation');
  const base = `q-${index}`;
  const setKind = (kind: Question['kind']) => {
    if (kind === q.kind) return;
    onChange(
      kind === 'choice'
        ? { kind, field: q.field, prompt: q.prompt, options: [{ title: t('optionSample1') }, { title: t('optionSample2') }] }
        : { kind, field: q.field, prompt: q.prompt, validate: 'free' },
    );
  };
  return (
    <div className="flex flex-col gap-3 rounded-control border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-compact font-semibold text-ink">{t('questionN', { n: index + 1 })}</span>
        <div className="flex items-center gap-1">
          <Select value={q.kind} onValueChange={(v) => setKind(v as Question['kind'])}>
            <SelectTrigger className="h-8 w-40" aria-label={t('questionKind')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="choice">{t('kindChoice')}</SelectItem>
              <SelectItem value="text">{t('kindText')}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(-1)} disabled={index === 0} aria-label={t('moveUp')}>
            <ArrowUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={t('moveDown')}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={t('removeQuestion')}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      <Field id={`${base}-prompt`} label={t('questionPrompt')}>
        <Textarea
          id={`${base}-prompt`}
          rows={2}
          maxLength={LIMITS.messageText}
          value={q.prompt}
          onChange={(e) => {
            const prompt = e.target.value;
            // campo acompanha a pergunta enquanto ninguém o editou à mão
            const auto = q.field === fieldFromPrompt(q.prompt, taken);
            onChange({ ...q, prompt, ...(auto ? { field: fieldFromPrompt(prompt, taken) } : {}) });
          }}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${base}-field`} label={t('questionField')} hint={t('questionFieldHint', { token: `{${q.field}}` })}>
          <Input
            id={`${base}-field`}
            value={q.field}
            maxLength={32}
            onChange={(e) => onChange({ ...q, field: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
          />
        </Field>
        {q.kind === 'text' ? (
          <Field id={`${base}-validate`} label={t('questionValidate')}>
            <Select value={q.validate} onValueChange={(v) => onChange({ ...q, validate: v as typeof q.validate })}>
              <SelectTrigger id={`${base}-validate`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEXT_VALIDATIONS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`validate.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>
      {q.kind === 'choice' ? (
        <div className="flex flex-col gap-2">
          <Label>{t('options')}</Label>
          {q.options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t('optionN', { n: i + 1 })}
                value={o.title}
                maxLength={LIMITS.buttonTitle}
                onChange={(e) =>
                  onChange({ ...q, options: q.options.map((x, j) => (j === i ? { title: e.target.value } : x)) })
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={q.options.length <= 1}
                onClick={() => onChange({ ...q, options: q.options.filter((_, j) => j !== i) })}
                aria-label={t('removeOption')}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-meta text-graphite">
              {q.options.length > LIMITS.maxButtons ? t('optionsAsChips') : t('optionsAsButtons')}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={q.options.length >= LIMITS.maxOptions}
              onClick={() => onChange({ ...q, options: [...q.options, { title: '' }] })}
            >
              <Plus aria-hidden />
              {t('addOption')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface FormState {
  name: string;
  channelId: string | undefined;
  draft: Draft;
  keywordsText: string;
  testText: string;
  anyPost: boolean;
}

function fromAutomation(a: {
  name: string;
  channelId: string;
  config: Parameters<typeof draftFromConfig>[0] | null;
  testUsernames: string[];
}): FormState {
  const draft = a.config ? draftFromConfig(a.config) : emptyDraft();
  return {
    name: a.name,
    channelId: a.channelId,
    draft,
    keywordsText: draft.trigger.keywords.join(', '),
    testText: a.testUsernames.map((u) => `@${u}`).join(', '),
    anyPost: draft.trigger.mediaIds.length === 0,
  };
}

const serialize = (f: FormState) =>
  JSON.stringify({
    name: f.name.trim(),
    channelId: f.channelId,
    config: configFromDraft({
      ...f.draft,
      trigger: { keywords: splitKeywords(f.keywordsText), mediaIds: f.anyPost ? [] : f.draft.trigger.mediaIds },
    }),
    test: splitUsernames(f.testText),
  });

function StatusBar({ id, status, dirty, hasTesters }: { id: string; status: Status; dirty: boolean; hasTesters: boolean }) {
  const t = useTranslations('automation');
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const setStatus = useSetAutomationStatus(id);
  const remove = useDeleteAutomation();
  const change = (s: Status) =>
    setStatus.mutate(s, {
      onSuccess: () => toast.success(t(`statusChanged.${s}`)),
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-compact text-graphite">{t('statusLabel')}</span>
          <Badge variant={statusVariant(status)}>{t(`status.${status}`)}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status !== 'TEST' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={dirty || !hasTesters}
              isLoading={setStatus.isPending && setStatus.variables === 'TEST'}
              onClick={() => change('TEST')}
            >
              <FlaskConical aria-hidden />
              {t('actionTest')}
            </Button>
          ) : null}
          {status !== 'ACTIVE' ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" disabled={dirty}>
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
            <Button
              variant="outline"
              size="sm"
              isLoading={setStatus.isPending && setStatus.variables === 'PAUSED'}
              onClick={() => change('PAUSED')}
            >
              <Pause aria-hidden />
              {t('actionPause')}
            </Button>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={t('actionDelete')}>
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
        </div>
      </div>
      {dirty ? <p className="text-meta text-graphite">{t('saveBeforeStatus')}</p> : null}
      {!hasTesters && status !== 'TEST' ? <p className="text-meta text-graphite">{t('testNeedsUsers')}</p> : null}
    </Card>
  );
}

function BuilderForm({
  id,
  initial,
  status,
}: {
  id: string | undefined;
  initial: FormState;
  status: Status | undefined;
}) {
  const t = useTranslations('automation');
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const ch = useEngagementChannel('comments');
  const create = useCreateAutomation();
  const update = useUpdateAutomation(id);
  const [form, setForm] = useState<FormState>(initial);
  const [saved, setSaved] = useState(() => serialize(initial));

  const channelId = form.channelId ?? ch.selected?.id;
  const channel = ch.list.find((c) => c.id === channelId);
  const draft: Draft = {
    ...form.draft,
    trigger: { keywords: splitKeywords(form.keywordsText), mediaIds: form.anyPost ? [] : form.draft.trigger.mediaIds },
  };
  const issues = draftIssues(draft);
  const current = serialize({ ...form, channelId });
  const dirty = current !== saved;
  const testers = splitUsernames(form.testText);

  const setDraft = (fn: (d: Draft) => Draft) => setForm((f) => ({ ...f, draft: fn(f.draft) }));
  const setQuestions = (fn: (qs: Question[]) => Question[]) => setDraft((d) => ({ ...d, questions: fn(d.questions) }));
  const fields = draft.questions.map((q) => q.field);

  const save = () => {
    if (!channelId || issues.length > 0 || !form.name.trim()) return;
    const body = { name: form.name.trim(), config: configFromDraft(draft), testUsernames: testers };
    if (!id) {
      create.mutate(
        { ...body, channelId },
        {
          onSuccess: (a) => {
            toast.success(t('created'));
            router.push(`/automacoes/${a.id}`);
          },
          onError: (e) => toast.error(errorMessage(e)),
        },
      );
      return;
    }
    update.mutate(body, {
      onSuccess: () => {
        setSaved(current);
        toast.success(t('saved'));
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  if (ch.isPending) return <Skeleton className="h-96 rounded-lg" />;
  if (ch.error) return <EngagementError error={ch.error} onRetry={ch.refetch} />;
  if (!channel) return <NoEligibleChannel />;
  const account = channel.username ? `@${channel.username}` : (channel.name ?? '');

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-6">
        {id && status ? (
          <StatusBar id={id} status={status} dirty={dirty} hasTesters={testers.length > 0} />
        ) : null}

        <Section title={t('sectionBasics')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="au-name" label={t('name')}>
              <Input
                id="au-name"
                value={form.name}
                maxLength={LIMITS.name}
                placeholder={t('namePlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field id="au-channel" label={t('channel')}>
              <Select
                value={channelId}
                disabled={Boolean(id)}
                onValueChange={(v) => setForm((f) => ({ ...f, channelId: v, draft: { ...f.draft, trigger: { ...f.draft.trigger, mediaIds: [] } } }))}
              >
                <SelectTrigger id="au-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ch.list.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.username ? `@${c.username}` : (c.name ?? c.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </Section>

        <Section title={t('sectionTrigger')} description={t('sectionTriggerHint')}>
          <RadioGroup
            value={form.anyPost ? 'any' : 'selected'}
            onValueChange={(v) => setForm((f) => ({ ...f, anyPost: v === 'any' }))}
            className="flex flex-col gap-2"
          >
            <label className="flex cursor-pointer items-center gap-2 text-compact text-ink">
              <RadioGroupItem value="any" />
              {t('anyPost')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-compact text-ink">
              <RadioGroupItem value="selected" />
              {t('selectedPosts')}
            </label>
          </RadioGroup>
          {!form.anyPost ? (
            <MediaPicker
              channelId={channel.id}
              selected={form.draft.trigger.mediaIds}
              onToggle={(mid) =>
                setDraft((d) => {
                  const has = d.trigger.mediaIds.includes(mid);
                  const mediaIds = has ? d.trigger.mediaIds.filter((x) => x !== mid) : [...d.trigger.mediaIds, mid];
                  return { ...d, trigger: { ...d.trigger, mediaIds } };
                })
              }
            />
          ) : null}
          <Field id="au-keywords" label={t('keywords')} hint={t('keywordsHint')}>
            <Textarea
              id="au-keywords"
              rows={2}
              value={form.keywordsText}
              placeholder={t('keywordsPlaceholder')}
              onChange={(e) => setForm((f) => ({ ...f, keywordsText: e.target.value }))}
            />
          </Field>
        </Section>

        <Section title={t('sectionPublic')} description={t('sectionPublicHint')}>
          {draft.publicReplies.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <Textarea
                aria-label={t('publicReplyN', { n: i + 1 })}
                rows={2}
                maxLength={LIMITS.publicReply}
                value={r}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, publicReplies: d.publicReplies.map((x, j) => (j === i ? e.target.value : x)) }))
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDraft((d) => ({ ...d, publicReplies: d.publicReplies.filter((_, j) => j !== i) }))}
                aria-label={t('removePublicReply')}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={draft.publicReplies.length >= LIMITS.maxPublicReplies}
              onClick={() => setDraft((d) => ({ ...d, publicReplies: [...d.publicReplies, ''] }))}
            >
              <Plus aria-hidden />
              {t('addPublicReply')}
            </Button>
          </div>
        </Section>

        <Section title={t('sectionOpening')} description={t('sectionOpeningHint')}>
          <Field id="au-opening" label={t('openingText')}>
            <Textarea
              id="au-opening"
              rows={3}
              maxLength={LIMITS.messageText}
              value={draft.opening.text}
              onChange={(e) => setDraft((d) => ({ ...d, opening: { ...d.opening, text: e.target.value } }))}
            />
          </Field>
          <RadioGroup
            value={draft.opening.mode}
            onValueChange={(v) => setDraft((d) => ({ ...d, opening: { ...d.opening, mode: v as 'button' | 'text' } }))}
            className="flex flex-col gap-2"
          >
            <label className="flex cursor-pointer items-start gap-2 text-compact text-ink">
              <RadioGroupItem value="button" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                {t('modeButton')}
                <span className="text-meta text-graphite">{t('modeButtonHint')}</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-compact text-ink">
              <RadioGroupItem value="text" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                {t('modeText')}
                <span className="text-meta text-graphite">{t('modeTextHint')}</span>
              </span>
            </label>
          </RadioGroup>
          {draft.opening.mode === 'button' ? (
            <Field id="au-button" label={t('buttonTitle')} hint={t('buttonTitleHint', { max: LIMITS.buttonTitle })}>
              <Input
                id="au-button"
                maxLength={LIMITS.buttonTitle}
                value={draft.opening.buttonTitle}
                onChange={(e) => setDraft((d) => ({ ...d, opening: { ...d.opening, buttonTitle: e.target.value } }))}
              />
            </Field>
          ) : null}
          <div className="flex items-start justify-between gap-4 rounded-control border border-line p-4">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="au-disclosure" className="text-compact font-semibold text-ink">
                {t('disclosure')}
              </label>
              <p className="text-meta leading-relaxed text-graphite">{t('disclosureHint')}</p>
            </div>
            <Switch
              id="au-disclosure"
              checked={draft.disclosure}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, disclosure: v }))}
            />
          </div>
        </Section>

        <Section title={t('sectionQuestions')} description={t('sectionQuestionsHint')}>
          {draft.questions.map((q, i) => (
            <QuestionEditor
              key={i}
              q={q}
              index={i}
              total={draft.questions.length}
              taken={fields.filter((_, j) => j !== i)}
              onChange={(nq) => setQuestions((qs) => qs.map((x, j) => (j === i ? nq : x)))}
              onMove={(dir) =>
                setQuestions((qs) => {
                  const next = [...qs];
                  const [item] = next.splice(i, 1);
                  next.splice(i + dir, 0, item!);
                  return next;
                })
              }
              onRemove={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={draft.questions.length >= LIMITS.maxQuestions}
              onClick={() =>
                setQuestions((qs) => [
                  ...qs,
                  {
                    kind: 'choice',
                    field: fieldFromPrompt(t('choiceSample'), fields),
                    prompt: t('choiceSample'),
                    options: [{ title: t('optionSample1') }, { title: t('optionSample2') }],
                  },
                ])
              }
            >
              <Plus aria-hidden />
              {t('addChoice')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={draft.questions.length >= LIMITS.maxQuestions}
              onClick={() =>
                setQuestions((qs) => [
                  ...qs,
                  { kind: 'text', field: fieldFromPrompt(t('textSample'), fields), prompt: t('textSample'), validate: 'phone' },
                ])
              }
            >
              <Plus aria-hidden />
              {t('addText')}
            </Button>
          </div>
        </Section>

        <Section title={t('sectionFinish')} description={t('sectionFinishHint')}>
          <Field id="au-finish" label={t('finishText')} hint={t('templateHint', { fields: fields.map((f) => `{${f}}`).join(' ') || '—' })}>
            <Textarea
              id="au-finish"
              rows={3}
              maxLength={LIMITS.messageText}
              value={draft.finish.text}
              onChange={(e) => setDraft((d) => ({ ...d, finish: { ...d.finish, text: e.target.value } }))}
            />
          </Field>
          <div className="flex items-start justify-between gap-4 rounded-control border border-line p-4">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="au-wa" className="text-compact font-semibold text-ink">
                {t('whatsapp')}
              </label>
              <p className="text-meta leading-relaxed text-graphite">{t('whatsappHint')}</p>
            </div>
            <Switch
              id="au-wa"
              checked={draft.finish.whatsappEnabled}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, finish: { ...d.finish, whatsappEnabled: v } }))}
            />
          </div>
          {draft.finish.whatsappEnabled ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="au-wa-phone" label={t('whatsappPhone')} hint={t('whatsappPhoneHint')}>
                <Input
                  id="au-wa-phone"
                  inputMode="numeric"
                  value={draft.finish.whatsapp.phone}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      finish: { ...d.finish, whatsapp: { ...d.finish.whatsapp, phone: e.target.value.replace(/\D/g, '') } },
                    }))
                  }
                />
              </Field>
              <Field id="au-wa-button" label={t('buttonTitle')}>
                <Input
                  id="au-wa-button"
                  maxLength={LIMITS.buttonTitle}
                  value={draft.finish.whatsapp.buttonTitle}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      finish: { ...d.finish, whatsapp: { ...d.finish.whatsapp, buttonTitle: e.target.value } },
                    }))
                  }
                />
              </Field>
              <Field id="au-wa-msg" label={t('whatsappMessage')} className="sm:col-span-2">
                <Textarea
                  id="au-wa-msg"
                  rows={2}
                  maxLength={LIMITS.whatsappMessage}
                  value={draft.finish.whatsapp.message}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      finish: { ...d.finish, whatsapp: { ...d.finish.whatsapp, message: e.target.value } },
                    }))
                  }
                />
              </Field>
            </div>
          ) : null}
        </Section>

        <Section title={t('sectionTest')} description={t('sectionTestHint')}>
          <Field id="au-testers" label={t('testers')}>
            <Input
              id="au-testers"
              value={form.testText}
              placeholder="@sua.conta"
              onChange={(e) => setForm((f) => ({ ...f, testText: e.target.value }))}
            />
          </Field>
        </Section>

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-main py-3">
          {issues.length > 0 ? (
            <ul className="mr-auto flex flex-col gap-0.5 text-meta text-state-failed">
              {issues.map((iss, i) => (
                <li key={i}>
                  {iss.question === undefined ? t(`issues.${iss.key}`) : t(`issues.${iss.key}`, { n: iss.question + 1 })}
                </li>
              ))}
            </ul>
          ) : dirty ? (
            <span className="text-meta text-graphite">{t('unsaved')}</span>
          ) : null}
          <Button asChild variant="ghost">
            <Link href="/automacoes">{t('back')}</Link>
          </Button>
          <Button
            onClick={save}
            disabled={(!dirty && Boolean(id)) || issues.length > 0 || !form.name.trim()}
            isLoading={create.isPending || update.isPending}
          >
            {id ? t('save') : t('create')}
          </Button>
        </div>
      </div>

      <div className="xl:sticky xl:top-4 xl:self-start">
        <ConversationPreview draft={draft} account={account} />
      </div>
    </div>
  );
}

export function AutomationBuilder({ id }: { id?: string }) {
  const t = useTranslations('automation');
  const automation = useAutomation(id);
  const errorMessage = useApiErrorMessage();
  const [initial, setInitial] = useState<FormState | null>(() =>
    id
      ? null
      : {
          name: '',
          channelId: undefined,
          draft: emptyDraft(),
          keywordsText: emptyDraft().trigger.keywords.join(', '),
          testText: '',
          anyPost: true,
        },
  );
  useEffect(() => {
    if (id && automation.data && !initial) setInitial(fromAutomation(automation.data));
  }, [id, automation.data, initial]);
  const title = useMemo(() => (id ? (automation.data?.name ?? t('editTitle')) : t('newTitle')), [id, automation.data, t]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={t('builderSubtitle')} />
      {id && automation.isError ? (
        <p className="text-compact text-state-failed">{errorMessage(automation.error)}</p>
      ) : !initial ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : (
        <BuilderForm id={id} initial={initial} status={automation.data?.status} />
      )}
    </div>
  );
}
