import { verifyZernioSignature } from '@manypost/providers';
import type { AutomationEngine } from '@manypost/core';
import { Hono } from 'hono';
import { log } from '../../log';

/**
 * Webhook da Zernio → automação comentário → direct (openspec add-comment-automation, design D7).
 * Montado em `/v1/integrations/zernio` só com a ponte e `ZERNIO_WEBHOOK_SECRET`. Sem sessão: a
 * autenticação é o HMAC do corpo cru (`X-Zernio-Signature`), comparado em tempo constante. A rota
 * só grava o evento uma vez e enfileira — a Zernio exige 2xx em 5 s.
 */

const MAX_BODY = 256 * 1024;
const HANDLED = new Set(['comment.received', 'message.received']);

export function zernioWebhookRoutes(deps: { engine: Pick<AutomationEngine, 'ingest'>; secret: string }) {
  const app = new Hono();

  app.post('/webhook', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_BODY) return c.json({ ok: false }, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ ok: false }, 413);

    if (!verifyZernioSignature(deps.secret, raw, c.req.header('x-zernio-signature'))) {
      log('warn', 'zernio.webhook.bad_signature', {});
      return c.json({ ok: false }, 401);
    }

    let payload: { id?: unknown; event?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return c.json({ ok: false }, 400);
    }
    const eventType = c.req.header('x-zernio-event') ?? (typeof payload.event === 'string' ? payload.event : '');
    const eventId = c.req.header('x-zernio-event-id') ?? (typeof payload.id === 'string' ? payload.id : '');
    // teste da Zernio e eventos que a automação não usa: 200 sem gravar
    if (!HANDLED.has(eventType) || !eventId) return c.json({ ok: true, ignored: true });

    const r = await deps.engine.ingest({ eventId: eventId.slice(0, 200), eventType, payload });
    return c.json({ ok: true, duplicate: r.duplicate });
  });

  return app;
}
