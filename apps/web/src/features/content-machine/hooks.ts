'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/unwrap';
import { pollInterval } from './logic';
import type {
  BrandPatch,
  ContentBrand,
  ContentOverview,
  CreatePieceBody,
  EditPieceBody,
  FoundationKey,
  PieceDecision,
  PlanWeekBody,
  PromptName,
} from './types';

/** raiz única: invalidar `cmKeys.all` derruba tudo o que a máquina tem em cache */
export const cmKeys = {
  all: ['content-machine'] as const,
  overview: ['content-machine', 'overview'] as const,
  pieces: ['content-machine', 'pieces'] as const,
  piece: (id: string) => ['content-machine', 'piece', id] as const,
  foundation: ['content-machine', 'foundation'] as const,
  prompts: ['content-machine', 'prompts'] as const,
  hooks: ['content-machine', 'hooks'] as const,
  spend: (month: string) => ['content-machine', 'spend', month] as const,
};

/** teto do endpoint de listagem; o quadro avisa quando o atinge */
export const PIECES_LIMIT = 500;

/**
 * Visão geral. A PRIMEIRA chamada configura a organização (prompts, fórmulas e fundação vazia),
 * por isso as leituras de fundação/prompts/fórmulas só disparam depois dela — senão a primeira
 * visita poderia ler listas vazias enquanto a configuração ainda está acontecendo.
 */
export function useOverview() {
  return useQuery({
    queryKey: cmKeys.overview,
    queryFn: async () => unwrap(await api.GET('/v1/content-machine/overview')),
  });
}

function useMachineReady() {
  return useOverview().isSuccess;
}

/** Peças do quadro; polling de 5s enquanto alguma anda sozinha (ver `pollInterval`). */
export function usePieces() {
  return useQuery({
    queryKey: cmKeys.pieces,
    queryFn: async () =>
      unwrap(await api.GET('/v1/content-machine/pieces', { params: { query: { limit: PIECES_LIMIT } } })),
    refetchInterval: (query) => pollInterval(query.state.data),
  });
}

export function usePiece(id: string | null) {
  return useQuery({
    queryKey: cmKeys.piece(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () =>
      unwrap(await api.GET('/v1/content-machine/pieces/{id}', { params: { path: { id: id! } } })),
    refetchInterval: (query) => (query.state.data ? pollInterval([query.state.data.piece]) : false),
  });
}

export function useFoundation() {
  const ready = useMachineReady();
  return useQuery({
    queryKey: cmKeys.foundation,
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/v1/content-machine/foundation')),
  });
}

export function usePrompts() {
  const ready = useMachineReady();
  return useQuery({
    queryKey: cmKeys.prompts,
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/v1/content-machine/prompts')),
  });
}

export function useHooks() {
  const ready = useMachineReady();
  return useQuery({
    queryKey: cmKeys.hooks,
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/v1/content-machine/hooks')),
  });
}

export function useSpend(month: string) {
  return useQuery({
    queryKey: cmKeys.spend(month),
    queryFn: async () => unwrap(await api.GET('/v1/content-machine/spend', { params: { query: { month } } })),
    // trocar de mês mantém a tabela anterior na tela até a nova chegar
    placeholderData: keepPreviousData,
  });
}

/** grava a identidade devolvida no cache da visão geral — a tela não pisca com refetch */
function useSetBrand() {
  const queryClient = useQueryClient();
  return (brand: ContentBrand) =>
    queryClient.setQueryData<ContentOverview>(cmKeys.overview, (old) => (old ? { ...old, brand } : old));
}

export function useUpdateBrand() {
  const setBrand = useSetBrand();
  return useMutation({
    mutationFn: async (patch: BrandPatch) => unwrap(await api.PUT('/v1/content-machine/brand', { body: patch })),
    onSuccess: setBrand,
  });
}

/** Sem `mediaId`, a API usa a logo principal (fundo claro). */
export function useExtractPalette() {
  const setBrand = useSetBrand();
  return useMutation({
    mutationFn: async (mediaId?: string) =>
      unwrap(await api.POST('/v1/content-machine/brand/palette', { body: mediaId ? { mediaId } : {} })),
    onSuccess: setBrand,
  });
}

export function useUpdateFoundation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: FoundationKey; body: string; validUntil?: string | null }) =>
      unwrap(
        await api.PUT('/v1/content-machine/foundation/{key}', {
          params: { path: { key: input.key } },
          body: { body: input.body, ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}) },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cmKeys.foundation });
      // `foundationFilled` da visão geral depende disto
      void queryClient.invalidateQueries({ queryKey: cmKeys.overview });
    },
  });
}

export function useUpdatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: PromptName; system: string }) =>
      unwrap(
        await api.PUT('/v1/content-machine/prompts/{name}', {
          params: { path: { name: input.name } },
          body: { system: input.system },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cmKeys.prompts }),
  });
}

/** peças mudaram: quadro, contagens da visão geral e o detalhe aberto */
function useInvalidatePieces() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: cmKeys.pieces });
    void queryClient.invalidateQueries({ queryKey: cmKeys.overview });
    if (id) void queryClient.invalidateQueries({ queryKey: cmKeys.piece(id) });
  };
}

export function useCreatePiece() {
  const invalidate = useInvalidatePieces();
  return useMutation({
    mutationFn: async (body: CreatePieceBody) => unwrap(await api.POST('/v1/content-machine/pieces', { body })),
    onSuccess: () => invalidate(),
  });
}

export function usePlanWeek() {
  const invalidate = useInvalidatePieces();
  return useMutation({
    mutationFn: async (body: PlanWeekBody) => unwrap(await api.POST('/v1/content-machine/plan', { body })),
    onSuccess: () => invalidate(),
  });
}

export function useEditPiece() {
  const invalidate = useInvalidatePieces();
  return useMutation({
    mutationFn: async (input: { id: string; patch: EditPieceBody }) =>
      unwrap(
        await api.PATCH('/v1/content-machine/pieces/{id}', {
          params: { path: { id: input.id } },
          body: input.patch,
        }),
      ),
    onSuccess: (_piece, input) => invalidate(input.id),
  });
}

export function useDecidePiece() {
  const invalidate = useInvalidatePieces();
  return useMutation({
    mutationFn: async (input: { id: string; decision: PieceDecision }) =>
      unwrap(
        await api.POST('/v1/content-machine/pieces/{id}/decision', {
          params: { path: { id: input.id } },
          body: input.decision,
        }),
      ),
    onSuccess: (_piece, input) => invalidate(input.id),
  });
}
