/** Eventos de webhook de saída (SPEC_API_MCP §4) — extension point do premium (SPEC_ARCHITECTURE §5). */
export const WebhookEvents = {
  PostScheduled: 'post.scheduled',
  PostPublished: 'post.published',
  PostFailed: 'post.failed',
  ChannelRefreshRequired: 'channel.refresh_required',
  ChannelDisconnected: 'channel.disconnected',
  MentionReceived: 'mention.received', // fase 2
  // lead completo de uma automação comentário → direct (add-comment-automation)
  LeadCaptured: 'lead.captured',
  // lead no meio do fluxo, disparado pelo balão Ação "Enviar dados" (add-flow-action-node)
  LeadUpdated: 'lead.updated',
} as const;

export type WebhookEvent = (typeof WebhookEvents)[keyof typeof WebhookEvents];

export interface WebhookEnvelope<T = unknown> {
  id: string;
  event: WebhookEvent;
  orgId: string;
  createdAt: string; // ISO
  data: T;
}
