import type { ContentPieceStatus } from '@manypost/contracts';

/** Transições permitidas — única fonte de verdade; o repositório aplica com UPDATE condicional. */
export const AllowedContentTransitions: Record<ContentPieceStatus, readonly ContentPieceStatus[]> = {
  ideia: ['roteiro', 'erro', 'reprovado'],
  roteiro: ['producao', 'ideia', 'erro', 'reprovado'],
  producao: ['aprovado', 'revisao', 'roteiro', 'erro', 'reprovado'],
  revisao: ['aprovado', 'reprovado', 'roteiro', 'producao', 'ideia'],
  aprovado: ['agendado', 'revisao', 'erro'],
  agendado: ['publicado', 'erro'],
  publicado: [],
  reprovado: ['ideia'],
  erro: ['ideia', 'roteiro', 'producao', 'aprovado', 'reprovado'],
};

export function canContentTransition(from: ContentPieceStatus, to: ContentPieceStatus): boolean {
  return AllowedContentTransitions[from].includes(to);
}

/** status que têm uma etapa automática (a fila executa); os demais esperam pessoa ou são terminais */
export const AUTOMATIC_STAGES: ReadonlySet<ContentPieceStatus> = new Set(['ideia', 'roteiro', 'producao', 'aprovado']);

export const isAutomatic = (s: ContentPieceStatus): boolean => AUTOMATIC_STAGES.has(s);

/**
 * Palavra-chave do CTA: `{LINHA}-{MMDD}-{letra}`, única por org. PME para empresário; PLANO para o resto.
 * `usadas` = palavras já existentes com o mesmo prefixo.
 */
export function keywordFor(icp: string, dia: Date, usadas: readonly string[]): string {
  const linha = icp === 'empresario' ? 'PME' : 'PLANO';
  const mm = String(dia.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dia.getUTCDate()).padStart(2, '0');
  const base = `${linha}-${mm}${dd}`;
  for (let c = 65; c <= 90; c++) {
    const k = `${base}-${String.fromCharCode(c)}`;
    if (!usadas.includes(k)) return k;
  }
  // 26 peças no mesmo dia e linha: usa duas letras em vez de falhar
  return `${base}-Z${usadas.length}`;
}
