/**
 * HTTP server (Fastify): body parsing (raw bodies kept for webhook signatures),
 * authentication, error mapping, static web UI and route registration.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { RateLimiter, type Action, type Principal } from '@mercury/core';
import type { Mercury } from '@mercury/runtime';
import { registerCoreRoutes } from './routes/core.js';
import { registerManageRoutes } from './routes/manage.js';
import { registerIntegrationRoutes } from './routes/integration.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    principal?: Principal;
  }
}

export const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Helpers shared by route modules. */
export interface Ctx {
  m: Mercury;
  /** Require an authenticated principal allowed to perform `action` (403/401 otherwise). */
  auth(req: FastifyRequest, action?: Action): Principal;
  /** Start a Server-Sent Events response; returns a writer and an "on close" registration. */
  sse(req: FastifyRequest, reply: FastifyReply): { send(event: string, data: unknown): void; onClose(fn: () => void): void; end(): void };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function createServer(m: Mercury): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: m.config.server.maxBodyBytes, trustProxy: true });
  const limiter = new RateLimiter(m.config.server.rateLimit.max, m.config.server.rateLimit.windowMs);

  // Keep raw text for JSON/form bodies (webhook signatures); binary uploads arrive as Buffers.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new HttpError(400, 'invalid JSON body'), undefined);
    }
  });
  app.addContentTypeParser(['application/x-www-form-urlencoded', 'text/plain', 'text/xml'], { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, body);
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !limiter.hit(req.ip)) return reply.code(429).send({ error: 'rate limit exceeded' });
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.setErrorHandler((err: Error & { status?: number; statusCode?: number; code?: string; helpTopic?: string }, _req, reply) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) m.logger.warn('request failed', { error: err.message });
    void reply.code(status).send({ error: err.message, code: err.code, help: err.helpTopic });
  });

  const ctx: Ctx = {
    m,
    auth(req, action) {
      const header = req.headers.authorization ?? (req.query as Record<string, string>).token;
      const p = req.principal ?? m.users.authenticate(header);
      if (!p) throw new HttpError(401, 'authentication required');
      req.principal = p;
      if (action) m.policy.assert(p, action);
      return p;
    },
    sse(req, reply) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const closers: Array<() => void> = [];
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        closers.forEach((f) => f());
      });
      return {
        send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        onClose: (fn) => closers.push(fn),
        end: () => {
          clearInterval(ping);
          res.end();
        },
      };
    },
  };

  registerCoreRoutes(app, ctx);
  registerManageRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);

  // Static single-page app (no build step).
  app.get('/*', async (req, reply) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
    let file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(file)) return reply.code(404).send({ error: 'web UI not found' });
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
  });
  return app;
}

export async function startServer(m: Mercury, opts: { host?: string; port?: number } = {}): Promise<FastifyInstance> {
  const app = await createServer(m);
  await app.listen({ host: opts.host ?? m.config.server.host, port: opts.port ?? m.config.server.port });
  return app;
}
