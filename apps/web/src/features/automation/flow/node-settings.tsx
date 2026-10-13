'use client';

import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LIMITS, TEXT_VALIDATIONS } from '../logic';
import { useFlowActions } from './actions';
import type { NodeOf } from './logic';

/** opções avançadas do balão (decisão `painel-opcoes`): formato, guardar em, se digitar, modo da abertura */
export function NodeSettings({ node }: { node: NodeOf<'opening'> | NodeOf<'message'> | NodeOf<'question'> }) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  if (a.readOnly) return null;
  const set = (patch: Record<string, unknown>) => a.update(node.id, patch);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('settings')}
          className="nodrag flex size-7 cursor-pointer items-center justify-center rounded-compact text-graphite transition-colors duration-200 hover:bg-surface-2 hover:text-accent"
        >
          <Settings2 className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="nokey flex w-80 flex-col gap-4">
        {node.type === 'opening' ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-compact font-medium text-ink">{t('settingsPanel.openingMode')}</legend>
              <RadioGroup value={node.data.mode} onValueChange={(v) => set({ mode: v })}>
                {(['text', 'button'] as const).map((m) => (
                  <Label key={m} className="flex cursor-pointer items-center gap-2 text-compact">
                    <RadioGroupItem value={m} />
                    {t(m === 'text' ? 'settingsPanel.modeText' : 'settingsPanel.modeButton')}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
            {node.data.mode === 'button' ? (
              <Label className="flex flex-col gap-1 text-compact">
                {t('settingsPanel.buttonTitle')}
                <Input value={node.data.buttonTitle} maxLength={LIMITS.buttonTitle} onChange={(e) => a.update(node.id, { buttonTitle: e.target.value }, { merge: true })} onBlur={a.seal} />
              </Label>
            ) : null}
            <Label className="flex cursor-pointer items-center justify-between gap-2 text-compact">
              {t('settingsPanel.disclosure')}
              <Switch checked={node.data.disclosure} onCheckedChange={(v) => set({ disclosure: v })} />
            </Label>
          </>
        ) : null}

        {node.type === 'message' ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-compact font-medium text-ink">{t('settingsPanel.format')}</legend>
              <RadioGroup
                value={node.data.format}
                onValueChange={(v) => {
                  if (v === 'none') set({ format: 'none', options: [] });
                  else if (node.data.format === 'none') set({ format: v, options: [{ id: 'o1', title: t('defaults.option') }] });
                  else set({ format: v });
                }}
              >
                {(['buttons', 'quick', 'none'] as const).map((f) => (
                  <Label key={f} className="flex cursor-pointer items-center gap-2 text-compact">
                    <RadioGroupItem value={f} disabled={f === 'buttons' && node.data.options.length > LIMITS.maxButtons} />
                    {t(f === 'buttons' ? 'settingsPanel.formatButtons' : f === 'quick' ? 'settingsPanel.formatQuick' : 'settingsPanel.formatNone')}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
            {node.data.format !== 'none' ? (
              <>
                <Label className="flex flex-col gap-1 text-compact">
                  {t('settingsPanel.saveTo')}
                  <Input
                    value={node.data.saveTo ?? ''}
                    placeholder={t('settingsPanel.saveToHint')}
                    maxLength={32}
                    onChange={(e) => a.update(node.id, { saveTo: e.target.value.toLowerCase() || undefined }, { merge: true })}
                    onBlur={a.seal}
                  />
                </Label>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-compact font-medium text-ink">{t('settingsPanel.onTyped')}</legend>
                  <RadioGroup value={node.data.onTyped} onValueChange={(v) => set({ onTyped: v })}>
                    {(['reask', 'branch'] as const).map((m) => (
                      <Label key={m} className="flex cursor-pointer items-center gap-2 text-compact">
                        <RadioGroupItem value={m} />
                        {t(m === 'reask' ? 'settingsPanel.onTypedReask' : 'settingsPanel.onTypedBranch')}
                      </Label>
                    ))}
                  </RadioGroup>
                </fieldset>
              </>
            ) : null}
          </>
        ) : null}

        {node.type === 'question' ? (
          <>
            <Label className="flex flex-col gap-1 text-compact">
              {t('settingsPanel.field')}
              <Input value={node.data.field} maxLength={32} onChange={(e) => a.update(node.id, { field: e.target.value.toLowerCase() }, { merge: true })} onBlur={a.seal} />
            </Label>
            <Label className="flex flex-col gap-1 text-compact">
              {t('settingsPanel.validate')}
              <Select value={node.data.validate} onValueChange={(v) => set({ validate: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEXT_VALIDATIONS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`settingsPanel.validation.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
