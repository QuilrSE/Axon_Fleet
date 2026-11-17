// Test double for the Bifrost Agent Gateway, written from Bifrost's public docs
// (docs.getbifrost.ai/features/agent-gateway/*). It is NOT Bifrost; it reproduces the behaviour the
// agents depend on so the integration can be tested without a container:
//   - POST/PUT/DELETE /api/agents (management auth via X-Bifrost-Setup-Token), strict A2A v1 card check
//   - GET  /agents/a2a/{name}/.well-known/agent-card.json  (virtual key; card fetched live and rewritten)
//   - POST /agents/a2a/{name}/json-rpc                       (virtual key; A2A v1 methods only)
//   - POST /agents/a2a/{name}/push/callback                  (relays agent pushes to the client's webhook)
import express from 'express';
import { fetchJson, listen, closeServer, v1Interfaces, newId, rpcError } from '@axon-fleet/shared';

export const STRICT_ERROR = 'Upstream agent card has no strict A2A v1 interface the gateway can proxy (JSON-RPC, HTTP+JSON, or gRPC)';

/** Mirrors encoding/json decoding in a2a-go < v2.6.0: scheme scopes must be JSON arrays. */
export function goSdkCardError(card) {
  const reqs = [['', card.securityRequirements], ...(card.skills ?? []).map((s, i) => [`skills[${i}].`, s.securityRequirements])];
  for (const [prefix, list] of reqs) {
    for (const [i, r] of (list ?? []).entries()) {
      for (const [name, v] of Object.entries(r?.schemes ?? {})) {
        if (!Array.isArray(v)) return `Parse upstream agent card: json: cannot unmarshal object into Go struct field ${prefix ? `${prefix}` : ''}.${i}.schemes.${name} of type a2a.SecuritySchemeScopes`;
      }
    }
  }
  return null;
}

