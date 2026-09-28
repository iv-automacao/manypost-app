'use client';

import { CircleAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useApiErrorMessage } from '@/lib/api/errors';
import { relativeTime } from '@/lib/datetime';
import { Field, SectionTitle } from './field';
import { useFoundation, useOverview, useUpdateFoundation } from './hooks';
import { FOUNDATION_KEYS, isExpired, isFilled } from './logic';
import type { ContentFoundation, FoundationKey } from './types';

/** Fundação editorial: um documento por chave, lido pela máquina em toda geração. */
export function FoundationView() {
  const t = useTranslations('maquina');
  const tc = useTranslations('common');
  const overview = useOverview();
  const foundation = useFoundation();

  if (overview.isError) return null;
  if (overview.isPending || foundation.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (foundation.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AlertDescription>{t('foundation.loadError')}</AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void foundation.refetch()}>
            {tc('retry')}
          </Button>
        </div>
      </Alert>
    );
  }

  const docs = new Map(foundation.data.map((d) => [d.key, d]));
  const filled = FOUNDATION_KEYS.filter((k) => isFilled(docs.get(k)?.body)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-reading text-compact leading-relaxed text-graphite">{t('foundation.description')}</p>
        <Badge variant={filled === FOUNDATION_KEYS.length ? 'published' : 'review'} className="w-fit tabular-nums">
          {t('foundation.progress', { filled, total: FOUNDATION_KEYS.length })}
        </Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {FOUNDATION_KEYS.map((k) => (
          <FoundationEditor key={k} docKey={k} doc={docs.get(k) ?? null} />
        ))}
      </div>
    </div>
  );
}

function FoundationEditor({ docKey, doc }: { docKey: FoundationKey; doc: ContentFoundation | null }) {
  const t = useTranslations('maquina.foundation');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();
  const update = useUpdateFoundation();
  // null = sem edição em curso: mostra o que o servidor tem
  const [body, setBody] = useState<string | null>(null);
  const [validUntil, setValidUntil] = useState<string | null>(null);
  const comValidade = docKey === 'produtos';

  const serverBody = doc?.body ?? '';
  const serverValid = doc?.validUntil ?? '';
  const value = body ?? serverBody;
  const valid = validUntil ?? serverValid;
  const dirty = value !== serverBody || (comValidade && valid !== serverValid);
  const title = t(`keys.${docKey}.title`);
  const vencido = comValidade && isExpired(serverValid || null, new Date());

  const save = () =>
    update.mutate(
      { key: docKey, body: value, ...(comValidade ? { validUntil: valid || null } : {}) },
      {
        onSuccess: () => {
          setBody(null);
          setValidUntil(null);
          toast.success(t('saved', { title }));
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SectionTitle>{title}</SectionTitle>
          <p className="text-meta leading-relaxed text-graphite">{t(`keys.${docKey}.hint`)}</p>
        </div>
        <Badge variant={isFilled(serverBody) ? 'published' : 'neutral'} className="shrink-0">
          {isFilled(serverBody) ? t('filled') : t('empty')}
        </Badge>
      </div>
      <Textarea
        aria-label={title}
        value={value}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-48"
      />
      {comValidade ? (
        <Field
          id="cm-foundation-valid"
          label={t('validUntil')}
          hint={vencido ? undefined : t('validUntilHint')}
          error={vencido ? t('expired', { date: new Date(`${serverValid}T12:00:00`).toLocaleDateString(locale) }) : null}
          optional
        >
          <Input
            id="cm-foundation-valid"
            type="date"
            value={valid}
            onChange={(e) => setValidUntil(e.target.value)}
            className="w-44"
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-meta text-graphite">
          {doc && isFilled(serverBody) ? t('updated', { when: relativeTime(doc.updatedAt, locale) }) : null}
        </span>
        <Button variant="outline" size="sm" onClick={save} disabled={!dirty} isLoading={update.isPending}>
          {t('save')}
        </Button>
      </div>
    </Card>
  );
}
