import express from 'express';
import {
  createLogger, requestLogger, corsMiddleware, errorHandler, listen, closeServer, RingBuffer,
  TaskStore, buildAgentCard, nowIso, HttpError, buildGatewayRoutes, buildIdentityRoutes,
} from '@axon-fleet/shared';
import { InventoryService } from './inventoryService.js';
import { PartsOrderService } from './partsOrderService.js';
import { SchedulingService } from './schedulingService.js';
import { DealerServiceAgent } from './agent.js';
import { createGatewayConfig } from './gatewayConfig.js';
import { buildA2ARoutes } from './a2aRoutes.js';

import CARD_TEMPLATE from './agent-card.json' with { type: 'json' };

export function createAgentB(cfg) {
  cfg = { agentId: 'agent-b', version: '0.1.0', gatewayDefaultEnabled: true, stepDelayMs: 900, registrationIntervalMs: 15_000, ...cfg };
  const logger = cfg.logger ?? createLogger('agent-b');
  const exchanges = new RingBuffer(80);
  const securityEvents = new RingBuffer(200);
  // URL published in the Agent Card: the runtime "advertised URL" if set, else the configured base URL.
  let gateway;
  const getBaseUrl = () => gateway?.runtime.get('advertisedBaseUrl') || cfg.baseUrl;
  const getCard = () => buildAgentCard(CARD_TEMPLATE, { baseUrl: getBaseUrl(), version: cfg.version, format: gateway?.runtime.get('cardFormat') || cfg.cardFormat || 'dual' });

  const tasks = new TaskStore();
  const inventory = new InventoryService();
  const orders = new PartsOrderService({ progressMs: cfg.orderProgressMs ?? 1500 });
  const scheduling = new SchedulingService();
  gateway = createGatewayConfig({ cfg, getCard, getBaseUrl, logger, exchanges, securityEvents, getPushConfigs: (id) => agent.pushConfigs.list(id) });
  const agent = new DealerServiceAgent({ inventory, orders, scheduling, tasks, notifier: { push: gateway.push }, stepDelayMs: cfg.stepDelayMs, logger });

  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(cfg.corsOrigins));
  app.use(express.json({ limit: '256kb', type: ['application/json', 'application/a2a+json', 'application/*+json'] }));
  app.use(requestLogger(logger));

  app.get('/health', (req, res) => res.json({ status: 'ok', service: cfg.agentId, gatewayEnabled: gateway.connectivity.enabled, activeTasks: tasks.list().filter((t) => t.status.state === 'working' || t.status.state === 'submitted').length }));
  app.use(buildA2ARoutes({ cfg, agent, tasks, gateway, getCard, exchanges, securityEvents }));

  // ── Dashboard API (local dev, unauthenticated) ───────────────────────
  app.get('/api/state', (req, res) => {
    res.json({
      agent: { id: cfg.agentId, name: getCard().name, baseUrl: getBaseUrl(), cardUrl: `${getBaseUrl()}/.well-known/agent-card.json`, a2aEndpoint: `${getBaseUrl()}/a2a`, runtime: agent.flow.describe() },
      now: nowIso(),
      mode: gateway.describe(),
      card: getCard(),
      tasks: tasks.list(30),
      workOrders: agent.workOrderList(),
      inventory: inventory.list(),
      reservations: [...inventory.reservations].reverse().slice(0, 40),
      orders: orders.list(),
      schedule: scheduling.view({ slotLimit: 12 }),
      exchanges: exchanges.list(25),
      securityEvents: securityEvents.list(60),
    });
  });
  app.put('/api/config', (req, res) => {
    if (typeof req.body?.gatewayEnabled !== 'boolean') throw new HttpError(400, 'INVALID_CONFIG', 'gatewayEnabled (boolean) is required');
    gateway.connectivity.setEnabled(req.body.gatewayEnabled, 'agent-b-dashboard');
    securityEvents.push({ timestamp: nowIso(), direction: 'config', decision: 'mode_changed', severity: req.body.gatewayEnabled ? 'info' : 'warning', detail: req.body.gatewayEnabled ? 'A2A Gateway enabled — direct calls will be refused' : 'A2A Gateway disabled — direct A2A accepted, gateway controls bypassed' });
    res.json(gateway.describe());
  });
  app.post('/api/config/reset', (req, res) => { gateway.connectivity.resetMode('agent-b-dashboard'); res.json(gateway.describe()); });
  app.use(buildGatewayRoutes({ connectivity: gateway.connectivity, securityEvents, agentEnvPrefix: 'AGENT_B' }));
  app.use(buildIdentityRoutes({ cfg, connectivity: gateway.connectivity, getBaseUrl, securityEvents, peer: null }));
  app.post('/api/reset', (req, res) => { agent.reset(); exchanges.clear(); securityEvents.clear(); res.json({ reset: true }); });
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} does not exist on ${cfg.agentId}` } }));
  app.use(errorHandler(logger));

  let server = null;
  return {
    app, cfg, getBaseUrl, agent, tasks, gateway, inventory, getCard,
    async start({ port = 4002, host = '0.0.0.0', publicHost = 'localhost' } = {}) {
      server = await listen(app, port, host);
      const actual = server.address().port;
      cfg.port = actual;
      cfg.baseUrl ??= `http://${publicHost}:${actual}`;
      gateway.connectivity.start();
      logger.info('agent_started', { agentId: cfg.agentId, port: actual, baseUrl: cfg.baseUrl, gatewayEnabled: gateway.connectivity.enabled });
      return { server, port: actual };
    },
    async stop() { gateway.connectivity.stop(); orders.reset(); await closeServer(server); },
  };
}
