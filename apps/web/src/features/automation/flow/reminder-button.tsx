'use client';

import { BellRing } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { LIMITS } from '../logic';
import type { FlowReminder } from './logic';

/** tempos oferecidos (minutos); o teto é 23 h por causa da janela de 24 h da Meta */
const TIMES = [5, 15, 30, 60, 120, 240, 480, 720, 1380] as const;
const DEFAULT_MINUTES = 60;

/**
 * Lembrete único do fluxo (add-flow-delay-reminder): sai uma vez para quem respondeu a abertura e
 * parou numa pergunta, com o texto daqui seguido da pergunta em que a pessoa parou.
 */
export function ReminderButton({
  reminder,
  onChange,
  readOnly,
}: {
  reminder: FlowReminder | undefined;
  /** `merge` junta a digitação num passo só do desfazer */
  onChange: (next: FlowReminder | undefined, opts?: { merge?: boolean }) => void;
  readOnly: boolean;
}) {
  const t = useTranslations('automation.flow.reminder');
  const label = (m: number) => (m < 60 ? t('minutes', { n: m }) : t('hours', { n: m / 60 }));
  const times = [...new Set([...TIMES, reminder?.afterMinutes ?? DEFAULT_MINUTES])].sort((a, b) => a - b);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <BellRing aria-hidden />
          {reminder ? t('buttonOn', { time: label(reminder.afterMinutes) }) : t('buttonOff')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <Label className="flex cursor-pointer items-center justify-between gap-2 text-compact font-medium text-ink">
          {t('toggle')}
          <Switch
            checked={Boolean(reminder)}
            disabled={readOnly}
            // `raw`: o texto padrão leva `{nome}` literal, que o ICU interpretaria
            onCheckedChange={(on) => onChange(on ? { afterMinutes: DEFAULT_MINUTES, text: t.raw('defaultText') as string } : undefined)}
          />
        </Label>
        <p className="text-meta text-graphite">{t('hint')}</p>
        {reminder ? (
          <>
            <Label className="flex flex-col gap-1 text-compact">
              {t('after')}
              <Select value={String(reminder.afterMinutes)} disabled={readOnly} onValueChange={(v) => onChange({ ...reminder, afterMinutes: Number(v) })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {times.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {label(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="flex flex-col gap-1 text-compact">
              {t('text')}
              <Textarea
                value={reminder.text}
                maxLength={LIMITS.reminderText}
                disabled={readOnly}
                onChange={(e) => onChange({ ...reminder, text: e.target.value }, { merge: true })}
              />
              <span className="self-end text-meta text-graphite">
                {reminder.text.length}/{LIMITS.reminderText}
              </span>
            </Label>
            <p className="text-meta text-graphite">{t.raw('textHint') as string}</p>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
