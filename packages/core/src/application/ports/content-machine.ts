import type {
  ContentCtaChannel,
  ContentFormat,
  ContentFoundationKey,
  ContentPieceStatus,
  ContentPromptName,
} from '@manypost/contracts';

/**
 * Ports da máquina de conteúdo (openspec add-content-machine, design D1).
 *
 * Nenhum fornecedor aparece aqui: o renderizador e o gerador de vídeo são serviços HTTP
 * configurados pelo operador, e texto passa pelo `AiProvider` de sempre.
 */

/** cores em `#rrggbb`; `extraidas` guarda a leitura bruta da logo para a pessoa escolher */
export interface BrandPalette {
  primaria?: string;
  destaque?: string;
  fundoEscuro?: string;
  fundoClaro?: string;
  texto?: string;
  textoSuave?: string;
  extraidas?: string[];
}

export interface ContentBrandRecord {
  orgId: string;
  name: string;
  logoMediaId: string | null;
  logoDarkMediaId: string | null;
  palette: BrandPalette;
  slogan: string;
  signature: string;
  tone: string;
  defaultChannelId: string | null;
  ctaChannel: ContentCtaChannel;
  whatsappNumber: string;
  publishHour: number;
  timezone: string;
  autoApprove: boolean;
  updatedAt: Date;
}

export type ContentBrandPatch = Partial<Omit<ContentBrandRecord, 'orgId' | 'updatedAt'>>;

export interface ContentFoundationRecord {
  key: ContentFoundationKey;
  body: string;
  /** `YYYY-MM-DD`; só faz sentido em `produtos` (tabela com validade) */
  validUntil: string | null;
  updatedAt: Date;
}

export interface ContentPromptRecord {
  id: string;
  name: ContentPromptName;
  version: number;
  system: string;
  active: boolean;
  createdAt: Date;
}

export interface ContentHookRecord {
  id: string;
  formula: string;
  template: string;
  example: string;
  pillar: string;
  origin: string;
  score: number;
  uses: number;
}

export interface ContentMediaRef {
  mediaId: string;
  kind: 'image' | 'video';
  order: number;
}

export interface ContentReviewFlag {
  codigo: string;
  trecho: string;
  motivo: string;
}

export interface ContentReview {
  aprovado: boolean;
  flags: ContentReviewFlag[];
  motivo: string;
  /** achados do lint mecânico que acompanharam a revisão */
  lint?: ContentLintFinding[];
}

export interface ContentFeedback {
  at: string;
  stage: string;
  text: string;
  by: string | null;
}

export interface ContentPieceRecord {
  id: string;
  orgId: string;
  status: ContentPieceStatus;
  format: ContentFormat;
  pillar: string;
  icp: string;
  market: string;
  awareness: string;
  hook: string;
  plan: Record<string, unknown>;
  script: Record<string, unknown> | null;
  caption: string;
  hashtags: string[];
  keyword: string;
  media: ContentMediaRef[];
  review: ContentReview | null;
  feedback: ContentFeedback[];
  attempts: number;
  scheduledFor: Date | null;
  channelId: string | null;
  postGroupId: string | null;
  publishedAt: Date | null;
  permalink: string | null;
  costUsd: number;
  error: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** campos que uma etapa ou uma edição humana pode gravar */
export type ContentPiecePatch = Partial<
  Pick<
    ContentPieceRecord,
    | 'pillar'
    | 'icp'
    | 'market'
    | 'awareness'
    | 'hook'
    | 'plan'
    | 'script'
    | 'caption'
    | 'hashtags'
    | 'media'
    | 'review'
    | 'feedback'
    | 'scheduledFor'
    | 'channelId'
    | 'postGroupId'
    | 'publishedAt'
    | 'permalink'
    | 'error'
  >
> & { incrementAttempts?: boolean; resetAttempts?: boolean };

export interface ContentPieceEventRecord {
  id: string;
  stage: string;
  fromStatus: ContentPieceStatus | null;
  toStatus: ContentPieceStatus;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export interface NewContentPiece {
  format: ContentFormat;
  pillar: string;
  icp: string;
  market: string;
  awareness: string;
  hook: string;
  plan: Record<string, unknown>;
  keyword: string;
  scheduledFor: Date | null;
  channelId: string | null;
}

export interface ContentSpendInput {
  orgId: string;
  pieceId: string | null;
  service: string;
  model: string;
  /** id do pedido no fornecedor (ou um id nosso estável) — a mesma geração nunca conta duas vezes */
  externalId: string;
  costUsd: number;
  detail?: Record<string, unknown>;
}

export interface ContentSpendSummary {
  totalUsd: number;
  byService: Array<{ service: string; model: string; costUsd: number; count: number }>;
  pieces: Array<{ pieceId: string; keyword: string; format: string; costUsd: number }>;
}

export interface ContentMachineRepository {
  getBrand(orgId: string): Promise<ContentBrandRecord | null>;
  upsertBrand(orgId: string, patch: ContentBrandPatch): Promise<ContentBrandRecord>;

