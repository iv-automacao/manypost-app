/** Codes estáveis de erro de domínio (contrato público — SPEC_BACKEND §4.2). */
export const ErrorCodes = {
  // channels
  ChannelRefreshRequired: 'channel.refresh_required',
  ChannelMissingScopes: 'channel.missing_scopes',
  ChannelDisabled: 'channel.disabled',
  ChannelConnectFailed: 'channel.connect_failed',
  /** a rede recusou o pedido (id inexistente, comentário apagado, regra da plataforma) — 422 */
  ChannelProviderRejected: 'channel.provider_rejected',
  /** a rede falhou ou limitou; em escrita, detail.uncertain diz se o efeito pode ter acontecido — 502 */
  ChannelProviderFailed: 'channel.provider_failed',
  // posts
  PostInvalidMedia: 'post.invalid_media',
  PostTooLong: 'post.too_long',
  PostEmptyContent: 'post.empty_content',
  PostInvalidTransition: 'post.invalid_transition',
  PostNoChannels: 'post.no_channels',
  PostInvalidSettings: 'post.invalid_settings',
  // media
  MediaUnsupportedType: 'media.unsupported_type',
  MediaTooLarge: 'media.too_large',
  MediaFetchFailed: 'media.fetch_failed',
  /** o backend não conseguiu gravar/ler no storage (bucket fora, credencial errada) — 502 */
  MediaStoreFailed: 'media.store_failed',
  // plano/limites (impostos só no gerenciado — IS_SELF_HOSTED=false)
  PlanChannelLimit: 'plan.channel_limit',
  PlanPostsLimit: 'plan.posts_limit',
  /** feature do catálogo travada no plano atual — detail: { feature, requiredTier } */
  PlanFeatureLocked: 'plan.feature_locked',
  /** rede não incluída no plano (X no Grátis) — detail: { provider, requiredTier } */
  PlanProviderLocked: 'plan.provider_locked',
  RateLimited: 'rate.limited',
  // billing (Stripe — só no gerenciado)
  BillingDisabled: 'billing.disabled',
  BillingNoSubscription: 'billing.no_subscription',
  BillingProviderError: 'billing.provider_error',
  // ia
  AiBudgetExceeded: 'ai.budget_exceeded',
  /** o provedor de IA falhou (credencial, limite, indisponibilidade) — 502, nunca vaza corpo/endpoint */
  AiProviderFailed: 'ai.provider_failed',
  /** o modelo respondeu, mas a resposta não serve (estrutura inválida) — 502; a franquia é devolvida */
  AiInvalidResponse: 'ai.invalid_response',
  /** o adapter configurado não tem a capacidade pedida (ex.: descrever imagem) — 501 */
  AiCapabilityUnavailable: 'ai.capability_unavailable',
  CapabilityDisabled: 'capability.disabled',
  // auth
  AuthInvalidCredentials: 'auth.invalid_credentials',
  AuthEmailTaken: 'auth.email_taken',
  AuthSessionInvalid: 'auth.session_invalid',
  AuthUnauthorized: 'auth.unauthorized',
  AuthProviderUnavailable: 'auth.provider_unavailable',
  AuthSocialEmailUnverified: 'auth.social_email_unverified',
  // máquina de conteúdo
  ContentInvalidTransition: 'content.invalid_transition',
  ContentNotConfigured: 'content.not_configured',
  ContentGenerationFailed: 'content.generation_failed',
  /** o serviço de arte recusou a entrada (imagem ilegível, clipe acima do limite) */
  ContentInvalidInput: 'content.invalid_input',
  // automação
  /** o fluxo tem problemas que impedem Teste/Ativa — detail.problems no DomainError; extra.problems no corpo HTTP */
  AutomationFlowInvalid: 'automation.flow_invalid',
  // genéricos
  /** entrada fora da regra de domínio (mesmo title do 400 de validação Zod) */
  ValidationInvalidRequest: 'validation.invalid_request',
  NotFound: 'common.not_found',
  Forbidden: 'common.forbidden',
  IdempotencyConflict: 'common.idempotency_conflict',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
