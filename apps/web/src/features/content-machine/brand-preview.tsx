'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { normalizeHex } from './logic';
import type { ContentPalette } from './types';

/** cor do papel quando é um #RRGGBB válido; senão o componente cai no token do brand */
const cor = (palette: ContentPalette, role: keyof Omit<ContentPalette, 'extraidas'>) => {
  const v = palette[role];
  return v ? (normalizeHex(v) ?? undefined) : undefined;
};

/**
 * Prévia em HTML/CSS: capa (fundo escuro) e fechamento (fundo claro) de um carrossel com a
 * paleta em edição. As cores são DADOS da organização — entram por `style`, nunca como classe;
 * papel vazio usa o token equivalente do brand. Não é a arte final: ela sai do renderizador.
 */
export function BrandPreview({
  name,
  signature,
  palette,
  logoUrl,
  logoDarkUrl,
  cta,
}: {
  name: string;
  signature: string;
  palette: ContentPalette;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  cta: string;
}) {
  const t = useTranslations('maquina.identity');
  const fundoEscuro = cor(palette, 'fundoEscuro');
  const fundoClaro = cor(palette, 'fundoClaro');
  const destaque = cor(palette, 'destaque');
  const primaria = cor(palette, 'primaria');
  const texto = cor(palette, 'texto');
  const textoSuave = cor(palette, 'textoSuave');
  // capa escura: logo para fundo escuro; sem ela, a principal
  const logoCapa = logoDarkUrl ?? logoUrl;

  return (
    <div className="grid grid-cols-2 gap-3">
      <figure className="flex flex-col gap-2">
        <div
          className={cn('flex aspect-[4/5] flex-col justify-between overflow-hidden rounded-control p-4', !fundoEscuro && 'bg-night')}
          style={fundoEscuro ? { backgroundColor: fundoEscuro } : undefined}
        >
          <div className="flex items-center justify-between gap-2">
            {logoCapa ? (
              <img src={logoCapa} alt="" className="h-6 max-w-[60%] object-contain object-left" />
            ) : (
              <span className={cn('truncate text-meta font-semibold', !fundoClaro && 'text-paper')} style={fundoClaro ? { color: fundoClaro } : undefined}>
                {name}
              </span>
            )}
            <span className={cn('text-meta font-medium', !destaque && 'text-accent-on-dark')} style={destaque ? { color: destaque } : undefined}>
              {t('previewKicker')}
            </span>
          </div>
          <p className={cn('text-panel font-semibold leading-snug', !fundoClaro && 'text-paper')} style={fundoClaro ? { color: fundoClaro } : undefined}>
            {t('previewTitle')}{' '}
            <span className={cn(!destaque && 'text-accent-on-dark')} style={destaque ? { color: destaque } : undefined}>
              {t('previewHighlight')}
            </span>
          </p>
          <span className={cn('text-meta opacity-70', !fundoClaro && 'text-paper')} style={fundoClaro ? { color: fundoClaro } : undefined}>
            {t('previewSwipe')} →
          </span>
        </div>
        <figcaption className="text-meta text-graphite">{t('previewCover')}</figcaption>
      </figure>

      <figure className="flex flex-col gap-2">
        <div
          className={cn('flex aspect-[4/5] flex-col justify-between overflow-hidden rounded-control border border-line p-4', !fundoClaro && 'bg-surface')}
          style={fundoClaro ? { backgroundColor: fundoClaro } : undefined}
        >
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-6 max-w-[60%] object-contain object-left" />
          ) : (
            <span className={cn('truncate text-meta font-semibold', !texto && 'text-ink')} style={texto ? { color: texto } : undefined}>
              {name}
            </span>
          )}
          <div className="flex flex-col gap-2">
            <span className={cn('text-compact font-semibold leading-snug', !texto && 'text-ink')} style={texto ? { color: texto } : undefined}>
              {name}
            </span>
            {signature ? (
              <span className={cn('text-meta leading-relaxed', !textoSuave && 'text-graphite')} style={textoSuave ? { color: textoSuave } : undefined}>
                {signature}
              </span>
            ) : null}
          </div>
          <span
            className={cn('w-fit rounded-control px-3 py-1.5 text-meta font-semibold', !primaria && 'bg-accent', !fundoClaro && 'text-paper')}
            style={{
              ...(primaria ? { backgroundColor: primaria } : {}),
              ...(fundoClaro ? { color: fundoClaro } : {}),
            }}
          >
            {cta}
          </span>
        </div>
        <figcaption className="text-meta text-graphite">{t('previewClosing')}</figcaption>
      </figure>
    </div>
  );
}
