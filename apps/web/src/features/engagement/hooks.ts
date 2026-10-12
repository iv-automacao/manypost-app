'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/unwrap';
import type { Period } from './logic';

// Raízes próprias: `['insights', …]` é da home e o SSE invalida esse prefixo a cada post.
const COMMENTS = 'engagement-comments';
const INSIGHTS = 'channel-insights';

/** reconectar/permissão não se resolve tentando de novo — só instabilidade merece retry */
const retryTransient = (count: number, error: unknown) => {
  const code = (error as { title?: string } | null)?.title;
  return count < 1 && (code === 'channel.provider_failed' || code === undefined);
};

export function useRecentMedia(channelId: string | undefined) {
  return useInfiniteQuery({
    queryKey: [COMMENTS, channelId, 'media'],
    enabled: Boolean(channelId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/channels/{id}/media', {
          params: { path: { id: channelId! }, query: pageParam ? { cursor: pageParam } : {} },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
    retry: retryTransient,
  });
}

export function useComments(channelId: string | undefined, mediaId: string | undefined) {
  return useInfiniteQuery({
    queryKey: [COMMENTS, channelId, 'comments', mediaId],
    enabled: Boolean(channelId && mediaId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/channels/{id}/media/{mediaId}/comments', {
          params: {
            path: { id: channelId!, mediaId: mediaId! },
            query: pageParam ? { cursor: pageParam } : {},
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    retry: retryTransient,
  });
}

/**
 * Responde um comentário. `idempotencyKey` vem de quem chama e só muda depois de um sucesso:
 * clique duplo ou reenvio após timeout reaproveita a chave e a API devolve a primeira resposta.
 */
export function useReplyToComment(channelId: string | undefined, mediaId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { commentId: string; message: string; idempotencyKey: string }) =>
      unwrap(
        await api.POST('/v1/channels/{id}/comments/{commentId}/replies', {
          params: { path: { id: channelId!, commentId: input.commentId } },
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body: { message: input.message },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [COMMENTS, channelId, 'comments', mediaId] }),
  });
}

export function useSetCommentHidden(channelId: string | undefined, mediaId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { commentId: string; hidden: boolean }) => {
      unwrap(
        await api.POST('/v1/channels/{id}/comments/{commentId}/visibility', {
          params: { path: { id: channelId!, commentId: input.commentId } },
          body: { hidden: input.hidden },
        }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [COMMENTS, channelId, 'comments', mediaId] }),
  });
}

export function useAccountInsights(channelId: string | undefined, days: Period) {
  return useQuery({
    queryKey: [INSIGHTS, channelId, 'account', days],
    enabled: Boolean(channelId),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/channels/{id}/insights', {
          params: { path: { id: channelId! }, query: { days } },
        }),
      ),
    // a Meta atualiza com atraso de horas: 5 min de cache poupa a cota sem esconder nada novo
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: retryTransient,
  });
}

export function useMediaInsights(channelId: string | undefined) {
  return useInfiniteQuery({
    queryKey: [INSIGHTS, channelId, 'media'],
    enabled: Boolean(channelId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/channels/{id}/insights/media', {
          params: { path: { id: channelId! }, query: pageParam ? { cursor: pageParam } : {} },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: retryTransient,
  });
}
