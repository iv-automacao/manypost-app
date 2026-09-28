/**
 * E2E da máquina de conteúdo (openspec add-content-machine) com provedores REAIS: modelo de texto
 * do `.env`, renderizador em `CONTENT_RENDERER_URL` e o banco local. Não publica nada: o
 * agendamento é trocado por um registro em memória, e o vídeo só roda com `E2E_REELS=1` (custa).
 *
 * Uso (Postgres de desenvolvimento com as migrations aplicadas):
 *   E2E_FOUNDATION_DIR=../postagem-invista/fundacao bun run scripts/e2e-content-machine.ts
 *
 * Cria uma organização própria a cada execução; nada é compartilhado com dados reais.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  aiConfigFromEnv,
  contentMachineConfigFromEnv,
  loadEnv,
  mediaStorageConfigFromEnv,
} from '@manypost/config';
import {
  makeAiProvider,
  makeContentRenderer,
  makeContentSetup,
  makeCreatePiece,
  makeExtractPalette,
  makeMediaStorage,
  makeRunContentStage,
  makeUpdateBrand,
  makeVideoGenerationProvider,
  persistMediaBytes,
  type BudgetGuard,
  type ContentMachineDeps,
} from '@manypost/core';
import { createDb, makeContentMachineRepository, makeMediaRepository } from '@manypost/db';
import { ContentFoundationKeys, type ContentFormat } from '@manypost/contracts';
import postgres from 'postgres';

const env = loadEnv();
const dir = process.env.E2E_FOUNDATION_DIR;
const cfg = contentMachineConfigFromEnv(env);
const aiCfg = aiConfigFromEnv(env);
if (!aiCfg || !cfg.renderer) {
  console.error('✗ configure AI_* e CONTENT_RENDERER_URL no .env');
  process.exit(1);
}

const db = createDb(env.DATABASE_URL);
const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
const orgId = randomUUID();
await sql`insert into organizations (id, name, slug) values (${orgId}, ${'E2E máquina'}, ${`e2e-maquina-${orgId.slice(0, 8)}`})`;

const budget: BudgetGuard = {
  reserve: async () => ({ grantId: 'e2e' }),
  commit: async () => {},
  release: async () => {},
  balance: async () => ({ granted: 0, used: 0, reserved: 0, remaining: 0, periodEnd: new Date(), enforced: false }),
};
const agendados: unknown[] = [];
const channelId = randomUUID();
const deps: ContentMachineDeps = {
  repo: makeContentMachineRepository(db),
  ai: makeAiProvider(aiCfg),
  budget,
  renderer: makeContentRenderer(cfg.renderer),
  video: process.env.E2E_REELS === '1' ? makeVideoGenerationProvider(cfg.video) : null,
  media: makeMediaRepository(db),
  storage: makeMediaStorage(mediaStorageConfigFromEnv(env)),
  // canal fictício: o agendamento é só registrado
  channels: { findMany: async (_o: string, ids: string[]) => ids.map((id) => ({ id, provider: 'instagram-standalone', name: '@e2e' })) } as never,
  publishing: { getGroup: async () => null, transition: async () => true },
  // agendamento registrado: cria só o grupo (sem publicação) para a FK da peça
  schedulePost: (async (input: unknown) => {
    agendados.push(input);
    const [g] = await sql`insert into post_groups (id, org_id) values (${randomUUID()}, ${orgId}) returning id`;
    return { id: g!.id as string, state: 'DRAFT' };
  }) as never,
  scheduler: { enqueue: async () => 'e2e', cancelBySingletonKey: async () => {}, schedule: async () => {} },
  audit: { append: async () => {} },
  prices: cfg.prices,
  textModel: aiCfg.model,
  videoMaxBytes: env.MEDIA_MAX_VIDEO_MB * 1024 * 1024,
  log: (level, msg, data) => console.log(`  [${level}] ${msg}`, data ?? ''),
};

await makeContentSetup(deps)(orgId, { brandName: 'Invista' });
if (dir) {
  for (const key of ContentFoundationKeys) {
    try {
      await deps.repo.upsertFoundation(orgId, key, readFileSync(join(dir, `${key}.md`), 'utf8'), null);
    } catch {
      console.log(`  (sem ${key}.md)`);
    }
  }
  for (const [arquivo, campo] of [['invista-logo-escura.png', 'logoMediaId'], ['invista-logo-branca.png', 'logoDarkMediaId']] as const) {
    const bytes = new Uint8Array(readFileSync(join(dir, 'assets', arquivo)));
    const m = await persistMediaBytes(deps, { orgId, bytes, mime: 'image/png', width: null, height: null, alt: arquivo });
    await makeUpdateBrand(deps)(orgId, { [campo]: m.id });
  }
}
await makeUpdateBrand(deps)(orgId, {
  slogan: 'Para você se sentir seguro.',
  signature: 'Seguros, Saúde & Consórcio',
  defaultChannelId: null,
});
// canal fictício só para satisfazer a FK da peça; token vazio porque nada é publicado
await sql`insert into channels (id, org_id, provider, external_id, name, token_enc) values (${channelId}, ${orgId}, 'instagram-standalone', ${`e2e-${orgId}`}, '@e2e', ${Buffer.from('')})`;
const paleta = await makeExtractPalette(deps)(orgId).catch((e) => {
  console.log('  paleta falhou (logo sem URL pública acessível?):', String(e));
  return null;
});
console.log('paleta:', paleta?.palette ?? '-');

const run = makeRunContentStage(deps);
const formatos = (process.env.E2E_FORMATS ?? 'carrossel,post').split(',') as ContentFormat[];
for (const format of formatos) {
  const t = Date.now();
  const p = await makeCreatePiece(deps)(
    { orgId, userId: null },
    { format, hook: format === 'reels' ? 'Servidor de Boa Vista, este é pra você.' : 'Ninguém te conta onde fica o PS do seu plano.', angle: 'conferir a rede de urgência perto de casa antes de fechar', icp: 'familia', channelId },
  );
  console.log(`\n▶ ${format} ${p.keyword}`);
  for (let i = 0; i < 12; i++) {
    const atual = (await deps.repo.getPiece(orgId, p.id))!;
    if (!['ideia', 'roteiro', 'producao', 'aprovado'].includes(atual.status)) break;
    await run(orgId, p.id);
    const depois = (await deps.repo.getPiece(orgId, p.id))!;
    console.log(`  ${atual.status} → ${depois.status}${depois.error ? ` (erro: ${depois.error})` : ''}`);
  }
  const f = (await deps.repo.getPiece(orgId, p.id))!;
  console.log(`  final: ${f.status} · US$ ${f.costUsd.toFixed(4)} · ${((Date.now() - t) / 1000).toFixed(0)} s`);
  console.log(`  legenda: ${f.caption.split('\n')[0]}`);
  console.log(`  hashtags: ${f.hashtags.join(' ')}`);
  console.log(`  revisão: ${JSON.stringify(f.review)}`);
  const midias = await deps.media.findMany(orgId, f.media.map((m) => m.mediaId));
  for (const m of midias) console.log(`  mídia: ${join(env.UPLOAD_DIR ?? 'uploads', m.path)}`);
}
console.log(`\nagendamentos registrados: ${agendados.length}`);
await sql.end();
process.exit(0);
