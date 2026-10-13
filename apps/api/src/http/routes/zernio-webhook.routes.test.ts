import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { zernioWebhookRoutes } from './zernio-webhook.routes';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

function makeApp() {
  const gravados: Array<{ eventId: string; eventType: string }> = [];
  const vistos = new Set<string>();
  const app = zernioWebhookRoutes({
    secret: SECRET,
    engine: {
      async ingest(e) {
        gravados.push({ eventId: e.eventId, eventType: e.eventType });
        if (vistos.has(e.eventId)) return { duplicate: true as const };
        vistos.add(e.eventId);
        return { duplicate: false as const, id: `ev-${vistos.size}` };
      },
    },
  });
  return { app, gravados };
}

const enviar = (app: ReturnType<typeof makeApp>['app'], body: string, headers: Record<string, string>) =>
  app.request('/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('webhook da Zernio', () => {
  const body = JSON.stringify({ id: 'e-1', event: 'comment.received', comment: {} });

  it('assinatura ausente ou errada → 401 e nada gravado', async () => {
    const { app, gravados } = makeApp();
    expect((await enviar(app, body, {})).status).toBe(401);
    expect((await enviar(app, body, { 'x-zernio-signature': sign('outro') })).status).toBe(401);
    expect(gravados).toEqual([]);
  });

  it('assinatura certa grava com o id e o tipo dos cabeçalhos', async () => {
    const { app, gravados } = makeApp();
    const res = await enviar(app, body, {
      'x-zernio-signature': sign(body),
      'x-zernio-event': 'comment.received',
      'x-zernio-event-id': 'hdr-1',
    });
    expect(res.status).toBe(200);
    expect(gravados).toEqual([{ eventId: 'hdr-1', eventType: 'comment.received' }]);
  });

  it('reentrega responde 200 marcada como duplicada', async () => {
    const { app } = makeApp();
    const h = { 'x-zernio-signature': sign(body) };
    await enviar(app, body, h);
    const res = await enviar(app, body, h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  it('evento que a automação não usa → 200 sem gravar', async () => {
    const { app, gravados } = makeApp();
    const outro = JSON.stringify({ id: 'e-2', event: 'webhook.test' });
    const res = await enviar(app, outro, { 'x-zernio-signature': sign(outro) });
    expect(res.status).toBe(200);
    expect(gravados).toEqual([]);
  });

  it('corpo grande demais → 413 antes de verificar', async () => {
    const { app, gravados } = makeApp();
    const grande = 'x'.repeat(300 * 1024);
    expect((await enviar(app, grande, { 'x-zernio-signature': sign(grande) })).status).toBe(413);
    expect(gravados).toEqual([]);
  });
});
