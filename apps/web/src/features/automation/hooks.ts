'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/unwrap';
import type { RunStatus, Status } from './logic';
import type { configFromDraft } from './logic';

const AUTOMATIONS = 'automations';
const LEADS = 'automation-leads';

type ConfigBody = ReturnType<typeof configFromDraft>;

export function useAutomations() {
  return useQuery({
    queryKey: [AUTOMATIONS, 'list'],
    queryFn: async () => unwrap(await api.GET('/v1/automations', {})),
  });
}

export function useAutomation(id: string | undefined) {
  return useQuery({
    queryKey: [AUTOMATIONS, 'one', id],
    enabled: Boolean(id),
    queryFn: async () => unwrap(await api.GET('/v1/automations/{id}', { params: { path: { id: id! } } })),
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { channelId: string; name: string; config: ConfigBody; testUsernames: string[] }) =>
      unwrap(await api.POST('/v1/automations', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [AUTOMATIONS] }),
  });
}

export function useUpdateAutomation(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; config: ConfigBody; testUsernames: string[] }) =>
      unwrap(await api.PATCH('/v1/automations/{id}', { params: { path: { id: id! } }, body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [AUTOMATIONS] }),
  });
}

export function useSetAutomationStatus(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (status: Status) =>
      unwrap(await api.POST('/v1/automations/{id}/status', { params: { path: { id: id! } }, body: { status } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [AUTOMATIONS] }),
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(await api.DELETE('/v1/automations/{id}', { params: { path: { id } } }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [AUTOMATIONS] }),
  });
}

export function useLeads(filter: { automationId?: string; status?: RunStatus }) {
  return useInfiniteQuery({
    queryKey: [LEADS, filter.automationId ?? null, filter.status ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/automations/leads', {
          params: {
            query: {
              ...(filter.automationId ? { automationId: filter.automationId } : {}),
              ...(filter.status ? { status: filter.status } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    // leads chegam sozinhos (o motor roda em segundo plano): revalida ao voltar para a aba
    refetchInterval: 30_000,
  });
}
