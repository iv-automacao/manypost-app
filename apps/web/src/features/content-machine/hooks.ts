'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/unwrap';
import { PLAN_POLL_WINDOW_MS, pollInterval } from './logic';
import type {
  BrandPatch,
  ContentBrand,
  ContentOverview,
  ContentPieceDetail,
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

/** a organização está configurada desde a primeira visão geral bem-sucedida; refetch que falha não desfaz */
function useMachineReady() {
  return useOverview().data !== undefined;
}

/**
 * Até quando (epoch ms) o quadro acompanha de perto uma pauta pedida. Fica no módulo, e não no
 * estado do componente, para sobreviver a sair e voltar do quadro durante a janela. O React Query
 * reavalia `refetchInterval` a cada busca, então a janela vencida volta sozinha ao ritmo normal.
 */
let planPollUntil = 0;

/** Peças do quadro; polling de 5s enquanto alguma anda sozinha ou há pauta em geração (ver `pollInterval`). */
export function usePieces() {
  return useQuery({
    queryKey: cmKeys.pieces,
    queryFn: async () =>
      unwrap(await api.GET('/v1/content-machine/pieces', { params: { query: { limit: PIECES_LIMIT } } })),
    refetchInterval: (query) => pollInterval(query.state.data, planPollUntil),
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

/** corpo do 202 de `POST /v1/content-machine/plan`: a pauta entrou na fila */
export interface PlanQueued {
  queued: true;
  weekStart: string;
}

/**
 * Pede a pauta da semana. O backend agora responde 202 `{ queued, weekStart }` (a pauta é gerada
 * na fila) e 409 quando a semana já foi ou está sendo planejada. O cliente gerado ainda descreve o
 * antigo 201 com a lista de peças e não é regenerado aqui (a geração derrubaria as rotas de
 * billing); este é o único ponto que conhece a forma nova — daí o cast.
 */
async function requestPlan(body: PlanWeekBody): Promise<PlanQueued> {
  return unwrap<unknown>(await api.POST('/v1/content-machine/plan', { body })) as PlanQueued;
}

export function usePlanWeek() {
  const invalidate = useInvalidatePieces();
  return useMutation({
    mutationFn: requestPlan,
    onSuccess: () => {
      // a janela vale antes do refetch: a busca disparada pela invalidação já sai no ritmo rápido
      planPollUntil = Date.now() + PLAN_POLL_WINDOW_MS;
      invalidate();
    },
  });
}

export function useEditPiece() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePieces();
  return useMutation({
    mutationFn: async (input: { id: string; patch: EditPieceBody }) =>
      unwrap(
        await api.PATCH('/v1/content-machine/pieces/{id}', {
          params: { path: { id: input.id } },
          body: input.patch,
        }),
      ),
    // a peça devolvida entra direto no detalhe: o rascunho limpo não pisca o valor antigo até o refetch
    onSuccess: (piece) =>
      queryClient.setQueryData<ContentPieceDetail>(cmKeys.piece(piece.id), (old) => (old ? { ...old, piece } : old)),
    // salvo ou recusado (409: a peça mudou de etapa), quadro e detalhe releem o servidor
    onSettled: (_piece, _err, input) => invalidate(input.id),
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
