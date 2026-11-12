/** Integration endpoints: adapter webhooks, MCP (streamable HTTP) and Prometheus metrics. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { handleMcpHttp } from '@mercury/mcp';
import type { Ctx } from '../http.js';

export function registerIntegrationRoutes(app: FastifyInstance, { m, auth }: Ctx): void {
  const webhook = async (req: FastifyRequest, reply: FastifyReply) => {
    const name = (req.params as { name: string }).name;
    const res = await m.gateway.handleWebhook(name, {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
      query: req.query as Record<string, string>,
      body: req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''),
    });
    if (res.contentType) reply.type(res.contentType);
    return reply.code(res.status).send(res.body ?? '');
  };
  app.get('/webhooks/:name', webhook);
  app.post('/webhooks/:name', webhook);

  if (m.config.mcp.server.enabled) {
    // Stateless streamable HTTP: every request carries a bearer token (JWT or API token with `mcp` scope).
    app.post(m.config.mcp.server.path, async (req, reply) => {
      const principal = auth(req, 'mcp.access');
      reply.hijack();
      await handleMcpHttp(m.mcpBackend(), principal, req.raw, reply.raw, req.body);
    });
    app.get(m.config.mcp.server.path, async (_req, reply) => reply.code(405).send({ error: 'use POST (stateless streamable HTTP)' }));
  }

  app.get('/metrics', async (_req, reply) => {
    if (!m.config.observability.metrics) return reply.code(404).send('metrics disabled');
    return reply.type('text/plain; version=0.0.4').send(m.metrics.render());
  });
}
