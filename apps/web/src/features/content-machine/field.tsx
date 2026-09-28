'use client';

import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** rótulo + controle + dica/erro — o arranjo repetido em todos os formulários da máquina */
export function Field({
  id,
  label,
  optional = false,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string | undefined;
  error?: string | null | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('maquina');
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Label htmlFor={id} className="flex items-center gap-2">
        {label}
        {optional ? <span className="text-meta font-normal text-graphite">{t('optional')}</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-meta leading-relaxed text-state-failed">{error}</p>
      ) : hint ? (
        <p className="text-meta leading-relaxed text-graphite">{hint}</p>
      ) : null}
    </div>
  );
}

/** título de seção dentro de cards e do detalhe da peça */
export function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn('text-panel font-medium text-ink', className)}>{children}</h3>;
}