export function createBifrostMock({ setupToken = 'setup-123', virtualKeys = ['sk-bf-test'], admin = 'admin:admin-pw', apiKeys = ['mk-test'], dashboardAuth = false } = {}) {
  const agents = new Map();
  const callbacks = new Map(); // bifrost token -> { client config, name }
  const log = [];
  let base = null;
  const app = express();
  app.use(express.json({ type: ['application/json', 'application/a2a+json'] }));

  const vkOk = (req) => virtualKeys.includes(req.get('x-bf-vk') ?? (req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  // Management auth per Bifrost docs: setup token only while dashboard auth is off; otherwise
  // Basic admin user:pass, or Bearer <management API key | base64(user:pass)>. Virtual keys are refused.
  const mgmtAuth = (req) => {
    const st = req.get('x-bifrost-setup-token');
    const authz = req.get('authorization') ?? '';
    const b64 = Buffer.from(admin).toString('base64');
    if (!dashboardAuth && st !== undefined) return st === setupToken ? 200 : 403;
    if (authz === `Basic ${b64}` || authz === `Bearer ${b64}`) return 200;
    if (apiKeys.some((k) => authz === `Bearer ${k}`)) return 200;
    return 401;
  };
  const mgmtOk = (req) => mgmtAuth(req) === 200;
  const fail = (res, status, message) => res.status(status).json({ is_bifrost_error: true, status_code: status, error: { message } });

  async function fetchStrictCard(url) {
    const r = await fetchJson(url);
    if (!r.ok) return { error: `Could not fetch agent card: ${r.data?.error?.message ?? `HTTP ${r.status}`}` };
    const parseErr = goSdkCardError(r.data);
    if (parseErr) return { error: parseErr };
    if (!v1Interfaces(r.data).length) return { error: STRICT_ERROR };
    return { card: r.data };
  }

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  const upsert = (replace) => async (req, res) => {
    const code = mgmtAuth(req);
    if (code !== 200) return fail(res, code, code === 403 ? 'invalid setup token' : 'management authentication required');
    const b = req.body ?? {};
    const name = replace ? req.params.name : b.name;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '')) return fail(res, 400, 'invalid name');
    if (!replace && agents.has(name)) return fail(res, 400, `agent registration with name "${name}" already exists`);
    const { error } = await fetchStrictCard(b.agent_card_url);
    if (error) return fail(res, 400, error);
    agents.set(name, { name, cardUrl: b.agent_card_url, runtimeHeaders: b.runtime_auth?.type === 'headers' ? b.runtime_auth.headers : {}, allowByDefault: b.allow_by_default });
    log.push({ op: replace ? 'replace' : 'register', name });
    res.status(replace ? 200 : 201).json({ name, agent_card_url: b.agent_card_url, enabled: true });
  };
  app.post('/api/agents', upsert(false));
  app.put('/api/agents/:name', upsert(true));
  app.get('/api/agents/:name', (req, res) => {
    const code = mgmtAuth(req);
    if (code !== 200) return fail(res, code, 'management authentication required');
    const a = agents.get(req.params.name);
    log.push({ op: 'get', name: req.params.name });
    return a ? res.json({ name: a.name, agent_card_url: a.cardUrl, enabled: true }) : fail(res, 404, 'agent not found');
  });
  app.delete('/api/agents/:name', (req, res) => { if (!mgmtOk(req)) return fail(res, 401, 'management authentication required'); agents.delete(req.params.name); res.json({}); });

  app.get('/agents/a2a/:name/.well-known/agent-card.json', async (req, res) => {
    if (!vkOk(req)) return fail(res, 401, 'virtual key required');
    const a = agents.get(req.params.name);
    if (!a) return fail(res, 404, 'agent not found');
    const { card, error } = await fetchStrictCard(a.cardUrl);
    if (error) return fail(res, 502, error);
    res.json({ ...card, supportedInterfaces: [{ url: `${base}/agents/a2a/${a.name}/json-rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], securitySchemes: { vk: { apiKeySecurityScheme: { location: 'header', name: 'x-bf-vk' } } }, securityRequirements: [{ schemes: { vk: { list: [] } } }] });
  });

  app.post('/agents/a2a/:name/json-rpc', async (req, res) => {
    if (!vkOk(req)) return fail(res, 401, 'virtual key required');
    const a = agents.get(req.params.name);
    if (!a) return fail(res, 404, 'agent not found');
    const v = req.get('a2a-version');
    if (v && !/^1(\.\d+)?$/.test(v)) return res.json(rpcError(req.body?.id, -32009, `A2A-Version ${v} not supported`));
    const body = structuredClone(req.body);
    if (!/^[A-Z]/.test(body?.method ?? '')) return res.json(rpcError(body?.id, -32601, `Method not found: ${body?.method}`));
    const { card, error } = await fetchStrictCard(a.cardUrl);
    if (error) return fail(res, 502, error);
    const upstream = v1Interfaces(card).find((i) => i.protocolBinding === 'JSONRPC').url;
    const clientCfg = body.params?.configuration?.taskPushNotificationConfig;
    let bfToken = null;
    if (clientCfg) {
      bfToken = newId('bfcb');
      callbacks.set(bfToken, { client: clientCfg, name: a.name });
      body.params.configuration.taskPushNotificationConfig = { url: `${base}/agents/a2a/${a.name}/push/callback`, token: bfToken, authentication: { scheme: 'Bearer', credentials: bfToken } };
    }
    log.push({ op: 'rpc', name: a.name, method: body.method, upstream, headers: { ...req.headers } });
    const r = await fetchJson(upstream, { method: 'POST', headers: { ...a.runtimeHeaders, 'a2a-version': '1.0' }, body, timeoutMs: 30000 });
    res.status(r.status || 502).json(r.data);
  });

  app.post('/agents/a2a/:name/push/callback', async (req, res) => {
    const token = req.get('x-a2a-notification-token') ?? (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const cb = callbacks.get(token);
    if (!cb) return fail(res, 401, 'unknown callback token');
    const c = cb.client;
    const headers = { 'content-type': 'application/a2a+json' };
    if (c.authentication) headers.authorization = `${c.authentication.scheme} ${c.authentication.credentials}`;
    if (c.token) headers['x-a2a-notification-token'] = c.token;
    const r = await fetchJson(c.url, { method: 'POST', headers, body: req.body });
    log.push({ op: 'push_relay', name: cb.name, status: r.status });
    res.status(r.ok ? 200 : 502).json({ delivered: r.ok });
  });

  let server;
  return {
    agents, log,
    async start() { server = await listen(app, 0, '127.0.0.1'); base = `http://127.0.0.1:${server.address().port}`; return base; },
    async stop() { await closeServer(server); },
    /** Register by hand, as a person would in Agents → Agent Catalog. */
    async manualRegister(name, cardUrl, authorization) {
      const { error } = await fetchStrictCard(cardUrl);
      if (error) throw new Error(error);
      agents.set(name, { name, cardUrl, runtimeHeaders: { Authorization: authorization } });
    },
  };
}
