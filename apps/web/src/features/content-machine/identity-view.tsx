'use client';

import { ImagePlus, Pipette, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useChannels } from '@/features/channels/hooks';
import { useUploadMedia } from '@/features/media/hooks';
import { useApiErrorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { BrandPreview } from './brand-preview';
import { Field, SectionTitle } from './field';
import { useExtractPalette, useOverview, useUpdateBrand } from './hooks';
import {
  PALETTE_ROLES,
  brandDraft,
  brandPatchFrom,
  ctaWordFrom,
  hourLabel,
  invalidPaletteRoles,
  isPaletteEmpty,
  normalizeHex,
  sameDraft,
  type BrandDraft,
} from './logic';
import type { ContentBrand, ContentPalette, PaletteRole } from './types';

const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** sugestões de fuso: a região atendida primeiro; qualquer nome IANA continua valendo */
const TIMEZONES = [
  'America/Manaus',
  'America/Boa_Vista',
  'America/Belem',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Sao_Paulo',
  'America/Cuiaba',
  'America/Fortaleza',
  'America/Recife',
];
const SEM_CANAL = 'nenhum';

type LogoField = 'logoMediaId' | 'logoDarkMediaId';

export function IdentityView() {
  const overview = useOverview();
  if (overview.isPending) return <Skeleton className="h-96 rounded-card" />;
  // sem nada em cache: o shell mostra o erro com "tentar de novo". Com a identidade carregada, um
  // refetch que falhou vira aviso discreto no shell e o formulário (com o rascunho) fica montado.
  if (!overview.data) return null;
  return <IdentityForm brand={overview.data.brand} rendererOn={overview.data.capabilities.renderer} />;
}

/**
 * Identidade: rascunho local dos campos de texto, paleta e publicação (salvos juntos), e logos
 * como ações imediatas — enviar ou remover uma logo grava na hora, sem mexer no rascunho.
 */
function IdentityForm({ brand, rendererOn }: { brand: ContentBrand; rendererOn: boolean }) {
  const t = useTranslations('maquina.identity');
  const errorMessage = useApiErrorMessage();
  const channels = useChannels();
  const update = useUpdateBrand();
  const extract = useExtractPalette();
  const upload = useUploadMedia();
  const [draft, setDraft] = useState<BrandDraft>(() => brandDraft(brand));
  const [logoBusy, setLogoBusy] = useState<LogoField | null>(null);

  const dirty = !sameDraft(draft, brandDraft(brand));
  const invalid = invalidPaletteRoles(draft.palette);
  const set = <K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setPalette = (palette: ContentPalette) => setDraft((d) => ({ ...d, palette }));

  const save = () =>
    update.mutate(brandPatchFrom(draft), {
      onSuccess: (b) => {
        setDraft(brandDraft(b));
        toast.success(t('saved'));
      },
      onError: (err) => toast.error(errorMessage(err)),
    });

  const runExtract = () =>
    extract.mutate(undefined, {
      onSuccess: (b) => {
        setPalette(b.palette);
        toast.success(t('extracted'));
      },
      onError: (err) => toast.error(errorMessage(err)),
    });

  const sendLogo = async (field: LogoField, file: File) => {
    if (!LOGO_ACCEPT.split(',').includes(file.type)) {
      toast.error(t('notImage'));
      return;
    }
    setLogoBusy(field);
    try {
      const media = await upload.mutateAsync({ file });
      const saved = await update.mutateAsync(
        field === 'logoMediaId' ? { logoMediaId: media.id } : { logoDarkMediaId: media.id },
      );
      toast.success(t('uploaded'));
      // primeira logo principal sem paleta nenhuma: extrai de uma vez (nada a perder)
      if (field === 'logoMediaId' && rendererOn && isPaletteEmpty(saved.palette) && isPaletteEmpty(draft.palette)) {
        const comPaleta = await extract.mutateAsync(undefined);
        setPalette(comPaleta.palette);
        toast.success(t('extracted'));
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLogoBusy(null);
    }
  };

  const removeLogo = (field: LogoField) => {
    setLogoBusy(field);
    update.mutate(field === 'logoMediaId' ? { logoMediaId: null } : { logoDarkMediaId: null }, {
      onSuccess: () => toast.success(t('removed')),
      onError: (err) => toast.error(errorMessage(err)),
      onSettled: () => setLogoBusy(null),
    });
  };

  const extractHint = !rendererOn
    ? t('extractUnavailable')
    : !brand.logoMediaId
      ? t('extractNeedsLogo')
      : undefined;
  const sampleKeyword = ctaWordFrom(draft.ctaWord) || 'PLANO';
  const cta =
    draft.ctaChannel === 'whatsapp'
      ? t('previewCtaWhatsapp', { keyword: sampleKeyword })
      : draft.ctaChannel === 'comentario'
        ? t('previewCtaComment', { keyword: sampleKeyword })
        : t('previewCtaDirect', { keyword: sampleKeyword });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <SectionTitle>{t('brandSection')}</SectionTitle>
            <p className="text-compact text-graphite">{t('brandDescription')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cm-brand-name" label={t('name')}>
              <Input id="cm-brand-name" value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
            </Field>
            <Field id="cm-brand-slogan" label={t('slogan')} optional>
              <Input id="cm-brand-slogan" value={draft.slogan} onChange={(e) => set('slogan', e.target.value)} maxLength={200} />
            </Field>
            <Field id="cm-brand-signature" label={t('signature')} hint={t('signatureHint')} optional className="sm:col-span-2">
              <Input
                id="cm-brand-signature"
                value={draft.signature}
                onChange={(e) => set('signature', e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field id="cm-brand-tone" label={t('tone')} optional className="sm:col-span-2">
              <Textarea
                id="cm-brand-tone"
                value={draft.tone}
                onChange={(e) => set('tone', e.target.value)}
                placeholder={t('tonePlaceholder')}
                maxLength={2000}
              />
            </Field>
          </div>
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <SectionTitle>{t('logosSection')}</SectionTitle>
            <p className="text-compact text-graphite">{t('logosDescription')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <LogoPicker
              label={t('logoLight')}
              hint={t('logoLightHint')}
              url={brand.logoUrl}
              busy={logoBusy === 'logoMediaId'}
              onFile={(f) => void sendLogo('logoMediaId', f)}
              onRemove={() => removeLogo('logoMediaId')}
            />
            <LogoPicker
              label={t('logoDark')}
              hint={t('logoDarkHint')}
              url={brand.logoDarkUrl}
              dark
              darkColor={draft.palette.fundoEscuro ? (normalizeHex(draft.palette.fundoEscuro) ?? undefined) : undefined}
              busy={logoBusy === 'logoDarkMediaId'}
              onFile={(f) => void sendLogo('logoDarkMediaId', f)}
              onRemove={() => removeLogo('logoDarkMediaId')}
            />
          </div>
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <SectionTitle>{t('paletteSection')}</SectionTitle>
              <p className="text-compact text-graphite">{t('paletteDescription')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={runExtract}
              disabled={!rendererOn || !brand.logoMediaId}
              isLoading={extract.isPending}
            >
              <Pipette aria-hidden />
              {t('extract')}
            </Button>
          </div>
          {extractHint ? <p className="text-meta text-graphite">{extractHint}</p> : null}
          <PaletteEditor palette={draft.palette} invalid={invalid} onChange={setPalette} />
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <SectionTitle>{t('publishSection')}</SectionTitle>
            <p className="text-compact text-graphite">{t('publishDescription')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cm-brand-channel" label={t('channel')} hint={t('channelHint')} className="sm:col-span-2">
              <Select
                value={draft.defaultChannelId ?? SEM_CANAL}
                onValueChange={(v) => set('defaultChannelId', v === SEM_CANAL ? null : v)}
              >
                <SelectTrigger id="cm-brand-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_CANAL}>{t('noChannel')}</SelectItem>
                  {(channels.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {(c.name ?? c.username ?? c.provider) + ` · ${c.provider}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="cm-brand-cta" label={t('cta')}>
              <Select value={draft.ctaChannel} onValueChange={(v) => set('ctaChannel', v as BrandDraft['ctaChannel'])}>
                <SelectTrigger id="cm-brand-cta">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">{t('ctaDirect')}</SelectItem>
                  <SelectItem value="comentario">{t('ctaComment')}</SelectItem>
                  <SelectItem value="whatsapp">{t('ctaWhatsapp')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {draft.ctaChannel === 'whatsapp' ? (
              <Field id="cm-brand-whatsapp" label={t('whatsapp')} hint={t('whatsappHint')}>
                <Input
                  id="cm-brand-whatsapp"
                  inputMode="tel"
                  value={draft.whatsappNumber}
                  onChange={(e) => set('whatsappNumber', e.target.value)}
                  placeholder={t('whatsappPlaceholder')}
                  maxLength={20}
                />
              </Field>
            ) : (
              <div className="hidden sm:block" />
            )}
            <Field id="cm-brand-cta-word" label={t('ctaWord')} hint={t('ctaWordHint')}>
              <Input
                id="cm-brand-cta-word"
                value={draft.ctaWord}
                onChange={(e) => set('ctaWord', ctaWordFrom(e.target.value))}
                placeholder="PLANO"
                maxLength={15}
              />
            </Field>
            <Field id="cm-brand-cta-word-business" label={t('ctaWordBusiness')} hint={t('ctaWordBusinessHint')}>
              <Input
                id="cm-brand-cta-word-business"
                value={draft.ctaWordBusiness}
                onChange={(e) => set('ctaWordBusiness', ctaWordFrom(e.target.value))}
                placeholder="EMPRESA"
                maxLength={15}
              />
            </Field>
            <Field id="cm-brand-hour" label={t('publishHour')}>
              <Select value={String(draft.publishHour)} onValueChange={(v) => set('publishHour', Number(v))}>
                <SelectTrigger id="cm-brand-hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="cm-brand-timezone" label={t('timezone')} hint={t('timezoneHint')}>
              <Input
                id="cm-brand-timezone"
                list="cm-timezones"
                value={draft.timezone}
                onChange={(e) => set('timezone', e.target.value)}
                maxLength={60}
              />
              <datalist id="cm-timezones">
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
            <div className="flex items-start justify-between gap-4 rounded-control border border-line p-4 sm:col-span-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="cm-brand-auto" className="text-compact font-semibold text-ink">
                  {t('autoApprove')}
                </label>
                <p className="text-meta leading-relaxed text-graphite">{t('autoApproveHint')}</p>
              </div>
              <Switch id="cm-brand-auto" checked={draft.autoApprove} onCheckedChange={(v) => set('autoApprove', v)} />
            </div>
          </div>
        </Card>

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-main py-3">
          {dirty ? <span className="text-meta text-graphite">{t('unsaved')}</span> : null}
          <Button onClick={save} disabled={!dirty || invalid.length > 0 || !draft.name.trim()} isLoading={update.isPending && logoBusy === null}>
            {t('save')}
          </Button>
        </div>
      </div>

      <aside className="flex flex-col gap-3 xl:sticky xl:top-20 xl:self-start">
        <div className="flex flex-col gap-1">
          <SectionTitle>{t('previewSection')}</SectionTitle>
          <p className="text-meta leading-relaxed text-graphite">{t('previewDescription')}</p>
        </div>
        <BrandPreview
          name={draft.name || brand.name}
          signature={draft.signature}
          palette={draft.palette}
          logoUrl={brand.logoUrl}
          logoDarkUrl={brand.logoDarkUrl}
          cta={cta}
        />
      </aside>
    </div>
  );
}

function LogoPicker({
  label,
  hint,
  url,
  dark = false,
  darkColor,
  busy,
  onFile,
  onRemove,
}: {
  label: string;
  hint: string;
  url: string | null;
  dark?: boolean;
  darkColor?: string | undefined;
  busy: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('maquina.identity');
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-compact font-semibold text-ink">{label}</span>
      <div
        className={cn(
          'grid h-28 place-items-center overflow-hidden rounded-control border border-line p-4',
          dark ? (darkColor ? undefined : 'bg-night') : 'bg-surface-2',
        )}
        style={dark && darkColor ? { backgroundColor: darkColor } : undefined}
      >
        {url ? (
          <img src={url} alt={label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className={cn('text-meta', dark ? 'text-sidebar-muted' : 'text-graphite')}>{t('noLogo')}</span>
        )}
      </div>
      <p className="text-meta leading-relaxed text-graphite">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} isLoading={busy}>
          <ImagePlus aria-hidden />
          {url ? t('replace') : t('upload')}
        </Button>
        {url ? (
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy}>
            <Trash2 aria-hidden />
            {t('remove')}
          </Button>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={LOGO_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function PaletteEditor({
  palette,
  invalid,
  onChange,
}: {
  palette: ContentPalette;
  invalid: PaletteRole[];
  onChange: (palette: ContentPalette) => void;
}) {
  const t = useTranslations('maquina.identity');
  const setRole = (role: PaletteRole, value: string) => onChange({ ...palette, [role]: value });
  const extraidas = (palette.extraidas ?? []).map((c) => normalizeHex(c)).filter((c): c is string => c !== null);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {PALETTE_ROLES.map((role) => (
          <ColorRow
            key={role}
            role={role}
            name={t(`colors.${role}`)}
            value={palette[role] ?? ''}
            invalid={invalid.includes(role)}
            onChange={(v) => setRole(role, v)}
          />
        ))}
      </div>
      {extraidas.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-compact font-semibold text-ink">{t('extractedColors')}</span>
          <p className="text-meta text-graphite">{t('extractedHint')}</p>
          <div className="flex flex-wrap gap-2">
            {extraidas.map((hex) => (
              <DropdownMenu key={hex}>
                <DropdownMenuTrigger
                  aria-label={t('applySwatch', { hex })}
                  title={hex}
                  className="size-8 cursor-pointer rounded-control border border-line-strong outline-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  style={{ backgroundColor: hex }}
                />
                <DropdownMenuContent align="start">
                  {PALETTE_ROLES.map((role) => (
                    <DropdownMenuItem key={role} className="cursor-pointer" onSelect={() => setRole(role, hex)}>
                      {t('useAs', { name: t(`colors.${role}`) })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Uma cor da paleta: amostra clicável (seletor nativo por baixo) + código editável.
 *
 * O seletor nativo é NÃO controlado de propósito: um `<input type="color">` controlado com
 * valor vazio (papel ainda sem cor) cai no valor inválido que o navegador corrige para preto e
 * reclama no console. Sem `value`, o React não briga com o navegador; mudanças vindas de fora
 * (código digitado, cor extraída aplicada) são copiadas para o elemento pelo efeito abaixo.
 */
function ColorRow({
  role,
  name,
  value,
  invalid,
  onChange,
}: {
  role: PaletteRole;
  name: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('maquina.identity');
  const pickerRef = useRef<HTMLInputElement>(null);
  const hex = normalizeHex(value);
  const id = `cm-color-${role}`;

  useEffect(() => {
    if (pickerRef.current && hex && pickerRef.current.value !== hex) pickerRef.current.value = hex;
  }, [hex]);

  return (
    <Field id={id} label={name} error={invalid ? t('invalidHex') : null}>
      <div className="flex items-center gap-2">
        <label
          className={cn(
            'relative grid size-[38px] shrink-0 cursor-pointer place-items-center overflow-hidden rounded-control border border-line-strong',
            !hex && 'bg-surface-2',
          )}
          style={hex ? { backgroundColor: hex } : undefined}
        >
          <input
            ref={pickerRef}
            type="color"
            defaultValue={hex ?? undefined}
            onChange={(e) => onChange(e.target.value)}
            aria-label={t('pickColor', { name })}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
          {!hex ? <Plus className="size-4 text-graphite" aria-hidden /> : null}
        </label>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#RRGGBB"
          aria-invalid={invalid || undefined}
          maxLength={7}
          spellCheck={false}
          className="tabular-nums"
        />
      </div>
    </Field>
  );
}
