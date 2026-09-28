import PgBoss from 'pg-boss';
import postgres from 'postgres';
import type {
  ChannelProviderRegistry,
  ChannelRepository,
  CryptoService,
  IdempotencyStore,
  JobScheduler,
  MediaRepository,
  MediaStorage,
  MetricsSink,
  PublishingRepository,
  RateLimiter,
  WebhookRepository,
} from '@manypost/core';
import {
  PUBLISH_QUEUE,
  RECOVER_QUEUE,
  THREAD_QUEUE,
  WEBHOOK_QUEUE,
  makeContinueThread,
  makeDeliverWebhook,
  makeEmitEvent,
  makePublishPublication,
  makeRecoverDue,
} from '@manypost/core';
import { makeRedisIdempotencyStore } from './redis-idempotency';
import { makeRedisRateLimiter } from './redis-rate-limiter';
import { makeRedisRealtimeBus } from './redis-realtime-bus';

import { queueLog as log } from './log';

/**
 * Percorre um lote inteiro e RELANÇA a primeira falha depois de percorrê-lo.
 *
 * Falha inesperada de infraestrutura (banco fora, bug) precisa subir: engolir marcaria o job
 * como entregue e a publicação ficaria presa no estado em que parou até o watchdog. Ao mesmo
 * tempo, um job ruim não pode impedir os demais do lote. O retry de negócio continua sendo da
 * máquina de estados (`retryLimit: 0`) — quem recupera o job falhado é o scanner do §8.
 */
export const runBatch = async <T>(
  jobs: Array<{ data: T }>,
  run: (data: T) => Promise<void>,
  msg: string,
  logFn: (level: string, msg: string, data?: object) => void = log,
): Promise<void> => {
  let failure: unknown;
  for (const job of jobs) {
    try {
      await run(job.data);
    } catch (err) {
      logFn('error', msg, { ...(job.data as object), err: String(err) });
      failure ??= err; // um job ruim não impede os demais do lote
    }
  }
  if (failure !== undefined) throw failure;
};

export interface PublishingRuntimeOpts {
  databaseUrl: string;
  redisUrl?: string;
  publishing: PublishingRepository;
  channels: ChannelRepository;
  webhooks: WebhookRepository;
  registry: ChannelProviderRegistry;
  crypto: CryptoService;
  retryBaseSec: number;
  allowPrivateWebhookUrls?: boolean;
  /** secrets de app por provider (env → ctx.secrets do worker) */
  providerSecrets?: Record<string, Record<string, string>>;
  /** resolução de `mediaSettings` no publish (ex.: miniatura do YouTube: id → URL) */
  media?: Pick<MediaRepository, 'findMany'>;
  storage?: Pick<MediaStorage, 'publicUrl'>;
  /** coletor de métricas (SPEC_INFRA §4) — publish/recover incrementam contadores */
  metrics?: MetricsSink;
}

export interface PublishingRuntime {
  scheduler: JobScheduler;
  /** compartilhado com a API (ex.: rate-limit da superfície pública de aprovação) */
  rateLimiter?: RateLimiter;
  /** idempotência de POSTs da API pública (SPEC_API_MCP §3) — sem Redis fica indefinido (falha aberta) */
  idempotency?: IdempotencyStore;
  /** bus pub/sub p/ SSE — worker publica, API assina (mesmo objeto em MODE=all) */
  realtime?: ReturnType<typeof makeRedisRealtimeBus>;
  events: ReturnType<typeof makeEmitEvent>;
  publish: (publicationId: string, v?: number) => Promise<void>;
  recover: () => Promise<{ due: number; stuck: number }>;
  /** profundidade das filas (jobs created/retry) p/ o gauge do /metrics — SPEC_INFRA §4 */
  queueDepths(): Promise<Record<string, number>>;
  /**
   * Fila extra de outro módulo (ex.: máquina de conteúdo). Cria a fila na hora — a API precisa
   * conseguir enfileirar mesmo em MODE=api — e só consome depois do `startWorker`.
   */
  registerQueue(
    queue: string,
    run: (data: never) => Promise<void>,
    opts?: { cron?: string; expireInSeconds?: number; workers?: number },
  ): Promise<void>;
  startWorker(): Promise<void>;
  stop(): Promise<void>;
}