  listFoundations(orgId: string): Promise<ContentFoundationRecord[]>;
  upsertFoundation(
    orgId: string,
    key: ContentFoundationKey,
    body: string,
    validUntil: string | null,
  ): Promise<ContentFoundationRecord>;
  /** cria as chaves que faltam, vazias; nunca sobrescreve */
  seedFoundations(orgId: string, keys: readonly ContentFoundationKey[]): Promise<void>;

  listPrompts(orgId: string): Promise<ContentPromptRecord[]>;
  activePrompt(orgId: string, name: ContentPromptName): Promise<ContentPromptRecord | null>;
  /** nova versão ativa (max+1) e desativa a anterior, na mesma transação */
  savePromptVersion(orgId: string, name: ContentPromptName, system: string): Promise<ContentPromptRecord>;
  /** cria a versão 1 só para nomes que ainda não têm nenhuma */
  seedPrompts(orgId: string, prompts: Array<{ name: ContentPromptName; system: string }>): Promise<void>;

  listHooks(orgId: string): Promise<ContentHookRecord[]>;
  seedHooks(
    orgId: string,
    hooks: Array<Pick<ContentHookRecord, 'formula' | 'template' | 'example' | 'pillar' | 'score'>>,
  ): Promise<void>;
  bumpHookUse(orgId: string, formula: string): Promise<void>;

  createPiece(orgId: string, d: NewContentPiece): Promise<ContentPieceRecord>;
  listPieces(orgId: string, opts?: { statuses?: ContentPieceStatus[]; limit?: number }): Promise<ContentPieceRecord[]>;
  getPiece(orgId: string, id: string): Promise<ContentPieceRecord | null>;
  /** palavras-chave que começam com `prefix` — alimenta `keywordFor` */
  keywordsWithPrefix(orgId: string, prefix: string): Promise<string[]>;
  /** ganchos usados desde `since` — a pauta não repete */
  hooksSince(orgId: string, since: Date): Promise<string[]>;

