'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useApiErrorMessage } from '@/lib/api/errors';
import { toLocalInput } from '@/lib/datetime';
import { Field } from './field';
import { useCreatePiece, usePlanWeek } from './hooks';
import { FORMATS, MARKETS, isMonday, isoFromLocalInput, nextMonday } from './logic';
import type { PieceFormat } from './types';

/** valor do Select para "sem mercado": o Radix não aceita item com valor vazio */
const PADRAO = 'padrao';

function MarketSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const t = useTranslations('maquina');
  return (
    <Select value={value || PADRAO} onValueChange={(v) => onChange(v === PADRAO ? '' : v)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PADRAO}>{t('newIdea.marketDefault')}</SelectItem>
        {MARKETS.map((m) => (
          <SelectItem key={m} value={m}>
            {t(`market.${m}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Nova ideia: cria a peça em `ideia`; a esteira começa sozinha no servidor. */
export function NewIdeaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('maquina');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('newIdea.title')}</DialogTitle>
          <DialogDescription>{t('newIdea.description')}</DialogDescription>
        </DialogHeader>
        {/* o formulário só monta com o diálogo aberto: fechar descarta o rascunho */}
        {open ? <NewIdeaForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewIdeaForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const errorMessage = useApiErrorMessage();
  const create = useCreatePiece();
  const [format, setFormat] = useState<PieceFormat>('carrossel');
  const [hook, setHook] = useState('');
  const [angle, setAngle] = useState('');
  const [pillar, setPillar] = useState('');
  const [icp, setIcp] = useState('');
  const [market, setMarket] = useState('');
  const [date, setDate] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hook.trim()) return;
    const scheduledFor = isoFromLocalInput(date);
    create.mutate(
      {
        format,
        hook: hook.trim(),
        ...(angle.trim() ? { angle: angle.trim() } : {}),
        ...(pillar.trim() ? { pillar: pillar.trim() } : {}),
        ...(icp.trim() ? { icp: icp.trim() } : {}),
        ...(market ? { market } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t('newIdea.created'));
          onDone();
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id="cm-idea-format" label={t('newIdea.format')}>
        <Select value={format} onValueChange={(v) => setFormat(v as PieceFormat)}>
          <SelectTrigger id="cm-idea-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORMATS.map((f) => (
              <SelectItem key={f} value={f}>
                {t(`format.${f}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="cm-idea-hook" label={t('newIdea.hook')}>
        <Textarea
          id="cm-idea-hook"
          value={hook}
          onChange={(e) => setHook(e.target.value)}
          placeholder={t('newIdea.hookPlaceholder')}
          maxLength={500}
          required
          autoFocus
        />
      </Field>
      <Field id="cm-idea-angle" label={t('newIdea.angle')} optional>
        <Textarea
          id="cm-idea-angle"
          value={angle}
          onChange={(e) => setAngle(e.target.value)}
          placeholder={t('newIdea.anglePlaceholder')}
          maxLength={1000}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cm-idea-pillar" label={t('newIdea.pillar')} optional>
          <Input id="cm-idea-pillar" value={pillar} onChange={(e) => setPillar(e.target.value)} maxLength={40} />
        </Field>
        <Field id="cm-idea-icp" label={t('newIdea.icp')} optional>
          <Input
            id="cm-idea-icp"
            value={icp}
            onChange={(e) => setIcp(e.target.value)}
            placeholder={t('newIdea.icpPlaceholder')}
            maxLength={40}
          />
        </Field>
        <Field id="cm-idea-market" label={t('newIdea.market')} optional>
          <MarketSelect id="cm-idea-market" value={market} onChange={setMarket} />
        </Field>
        <Field id="cm-idea-date" label={t('newIdea.date')} optional>
          <DateTimePicker id="cm-idea-date" value={date} onChange={setDate} min={toLocalInput(new Date())} />
        </Field>
      </div>
      <p className="text-meta leading-relaxed text-graphite">{t('newIdea.dateHint')}</p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button type="submit" isLoading={create.isPending} disabled={!hook.trim()}>
          {t('newIdea.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Pauta da semana: a API enfileira a geração (temas pela fundação, mix padrão) e responde na hora;
 * as peças chegam ao quadro pelo polling.
 */
export function PlanWeekDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('maquina');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('plan.title')}</DialogTitle>
          <DialogDescription>{t('plan.description')}</DialogDescription>
        </DialogHeader>
        {open ? <PlanWeekForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PlanWeekForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const errorMessage = useApiErrorMessage();
  const plan = usePlanWeek();
  const [weekStart, setWeekStart] = useState(() => nextMonday(new Date()));
  const [market, setMarket] = useState('');
  const valid = isMonday(weekStart);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    plan.mutate(
      { weekStart, ...(market ? { market } : {}) },
      {
        // 202: a pauta entrou na fila; o quadro acelera o polling até as peças aparecerem
        onSuccess: () => {
          toast.success(t('plan.queued'));
          onDone();
        },
        // 409 (semana já planejada ou em planejamento): a mensagem da API explica; o diálogo fica aberto
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id="cm-plan-week" label={t('plan.weekStart')} error={weekStart && !valid ? t('plan.notMonday') : null}>
        <Input
          id="cm-plan-week"
          type="date"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          aria-invalid={!valid || undefined}
          required
        />
      </Field>
      <Field id="cm-plan-market" label={t('plan.market')} optional>
        <MarketSelect id="cm-plan-market" value={market} onChange={setMarket} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button type="submit" isLoading={plan.isPending} disabled={!valid}>
          {t('plan.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
