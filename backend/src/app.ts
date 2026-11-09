import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Db } from './db/database.js';
import type { MatchAssistant } from './engine/index.js';
import { routes } from './routes/api.js';
import { tenantByApiKey } from './services/reconciliation.js';
import { AppError } from './services/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: { id: string; name: string };
    actor: string;
  }
}

export interface AppOptions {
  db: Db;
  assistant?: MatchAssistant;
  demoMode?: boolean;
  staticDir?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 }).withTypeProvider<TypeBoxTypeProvider>();

  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  await app.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/], allowedHeaders: ['content-type', 'x-api-key', 'x-actor', 'idempotency-key'] });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Invoice-to-Bank Reconciliation API (PoC)',
        version: '0.1.0',
        description:
          'Multi-tenant invoice-to-bank reconciliation. Authenticate with `x-api-key` (demo keys: `demo_nilefoods_key`, `demo_lotustextiles_key`). ' +
          'Money is always integer minor units (piasters/cents). Every state change is written to a hash-chained audit log.',
      },
      components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
      security: [{ apiKey: [] }],
      tags: [
        { name: 'invoices', description: 'Receivables (normally synced from the ERP)' },
        { name: 'transactions', description: 'Bank statement lines (multi-bank)' },
        { name: 'reconciliation', description: 'Run the matching pipeline, review suggestions' },
        { name: 'reports', description: 'Summary, CSV export, audit trail' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Security headers (minimal; a production edge would add HSTS/CSP at the gateway).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });

  // Tenant resolution: every /api/v1 route requires an API key, mapped to exactly one tenant.
  app.decorateRequest('tenant', null as unknown as FastifyRequest['tenant']);
  app.decorateRequest('actor', '');
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    const key = req.headers['x-api-key'];
    const tenant = typeof key === 'string' && key.length >= 8 ? tenantByApiKey(opts.db, key) : undefined;
    if (!tenant) return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid x-api-key' });
    req.tenant = tenant;
    // Demo: reviewer name comes from x-actor. Production: from the verified user token (sub claim).
    const actor = String(req.headers['x-actor'] ?? '').replace(/[^\p{L}\p{N} ._@-]/gu, '').slice(0, 64);
    req.actor = actor ? `user:${actor}` : `apikey:${tenant.id}`;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'validation_error', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'unexpected error' });
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok', assistant: opts.assistant?.name ?? 'none' }));

  await app.register(routes, { prefix: '/api/v1', db: opts.db, assistant: opts.assistant, demoMode: opts.demoMode ?? false });

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'route not found' });
    });
  } else {
    app.get('/', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/docs'));
  }
  return app;
}