  /**
   * Posse da etapa: só pega a peça se ela está em `status` e sem trava viva. Devolve null quando
   * outra execução já a tem (ou ela mudou de status) — o chamador simplesmente desiste.
   *
   * O `lockedUntil` devolvido é o **token de posse** (precisão de milissegundo): as escritas da
   * etapa passam esse valor como `fence`, e qualquer decisão humana ou novo claim o invalida — uma
   * execução que perdeu a posse passa a afetar zero linhas.
   */
  claim(orgId: string, id: string, status: ContentPieceStatus, leaseSec: number): Promise<ContentPieceRecord | null>;
  /**
   * Devolve a peça sem mudar status. `holdUntil` mantém a trava até esse instante (espera de
   * retentativa ou de vídeo): nenhum job duplicado consegue pegar a peça antes da hora.
   */
  release(
    orgId: string,
    id: string,
    opts: { fence: Date | null; patch?: ContentPiecePatch; holdUntil?: Date },
  ): Promise<boolean>;
  /**
   * UPDATE condicional `status = from` → `to`, grava o patch, solta a trava e registra o evento.
   * Com `fence`, exige ainda que a posse seja a mesma. null = nada mudou.
   */
  transition(
    orgId: string,
    id: string,
    from: ContentPieceStatus,
    to: ContentPieceStatus,
    patch: ContentPiecePatch,
    event: { stage: string; detail?: Record<string, unknown> },
    fence?: Date | null,
  ): Promise<ContentPieceRecord | null>;
  /**
   * Edição sem troca de status. `onlyIn` restringe a certos status; `fence` exige a posse da etapa;
   * `unlocked` recusa enquanto uma etapa estiver rodando. Patch vazio devolve a peça como está.
   */
  update(
    orgId: string,
    id: string,
    patch: ContentPiecePatch,
    opts?: { onlyIn?: ContentPieceStatus[]; fence?: Date | null; unlocked?: boolean },
  ): Promise<ContentPieceRecord | null>;
  /** peças da pauta com slot entre `from` e `to` (inclusive, `YYYY-MM-DD`) — impede pauta duplicada */
  plannedInRange(orgId: string, from: string, to: string): Promise<number>;
  events(orgId: string, pieceId: string): Promise<ContentPieceEventRecord[]>;

  /** peças automáticas paradas: trava vencida, ou sem trava e sem mudança há `idleSec` */
  stalled(now: Date, idleSec: number): Promise<Array<{ orgId: string; id: string }>>;
  /** peças `agendado` para reconciliar com o estado da publicação */
  scheduled(): Promise<Array<{ orgId: string; id: string; postGroupId: string | null }>>;

  /** true = linha nova (e o custo da peça foi somado); false = já registrada */
  addSpend(d: ContentSpendInput): Promise<boolean>;
  spendSummary(orgId: string, from: Date, to: Date): Promise<ContentSpendSummary>;
}

// ------------------------------------------------------------------ renderizador

export interface RenderBrand {
  name: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  palette: BrandPalette;
  slogan: string;
  signature: string;
}

export interface RenderedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface ContentLintFinding {
  nivel: 'erro' | 'aviso';
  codigo: string;
  msg: string;
}

export interface ContentLintResult {
  script: Record<string, unknown>;
  caption: string;
  hashtags: string[];
  findings: ContentLintFinding[];
  hasError: boolean;
}

export interface ContentRenderer {
  render(req: {
    format: 'carrossel' | 'post' | 'story';
    kicker: string;
    slides: unknown[];
    cta: string;
    brand: RenderBrand;
  }): Promise<RenderedImage[]>;
  lint(req: {
    script: Record<string, unknown>;
    caption: string;
    hashtags: string[];
    keyword: string;
    format: ContentFormat;
    ctaChannel: ContentCtaChannel;
  }): Promise<ContentLintResult>;
  palette(req: { imageUrl: string }): Promise<{ colors: string[]; suggestion: BrandPalette }>;
  assembleReel(req: {
    clipUrls: string[];
    closing: { title: string; text: string; cta: string; brand: RenderBrand };
  }): Promise<{ bytes: Uint8Array; durationSec: number }>;
}

// ------------------------------------------------------------------ vídeo

export interface VideoRequest {
  prompt: string;
  durationSec: number;
  aspect: '9:16' | '16:9' | '1:1';
  resolution: '480p' | '720p';
  /** narração/trilha gerada junto com a imagem */
  audio: boolean;
}

export type VideoJobState =
  | { state: 'pending' }
  | { state: 'done'; videoUrl: string }
  | { state: 'failed'; reason: string };

export interface VideoGenerationProvider {
  /** rótulo do modelo para proveniência e gasto */
  readonly model: string;
  /** custo em USD que o fornecedor informa antes de gerar */
  estimate(req: VideoRequest): Promise<number>;
  submit(req: VideoRequest): Promise<{ requestId: string }>;
  status(requestId: string): Promise<VideoJobState>;
}
