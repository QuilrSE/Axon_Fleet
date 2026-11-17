import express from 'express';
import {
  createLogger, requestLogger, corsMiddleware, errorHandler, listen, closeServer, RingBuffer,
  TaskStore, buildAgentCard, nowIso, HttpError, buildGatewayRoutes, buildIdentityRoutes, asyncHandler,
} from '@axon-fleet/shared';
import { TelemetryEngine } from './telemetryEngine.js';
import { createGatewayConfig } from './gatewayConfig.js';
import { VehicleAgent } from './agent.js';
import { buildA2ARoutes } from './a2aRoutes.js';

import CARD_TEMPLATE from './agent-card.json' with { type: 'json' };

export function createAgentA(cfg) {
  cfg = { agentId: 'agent-a', agentBId: 'agent-b', version: '0.1.0', gatewayDefaultEnabled: true, registrationIntervalMs: 15_000, telemetrySeed: 42, ...cfg };
  const logger = cfg.logger ?? createLogger('agent-a');
  const exchanges = new RingBuffer(80);
  const securityEvents = new RingBuffer(200);
  // URL published in the Agent Card: the runtime "advertised URL" if set, else the configured base URL.
  let gateway;
  const getBaseUrl = () => gateway?.runtime.get('advertisedBaseUrl') || cfg.baseUrl;
  const getCard = () => buildAgentCard(CARD_TEMPLATE, { baseUrl: getBaseUrl(), version: cfg.version, format: gateway?.runtime.get('cardFormat') || cfg.cardFormat || 'dual' });

  const engine = new TelemetryEngine({ seed: cfg.telemetrySeed });
  gateway = createGatewayConfig({ cfg, getCard, getBaseUrl, logger, exchanges, securityEvents });
  const agent = new VehicleAgent({ cfg, engine, gateway, securityEvents, logger, getBaseUrl });
  const localTasks = new TaskStore();
  // Seed one normal reading per vehicle so the dashboard is never empty.
  for (const v of engine.vehicles()) engine.generate(v.vehicleId, 'normal');

  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(cfg.corsOrigins));
  app.use(express.json({ limit: '256kb', type: ['application/json', 'application/a2a+json', 'application/*+json'] }));
  app.use(requestLogger(logger));

  app.get('/health', (req, res) => res.json({ status: 'ok', service: cfg.agentId, gatewayEnabled: gateway.connectivity.enabled }));
  app.use(buildA2ARoutes({ cfg, agent, engine, gateway, getCard, localTasks, exchanges, securityEvents }));

  // ── Dashboard API (local dev, unauthenticated) ───────────────────────
  const vehicleParam = (id) => {
    if (!engine.vehicles().some((v) => v.vehicleId === id)) throw new HttpError(400, 'UNKNOWN_VEHICLE', `vehicleId must be one of ${engine.vehicles().map((v) => v.vehicleId).join(', ')}`);
    return id;
  };
  app.get('/api/state', (req, res) => {
    const vehicleId = engine.vehicles().some((v) => v.vehicleId === req.query.vehicleId) ? req.query.vehicleId : 'veh-001';
    res.json({
      agent: { id: cfg.agentId, name: getCard().name, baseUrl: getBaseUrl(), cardUrl: `${getBaseUrl()}/.well-known/agent-card.json`, a2aEndpoint: `${getBaseUrl()}/a2a` },
      now: nowIso(),
      mode: gateway.describe(),
      card: getCard(),
      vehicles: engine.vehicles(),
      scenarios: engine.scenarios(),
      selectedVehicle: vehicleId,
      latest: engine.latest(vehicleId),
      history: engine.historyFor(vehicleId, 12),
      tasks: agent.taskList(20),
      exchanges: exchanges.list(25),
      securityEvents: securityEvents.list(60),
      probes: agent.probes.list(),
    });
  });
  app.post('/api/telemetry', (req, res) => {
    const { vehicleId = 'veh-001', scenario = 'normal' } = req.body ?? {};
    try { res.json(agent.generateTelemetry(vehicleParam(vehicleId), scenario)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'INVALID_TELEMETRY_REQUEST', e.message); }
  });
  app.post('/api/service-request', asyncHandler(async (req, res) => {
    const rec = await agent.sendServiceRequest(vehicleParam(req.body?.vehicleId ?? 'veh-001'));
    res.status(rec.state === 'failed' ? 502 : 202).json(rec);
  }));
  app.post('/api/discover', asyncHandler(async (req, res) => res.json(await gateway.discover())));
  app.post('/api/tasks/:taskId/refresh', asyncHandler(async (req, res) => res.json(await agent.refreshTask(req.params.taskId))));
  app.post('/api/tasks/:taskId/cancel', asyncHandler(async (req, res) => res.json(await agent.cancelTask(req.params.taskId))));
  app.post('/api/probe', asyncHandler(async (req, res) => res.json(await agent.runProbe(req.body?.type))));
  app.put('/api/config', (req, res) => {
    if (typeof req.body?.gatewayEnabled !== 'boolean') throw new HttpError(400, 'INVALID_CONFIG', 'gatewayEnabled (boolean) is required');
    gateway.connectivity.setEnabled(req.body.gatewayEnabled, 'agent-a-dashboard');
    securityEvents.push({ timestamp: nowIso(), direction: 'config', decision: 'mode_changed', severity: req.body.gatewayEnabled ? 'info' : 'warning', detail: req.body.gatewayEnabled ? 'A2A Gateway enabled — discovery and routing via gateway' : 'A2A Gateway disabled — direct A2A, gateway controls bypassed' });
    res.json(gateway.describe());
  });
  app.post('/api/config/reset', (req, res) => { gateway.connectivity.resetMode('agent-a-dashboard'); res.json(gateway.describe()); });
  app.use(buildGatewayRoutes({ connectivity: gateway.connectivity, securityEvents, agentEnvPrefix: 'AGENT_A' }));
  app.use(buildIdentityRoutes({ cfg, connectivity: gateway.connectivity, getBaseUrl, securityEvents, peer: () => ({ label: 'Agent B (dealership)', cardUrl: gateway.peerCardUrl(), directEndpoint: gateway.peerDirectUrl(), isDefault: !gateway.runtime.get('peerCardUrl'), defaultCardUrl: cfg.agentBCardUrl }) }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: req.matchedRoutes?.length ? `${req.method} ${req.path} matched route ${req.matchedRoutes.join(', ')} on ${cfg.agentId}, but its handler finished without responding (an internal failure, not a missing route). Check the Worker logs.` : `${req.method} ${req.path} does not exist on ${cfg.agentId}` } }));
  app.use(errorHandler(logger));

  let server = null;
  return {
    app, cfg, getBaseUrl, agent, engine, gateway, getCard,
    async start({ port = 4001, host = '0.0.0.0', publicHost = 'localhost' } = {}) {
      server = await listen(app, port, host);
      const actual = server.address().port;
      cfg.port = actual;
      cfg.baseUrl ??= `http://${publicHost}:${actual}`;
      gateway.connectivity.start();
      logger.info('agent_started', { agentId: cfg.agentId, port: actual, baseUrl: cfg.baseUrl, gatewayEnabled: gateway.connectivity.enabled });
      return { server, port: actual };
    },
    async stop() { gateway.connectivity.stop(); await closeServer(server); },
  };
}
