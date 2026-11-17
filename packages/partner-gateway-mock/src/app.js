// Mock THIRD-PARTY A2A gateway ("Partner A2A Exchange").
// It exists to prove the agents can register with and route through a gateway that is NOT ours,
// so its API differs on purpose:
//   PUT    /v1/agents/{agentId}       body = raw Agent Card,   auth = X-API-Key
//   DELETE /v1/agents/{agentId}
//   GET    /v1/agents?skill=&tag=     → { items: [{ id, name, url, status, card }] }
//   POST   /v1/agents/{agentId}/rpc   forwards JSON-RPC, adds X-Partner-Caller
//   GET    /healthz
// Controls it applies: API-key authentication, sender binding, an audit list.
// Controls it does NOT apply: agent allowlist, skill authorization, rate limiting.
import express from 'express';
import {
  createLogger, corsMiddleware, errorHandler, listen, closeServer, validateAgentCard, readEnvelope,
  fetchJson, safeEqual, RingBuffer, nowIso, newId, cardEndpoint,
} from '@axon-fleet/shared';

export function createPartnerGateway({ apiKeys = {}, forwardToken, logger = createLogger('partner-gateway'), corsOrigins } = {}) {
  const agents = new Map();
  const audit = new RingBuffer(500);
  const startedAt = nowIso();
  const callerOf = (req) => Object.entries(apiKeys).find(([, k]) => safeEqual(k, req.get('x-api-key') ?? ''))?.[0] ?? null;
  const record = (e) => audit.push({ id: newId('pgw'), at: nowIso(), ...e });

  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(corsOrigins));
  app.use(express.json({ limit: '256kb', type: ['application/json', 'application/a2a+json', 'application/*+json'] }));

  app.get('/healthz', (req, res) => res.json({ ok: true, service: 'partner-a2a-exchange (mock)', startedAt, agents: agents.size }));

  const auth = (req, res, next) => {
    const caller = callerOf(req);
    if (!caller) {
      record({ event: 'auth_failed', path: req.path, status: 401 });
      return res.status(401).json({ error: 'invalid or missing X-API-Key' });
    }
    req.caller = caller;
    next();
  };

  app.put('/v1/agents/:agentId', auth, (req, res) => {
    if (req.caller !== req.params.agentId) return res.status(403).json({ error: `key for '${req.caller}' cannot register '${req.params.agentId}'` });
    const { valid, errors } = validateAgentCard(req.body, { knownSecrets: [...Object.values(apiKeys), forwardToken] });
    if (!valid) return res.status(422).json({ error: `invalid agent card: ${errors.join('; ')}` });
    const created = !agents.has(req.params.agentId);
    agents.set(req.params.agentId, { id: req.params.agentId, card: req.body, registeredAt: agents.get(req.params.agentId)?.registeredAt ?? nowIso(), updatedAt: nowIso() });
    if (created) record({ event: 'agent_registered', caller: req.caller, status: 201 });
    res.status(created ? 201 : 200).json({ id: req.params.agentId, status: 'active' });
  });

  app.delete('/v1/agents/:agentId', auth, (req, res) => {
    if (req.caller !== req.params.agentId) return res.status(403).json({ error: 'agents may only remove themselves' });
    agents.delete(req.params.agentId);
    record({ event: 'agent_removed', caller: req.caller, status: 200 });
    res.json({ removed: true });
  });

  app.get('/v1/agents', auth, (req, res) => {
    const { skill, tag } = req.query;
    const items = [...agents.values()]
      .filter((a) => !skill || a.card.skills.some((s) => s.id === skill))
      .filter((a) => !tag || a.card.skills.some((s) => (s.tags ?? []).includes(tag)))
      .map((a) => ({ id: a.id, name: a.card.name, url: cardEndpoint(a.card), status: 'healthy', card: a.card }));
    res.json({ items, total: items.length });
  });

  app.post('/v1/agents/:agentId/rpc', auth, async (req, res) => {
    const env = readEnvelope(req.body);
    const base = { caller: req.caller, target: req.params.agentId, skill: env?.skill ?? null, method: req.body?.method ?? null, taskId: env?.task_id ?? null };
    if (env?.sender_agent_id !== req.caller) {
      record({ event: 'rpc_rejected', ...base, reason: 'sender mismatch', status: 403 });
      return res.status(403).json({ error: `envelope sender '${env?.sender_agent_id}' does not match API key owner '${req.caller}'` });
    }
    const target = agents.get(req.params.agentId);
    if (!target) {
      record({ event: 'rpc_rejected', ...base, reason: 'unknown agent', status: 404 });
      return res.status(404).json({ error: `agent '${req.params.agentId}' is not listed on this exchange` });
    }
    const up = await fetchJson(cardEndpoint(target.card), { method: 'POST', headers: { authorization: `Bearer ${forwardToken}`, 'x-partner-caller': req.caller }, body: req.body, timeoutMs: 8000 });
    record({ event: 'rpc_forwarded', ...base, status: up.status });
    if (up.status === 0) return res.status(502).json({ error: up.data?.error?.message ?? 'upstream unreachable' });
    res.status(up.status).json(up.data);
  });

  // Read-only operator view (unauthenticated, local dev).
  app.get('/v1/audit', (req, res) => res.json({ events: audit.list(100) }));
  app.get('/', (req, res) => res.json({ service: 'Partner A2A Exchange (mock third-party gateway)', agents: [...agents.keys()], audit: '/v1/audit' }));
  app.use(errorHandler(logger));

  let server = null;
  return {
    app, agents, audit,
    async start({ port = 4100, host = '0.0.0.0' } = {}) { server = await listen(app, port, host); const p = server.address().port; logger.info('partner_gateway_started', { port: p }); return { server, port: p }; },
    async stop() { await closeServer(server); },
  };
}
