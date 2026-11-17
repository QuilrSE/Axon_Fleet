import express from 'express';
import {
  createLogger, requestLogger, corsMiddleware, errorHandler, listen, closeServer,
  RingBuffer, nowIso, DEFAULT_POLICY,
} from '@axon-fleet/shared';
import { createAuthService } from './authService.js';
import { createPolicyService } from './policyEngine.js';
import { createAuditService } from './auditLog.js';
import { createRegistryService } from './registry.js';
import { GatewayTaskIndex } from './taskStore.js';
import { createRouter } from './router.js';
import { buildRoutes } from './routes.js';

/**
 * @param {object} cfg
 * @param {Record<string,string>} cfg.tokens      agentId -> bearer token accepted by the gateway
 * @param {string} cfg.forwardToken               credential presented to agents on forwarded calls
 * @param {string} [cfg.authMode]                 static | oauth2 | oidc | mtls
 * @param {{limit:number, windowMs:number}} [cfg.rateLimit]
 */
export function createGateway(cfg) {
  const logger = cfg.logger ?? createLogger('a2a-gateway');
  const ctx = {
    cfg: { ...cfg, knownSecrets: [...Object.values(cfg.tokens ?? {}), cfg.forwardToken, ...(cfg.extraSecrets ?? [])] },
    logger,
    startedAt: nowIso(),
    auth: createAuthService({ mode: cfg.authMode ?? 'static', tokens: cfg.tokens ?? {} }),
    policy: createPolicyService({ policy: cfg.policy ?? DEFAULT_POLICY, rateLimit: cfg.rateLimit ?? { limit: 20, windowMs: 10_000 } }),
    registry: createRegistryService({ logger, healthIntervalMs: cfg.healthIntervalMs ?? 5000 }),
    audit: createAuditService({ logger }),
    tasks: new GatewayTaskIndex(),
    routeLog: new RingBuffer(500),
    rateLimitEvents: new RingBuffer(200),
    stats: { routed: 0, denied: 0, rateLimited: 0, unauthenticated: 0, invalid: 0, upstreamErrors: 0 },
  };
  ctx.router = createRouter(ctx);

  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(cfg.corsOrigins));
  app.use(express.json({ limit: '256kb', type: ['application/json', 'application/a2a+json', 'application/*+json'] }));
  app.use(requestLogger(logger));
  app.use(buildRoutes(ctx));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} does not exist on the gateway` } }));
  app.use(errorHandler(logger));

  let server = null;
  return {
    app,
    ctx,
    async start({ port = 4000, host = '0.0.0.0' } = {}) {
      server = await listen(app, port, host);
      ctx.registry.startHealthChecks();
      const actual = server.address().port;
      logger.info('gateway_started', { port: actual });
      return { server, port: actual };
    },
    async stop() { ctx.registry.stopHealthChecks(); await closeServer(server); },
  };
}
