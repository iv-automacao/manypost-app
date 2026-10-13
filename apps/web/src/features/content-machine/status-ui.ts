import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';
import type { PieceStatus } from './types';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/**
 * Cor semântica por etapa, com os tokens de estado do brand (§3): âmbar = a esteira está
 * trabalhando, amarelo = espera uma pessoa, roxo = nas mãos do sistema, verde = publicado,
 * vermelho = falhou. Ideia e reprovado são neutros.
 */
export const STATUS_BADGE: Record<PieceStatus, BadgeVariant> = {
  ideia: 'neutral',
  roteiro: 'publishing',
  producao: 'publishing',
  revisao: 'review',
  aprovado: 'scheduled',
  agendado: 'scheduled',
  publicado: 'published',
  reprovado: 'neutral',
  erro: 'failed',
};

export const STATUS_DOT: Record<PieceStatus, string> = {
  ideia: 'bg-graphite',
  roteiro: 'bg-state-publishing',
  producao: 'bg-state-publishing',
  revisao: 'bg-state-review',
  aprovado: 'bg-state-scheduled',
  agendado: 'bg-state-scheduled',
  publicado: 'bg-state-published',
  reprovado: 'bg-graphite',
  erro: 'bg-state-failed',
};
