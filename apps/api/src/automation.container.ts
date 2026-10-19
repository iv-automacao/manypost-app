import type { Env } from '@manypost/config';
import {
  AUTOMATION_EVENT_QUEUE,
  AUTOMATION_PROVIDERS,
  makeAutomationEngine,
  makeAutomations,
  type AuditLogRepository,
  type AutomationGateway,
  type AutomationTimerJob,
  type ChannelRepository,
} from '@manypost/core';
import { makeAutomationRepository, makeNotificationRepository, type Db } from '@manypost/db';
import { parseZernioEvent, type ZernioBridge } from '@manypost/providers';
import type { PublishingRuntime } from '@manypost/queue';
import { log } from './log';

/**
 * Fiação da automação comentário → direct (openspec add-comment-automation). O motor roda na fila
 * `automation-event` do processo da API (MODE=all), um job por vez (design D6): o worker dedicado
 * não consome esta fila, como a máquina de conteúdo.
 *
 * O CRUD existe sempre (dá para montar a automação antes de ligar a ponte); o motor e a rota do
 * webhook só existem com a ponte Zernio configurada e `ZERNIO_WEBHOOK_SECRET`.
 */
export async function buildAutomation(
  env: Env,
  db: Db,
  runtime: PublishingRuntime,
  base: {
    channels: ChannelRepository;
    audit: AuditLogRepository;
    zernio: ZernioBridge | null;
    zernioOrgs: Set<string>;
  },
) {
  const repo = makeAutomationRepository(db);
  const automations = makeAutomations({ repo, channels: base.channels, audit: base.audit });
  const zernio = base.zernio;
  if (!zernio || !env.ZERNIO_WEBHOOK_SECRET) return { automations, engine: null, webhookSecret: null };

  const gateway: AutomationGateway = {
    source: 'zernio',
    parse: parseZernioEvent,
    async resolve(accountRef) {
      const acc = await zernio.accountById(accountRef);
      if (!acc) return null;
      const uname = acc.username?.toLowerCase() ?? null;
      // só canais das organizações autorizadas na ponte (ZERNIO_ORG_IDS)
      for (const orgId of base.zernioOrgs) {
        const found = (await base.channels.list(orgId)).find((c) => {
          if (!(AUTOMATION_PROVIDERS as readonly string[]).includes(c.provider) || c.status !== 'ACTIVE') return false;
          const userId = (c.settings as { userId?: unknown } | null)?.userId;
          if (acc.platformUserId && (userId === acc.platformUserId || c.externalId === acc.platformUserId)) return true;
          return Boolean(uname && c.username?.toLowerCase() === uname);
        });
        if (found) {
          const t = zernio.bind(accountRef);
          return { channel: { id: found.id, orgId: found.orgId }, comments: t, direct: t };
        }
      }
      return null;
    },
  };

  const engine = makeAutomationEngine({
    repo,
    gateway,
    scheduler: runtime.scheduler,
    events: runtime.events,
    // balão "Avisar a equipe" (add-flow-action-node)
    notifications: makeNotificationRepository(db),
    // só ids e status nos logs do motor — nunca texto, username nem resposta
    log: (level, msg, data) => log(level, msg, data as Record<string, unknown> | undefined),
  });
  await runtime.registerQueue(
    AUTOMATION_EVENT_QUEUE,
    // eventos da ponte e jobs de tempo (atraso/lembrete) dividem a fila serial
    async (d: { inboundEventId: string } | AutomationTimerJob) => {
      if ('timer' in d) await engine.processTimer(d);
      else await engine.process(d.inboundEventId);
    },
    { workers: 1, expireInSeconds: 300 },
  );
  return { automations, engine, webhookSecret: env.ZERNIO_WEBHOOK_SECRET };
}

export type AutomationModule = Awaited<ReturnType<typeof buildAutomation>>;