export async function createPublishingRuntime(
  opts: PublishingRuntimeOpts,
): Promise<PublishingRuntime> {
  const boss = new PgBoss({ connectionString: opts.databaseUrl });
  boss.on('error', (err) => log('error', 'pg-boss', { err: String(err) }));
  await boss.start();
  for (const q of [PUBLISH_QUEUE, THREAD_QUEUE, RECOVER_QUEUE, WEBHOOK_QUEUE]) {
    await boss.createQueue(q).catch(() => {}); // idempotente entre versões
  }
  const extras: Array<{
    queue: string;
    run: (data: never) => Promise<void>;
    cron?: string;
    workers: number;
  }> = [];
  // conexão dedicada para operações fora da API do pg-boss (cancel por singletonKey)
  const sqlc = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} });

  const scheduler: JobScheduler = {
    async enqueue(queue, payload, o) {
      const id = await boss.send(queue, payload, {
        ...(o?.startAfter ? { startAfter: o.startAfter } : {}),
        ...(o?.singletonKey ? { singletonKey: o.singletonKey } : {}),
        retryLimit: o?.retryLimit ?? 0, // retry de negócio é da máquina de estados
      });
      return id ?? 'deduped';
    },
    async cancelBySingletonKey(queue, singletonKey) {
      // higiene best-effort: a corretude vem do fencing estado+versão no handler
      await sqlc`
        UPDATE pgboss.job SET state = 'cancelled'
        WHERE name = ${queue} AND singleton_key = ${singletonKey}
          AND state IN ('created', 'retry')`.catch((err) =>
        log('warn', 'cancel de job falhou (inofensivo — fencing cobre)', { err: String(err) }),
      );
    },
    async schedule(queue, cron, payload) {
      await boss.schedule(queue, cron, (payload ?? {}) as object, {});
    },
  };

  const rateLimiter = opts.redisUrl ? makeRedisRateLimiter(opts.redisUrl) : undefined;
  const idempotency = opts.redisUrl ? makeRedisIdempotencyStore(opts.redisUrl) : undefined;
  const realtime = opts.redisUrl ? makeRedisRealtimeBus(opts.redisUrl) : undefined;
  const events = makeEmitEvent({
    webhooks: opts.webhooks,
    scheduler,
    ...(realtime ? { realtime } : {}),
    log,
  });
  // publish e continuação de thread compartilham EXATAMENTE as mesmas dependências
  const publishDeps = {
    publishing: opts.publishing,
    channels: opts.channels,
    registry: opts.registry,
    crypto: opts.crypto,
    scheduler,
    retryBaseSec: opts.retryBaseSec,
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    ...(opts.providerSecrets ? { secrets: opts.providerSecrets } : {}),
    ...(opts.media ? { media: opts.media } : {}),
    ...(opts.storage ? { storage: opts.storage } : {}),
    events,
    log,
  };
  const publish = makePublishPublication(publishDeps);
  const continueThread = makeContinueThread(publishDeps);
  const recover = makeRecoverDue({
    publishing: opts.publishing,
    scheduler,
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    log,
  });
  const deliver = makeDeliverWebhook({
    webhooks: opts.webhooks,
    crypto: opts.crypto,
    scheduler,
    ...(opts.allowPrivateWebhookUrls ? { allowPrivateUrls: true } : {}),
    log,
  });

  return {
    scheduler,
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(idempotency ? { idempotency } : {}),
    ...(realtime ? { realtime } : {}),
    events,
    publish,
    recover,
    async queueDepths() {
      try {
        const rows = await sqlc<{ name: string; count: string }[]>`
          SELECT name, count(*)::text AS count FROM pgboss.job
          WHERE state IN ('created', 'retry') GROUP BY name`;
        const out: Record<string, number> = {
          [PUBLISH_QUEUE]: 0,
          [THREAD_QUEUE]: 0,
          [RECOVER_QUEUE]: 0,
          [WEBHOOK_QUEUE]: 0,
        };
        for (const r of rows) out[r.name] = Number(r.count);
        return out;
      } catch (err) {
        log('warn', 'queueDepths falhou (métrica inofensiva)', { err: String(err) });
        return {};
      }
    },
    async registerQueue(queue, run, o) {
      await boss
        .createQueue(queue, o?.expireInSeconds ? { name: queue, expireInSeconds: o.expireInSeconds } : { name: queue })
        .catch(() => {}); // idempotente entre versões
      extras.push({ queue, run, ...(o?.cron ? { cron: o.cron } : {}), workers: Math.max(1, o?.workers ?? 1) });
    },
    async startWorker() {
      await boss.work<{ publicationId: string; v?: number }>(PUBLISH_QUEUE, (jobs) =>
        runBatch(jobs, (d) => publish(d.publicationId, d.v), 'publish handler falhou'),
      );
      await boss.work<{ publicationId: string; v: number; afterIndex: number }>(
        THREAD_QUEUE,
        (jobs) =>
          runBatch(
            jobs,
            (d) => continueThread(d.publicationId, d.v, d.afterIndex),
            'thread continuation falhou',
          ),
      );
      // Mesma política de publish/thread: erro inesperado de infra é relançado para o
      // pg-boss não marcar o job como entregue. Retries de negócio da delivery já são
      // persistidos dentro de `makeDeliverWebhook` (PENDING + re-enqueue).
      await boss.work<{ deliveryId: string }>(WEBHOOK_QUEUE, (jobs) =>
        runBatch(jobs, (d) => deliver(d.deliveryId), 'webhook delivery falhou'),
      );
      await boss.work(RECOVER_QUEUE, async () => {
        const out = await recover();
        opts.metrics?.onRecovered('due', out.due);
        opts.metrics?.onRecovered('stuck', out.stuck);
        if (out.due || out.stuck) log('warn', 'recover-scan agiu', out);
      });
      await boss.schedule(RECOVER_QUEUE, '* * * * *', {}, {}); // barato: índices parciais
      for (const x of extras) {
        // pg-boss 10 não tem concorrência local: cada `work` é um laço independente
        for (let i = 0; i < x.workers; i++) {
          await boss.work<never>(x.queue, (jobs) => runBatch(jobs, x.run, `${x.queue} falhou`));
        }
        if (x.cron) await boss.schedule(x.queue, x.cron, {}, {});
      }
      log('info', 'worker ativo', {
        queues: [PUBLISH_QUEUE, THREAD_QUEUE, WEBHOOK_QUEUE, RECOVER_QUEUE, ...extras.map((x) => x.queue)],
      });
    },
    async stop() {
      await boss.stop({ graceful: true });
      await rateLimiter?.close();
      await idempotency?.close();
      await realtime?.close();
      await sqlc.end();
    },
  };
}
