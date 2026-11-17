import express from 'express';
import { asyncHandler, summarizeEntry, nowIso } from '@axon-fleet/shared';

export function buildRoutes(ctx) {
  const { auth, policy, registry, audit, tasks, routeLog, rateLimitEvents, stats, router, cfg, startedAt } = ctx;
  const r = express.Router();

  r.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'a2a-gateway', startedAt, uptimeSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000), registeredAgents: registry.list().length });
  });

  // Authenticate registry calls (registration + discovery require an agent credential).
  const requireAgent = asyncHandler(async (req, res, next) => {
    const result = await auth.authenticate(req);
    if (!result.ok) {
      stats.unauthenticated += 1;
      audit.record({ type: 'authentication', caller: 'unknown', target: 'a2a-gateway', action: `${req.method} ${req.path}`, authentication: 'fail', reason: result.reason, responseStatus: 401 });
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: `Gateway authentication failed (${result.reason})` } });
    }
    req.principal = result.principal;
    next();
  });

  // ── Registry ────────────────────────────────────────────────────────
  r.post('/registry/agents', requireAgent, (req, res) => {
    const { agentId, card, agentCardUrl } = req.body ?? {};
    const deny = (status, code, message) => {
      audit.record({ type: 'registration', caller: req.principal.agentId, target: 'a2a-gateway', agentId, authentication: 'pass', authorization: 'deny', reason: message, responseStatus: status });
      res.status(status).json({ error: { code, message } });
    };
    if (agentId !== req.principal.agentId) return deny(403, 'FORBIDDEN', `Credential for '${req.principal.agentId}' cannot register '${agentId}'`);
    if (!policy.isAllowlisted(agentId)) return deny(403, 'FORBIDDEN', `'${agentId}' is not on the agent allowlist`);
    const result = registry.register({ agentId, card, agentCardUrl }, { knownSecrets: cfg.knownSecrets });
    if (!result.ok) return deny(400, 'INVALID_AGENT_CARD', `Agent Card rejected: ${result.errors.join('; ')}`);
    // Heartbeats that change nothing are not audited (keeps the trail readable); new or changed cards are.
    if (result.changed) audit.record({ type: 'registration', caller: agentId, target: 'a2a-gateway', agentId, authentication: 'pass', authorization: 'allow', reason: result.created ? 'registered' : 'agent card updated', responseStatus: result.created ? 201 : 200 });
    registry.checkAll().catch(() => {});
    res.status(result.created ? 201 : 200).json({ registered: true, agent: summarizeEntry(result.entry) });
  });

  r.delete('/registry/agents/:agentId', requireAgent, (req, res) => {
    if (req.params.agentId !== req.principal.agentId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Agents may only deregister themselves' } });
    const removed = registry.remove(req.params.agentId);
    audit.record({ type: 'registration', caller: req.principal.agentId, target: 'a2a-gateway', agentId: req.params.agentId, authentication: 'pass', authorization: 'allow', reason: 'deregistered', responseStatus: removed ? 200 : 404 });
    res.status(removed ? 200 : 404).json({ removed });
  });

  r.get('/registry/agents', requireAgent, (req, res) => {
    const query = { skill: req.query.skill, tag: req.query.tag, name: req.query.name, capability: req.query.capability, provider: req.query.provider };
    const found = registry.discover(query).map(summarizeEntry);
    audit.record({ type: 'discovery', caller: req.principal.agentId, target: 'a2a-gateway', query: Object.fromEntries(Object.entries(query).filter(([, v]) => v)), resultCount: found.length, authentication: 'pass', authorization: 'allow', responseStatus: 200 });
    res.json({ query, count: found.length, agents: found });
  });

  r.get('/registry/agents/:agentId/card', requireAgent, (req, res) => {
    const entry = registry.get(req.params.agentId);
    if (!entry) return res.status(404).json({ error: { code: 'NOT_FOUND', message: `Agent '${req.params.agentId}' is not registered` } });
    res.json(entry.card);
  });

  // ── Gateway-mediated A2A ────────────────────────────────────────────
  r.post('/a2a/:targetAgentId', asyncHandler(router.handle));

  // ── Dashboard (read-only, unauthenticated: local-dev convenience; protect in real deployments) ──
  r.get('/api/state', (req, res) => {
    res.json({
      service: 'a2a-gateway',
      now: nowIso(),
      startedAt,
      stats,
      agents: registry.list().map((e) => ({ ...summarizeEntry(e), card: e.card })),
      policy: policy.describe(),
      auth: auth.describe(),
      tasks: tasks.list(30),
      routes: routeLog.list(60),
      audit: audit.list({ limit: 120 }),
      rateLimitEvents: rateLimitEvents.list(40),
    });
  });
  r.get('/api/audit', (req, res) => {
    res.json({ events: audit.list({ limit: Number(req.query.limit) || 100, agentId: req.query.agent, type: req.query.type }) });
  });
  r.post('/api/logs/clear', (req, res) => {
    audit.clear(); routeLog.clear(); rateLimitEvents.clear(); tasks.clear();
    for (const k of Object.keys(stats)) stats[k] = 0;
    res.json({ cleared: true });
  });

  return r;
}
