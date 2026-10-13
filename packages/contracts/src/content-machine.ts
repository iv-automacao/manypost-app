/**
 * Máquina de conteúdo (change add-content-machine): vocabulário fechado compartilhado por API, worker e web.
 * Os valores são pt-BR minúsculos de propósito: são o idioma da esteira que o operador lê (design D2).
 */
export const ContentPieceStatuses = [
  'ideia',
  'roteiro',
  'producao',
  'revisao',
  'aprovado',
  'agendado',
  'publicado',
  'reprovado',
  'erro',
] as const;
export type ContentPieceStatus = (typeof ContentPieceStatuses)[number];

export const ContentFormats = ['carrossel', 'post', 'story', 'reels'] as const;
export type ContentFormat = (typeof ContentFormats)[number];

/** chaves da fundação editorial lidas em toda geração */
export const ContentFoundationKeys = ['produtos', 'icp', 'personagem', 'marca', 'escada', 'pilares'] as const;
export type ContentFoundationKey = (typeof ContentFoundationKeys)[number];

/** prompts versionados que a esteira usa */
export const ContentPromptNames = ['pauta', 'roteiro', 'legenda', 'revisor'] as const;
export type ContentPromptName = (typeof ContentPromptNames)[number];

/** `comentario` = a pessoa comenta a palavra no post e a automação (ex.: ManyChat) responde no direct */
export const ContentCtaChannels = ['direct', 'whatsapp', 'comentario'] as const;
export type ContentCtaChannel = (typeof ContentCtaChannels)[number];

export const ContentMarkets = ['manaus', 'boa_vista', 'belem', 'nacional'] as const;
export type ContentMarket = (typeof ContentMarkets)[number];
