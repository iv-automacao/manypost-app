import type { components, paths } from '@/lib/api/schema';

/** Tipos da máquina de conteúdo, derivados do cliente OpenAPI gerado (nunca redeclarados à mão). */
export type ContentOverview = components['schemas']['ContentOverview'];
export type ContentCapabilities = components['schemas']['ContentCapabilities'];
export type ContentBrand = components['schemas']['ContentBrand'];
export type ContentPalette = components['schemas']['ContentPalette'];
export type ContentPiece = components['schemas']['ContentPiece'];
export type ContentPieceEvent = components['schemas']['ContentPieceEvent'];
export type ContentPieceDetail = components['schemas']['ContentPieceDetail'];
export type ContentFoundation = components['schemas']['ContentFoundation'];
export type ContentPrompt = components['schemas']['ContentPrompt'];
export type ContentHook = components['schemas']['ContentHook'];
export type ContentSpend = components['schemas']['ContentSpend'];

export type PieceStatus = ContentPiece['status'];
export type PieceFormat = ContentPiece['format'];
export type PieceMedia = ContentPiece['media'][number];
export type FoundationKey = ContentFoundation['key'];
export type PromptName = ContentPrompt['name'];
export type CtaChannel = ContentBrand['ctaChannel'];

/** chaves de cor editáveis da paleta (`extraidas` é a lista lida da logo, não um papel) */
export type PaletteRole = Exclude<keyof ContentPalette, 'extraidas'>;

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

export type BrandPatch = Json<paths['/v1/content-machine/brand']['put']['requestBody']>;
export type CreatePieceBody = Json<paths['/v1/content-machine/pieces']['post']['requestBody']>;
export type PlanWeekBody = Json<paths['/v1/content-machine/plan']['post']['requestBody']>;
export type EditPieceBody = Json<paths['/v1/content-machine/pieces/{id}']['patch']['requestBody']>;
export type PieceDecision = Json<paths['/v1/content-machine/pieces/{id}/decision']['post']['requestBody']>;
