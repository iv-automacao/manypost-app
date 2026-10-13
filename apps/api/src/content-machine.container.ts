import { aiConfigFromEnv, contentMachineConfigFromEnv, type Env } from '@manypost/config';
import {
  CONTENT_MACHINE_QUEUE,
  CONTENT_PLAN_QUEUE,
  CONTENT_SWEEP_QUEUE,
  makeContentRenderer,
  makeContentSetup,
  makeCreatePiece,
  makeDecidePiece,
  makeEditPiece,
  makeExtractPalette,
  makeRequestPlan,
  makeRunPlanJob,
  makeRunContentStage,
  type PlanWeekInput,
  makeSavePrompt,
  makeSpendSummary,
  makeSweepContent,
  makeUpdateBrand,
  makeUpdateFoundation,
  makeVideoGenerationProvider,
  type ContentMachineDeps,
} from '@manypost/core';
import { makeContentMachineRepository, type Db } from '@manypost/db';
import type { PublishingRuntime } from '@manypost/queue';
import { log } from './log';

/**
 * Fiação da máquina de conteúdo (openspec add-content-machine). As etapas rodam na fila do
 * processo da API (MODE=all), junto com a publicação: o worker dedicado não consome esta fila.
 */
export async function buildContentMachine(
  env: Env,
  db: Db,
  runtime: PublishingRuntime,
  base: Pick<
    ContentMachineDeps,
    'ai' | 'budget' | 'media' | 'storage' | 'channels' | 'publishing' | 'schedulePost' | 'audit' | 'notifications'
  >,
) {
  const config = contentMachineConfigFromEnv(env);
  const deps: ContentMachineDeps = {
    ...base,
    repo: makeContentMachineRepository(db),
    renderer: config.renderer ? makeContentRenderer(config.renderer) : null,
    video: makeVideoGenerationProvider(config.video),
    scheduler: runtime.scheduler,
    prices: config.prices,
    textModel: aiConfigFromEnv(env)?.model ?? 'desconhecido',
    videoMaxBytes: env.MEDIA_MAX_VIDEO_MB * 1024 * 1024,
    videoResolution: config.videoResolution,
    log: (level, msg, data) =>
      log(level === 'error' || level === 'warn' ? level : 'info', msg, data as Record<string, unknown> | undefined),
  };

  const runStage = makeRunContentStage(deps);
  const sweep = makeSweepContent(deps);
  // vídeo pode levar minutos: o job vive 1h e três laços evitam que um reels segure a fila
  await runtime.registerQueue(
    CONTENT_MACHINE_QUEUE,
    (d: { orgId: string; pieceId: string }) => runStage(d.orgId, d.pieceId),
    { expireInSeconds: 3600, workers: 3 },
  );
  // pauta: modelo de raciocínio passa do tempo de uma requisição; a geração roda aqui
  const planWeek = makeRunPlanJob(deps);
  await runtime.registerQueue(
    CONTENT_PLAN_QUEUE,
    async (d: { orgId: string; userId: string | null; input: PlanWeekInput }) => {
      const criadas = await planWeek({ orgId: d.orgId, userId: d.userId }, d.input);
      log('info', 'content-machine: pauta gerada', { orgId: d.orgId, weekStart: d.input.weekStart, pecas: criadas.length });
    },
    { expireInSeconds: 900, policy: 'stately' },
  );
  await runtime.registerQueue(
    CONTENT_SWEEP_QUEUE,
    async () => {
      const r = await sweep();
      if (r.requeued || r.published || r.failed) log('info', 'content-machine: sweep agiu', r);
    },
    { cron: '* * * * *' },
  );

  return {
    repo: deps.repo,
    capabilities: {
      text: Boolean(deps.ai),
      renderer: Boolean(deps.renderer),
      video: Boolean(deps.video),
      videoModel: deps.video?.model ?? null,
    },
    setup: makeContentSetup(deps),
    updateBrand: makeUpdateBrand(deps),
    extractPalette: makeExtractPalette(deps),
    updateFoundation: makeUpdateFoundation(deps),
    savePrompt: makeSavePrompt(deps),
    requestPlan: makeRequestPlan(deps),
    createPiece: makeCreatePiece(deps),
    decide: makeDecidePiece(deps),
    edit: makeEditPiece(deps),
    spend: makeSpendSummary(deps),
    runStage,
    publicUrl: (path: string) => deps.storage.publicUrl(path),
  };
}

export type ContentMachineBundle = Awaited<ReturnType<typeof buildContentMachine>>;
