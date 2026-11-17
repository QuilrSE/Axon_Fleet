// Test double for the QuilrAI A2A Gateway, written from docs.quilrai.dev/a2a-gateway/get-started/a2a-gateway.
// It is NOT Quilr. It reproduces the documented contract the agents depend on:
//   caller keys (Authorization: Bearer sk-quilr-a2a-… or X-Quilr-A2A-Key), grants (agent, methods, skills),
//   skill-routed agents (message.metadata.skill_id, inference when one skill is granted),
//   gateway-issued task/context IDs with owner-only access, outbound auth added by the gateway (the caller key
//   is never forwarded), X-Quilr-A2A-Chain + baggage, push relay with rewritten IDs and in-order delivery,
//   -32003 when push is off, HTTPS-only webhooks/agents (switchable for local tests), served cards rewritten
//   to the gateway, catalog filtered by grants, -31xxx errors with quilr_error_code + request_id, and
//   X-Quilr-Request-Id on every response.
import express from 'express';
import { fetchJson, listen, closeServer, v1Interfaces, newId, cardEndpoint } from '@axon-fleet/shared';

const ERR = {
  a2a_unauthenticated: [-31401, 401], a2a_forbidden: [-31403, 403], a2a_agent_not_found: [-31404, 404],
  a2a_card_unapproved: [-31409, 409], a2a_upstream_error: [-31502, 502],
};

export function createQuilrMock({ org = 'tadc5ab68a5195659', callers = {}, pushEnabled = true, requireHttps = false } = {}) {
  const agents = new Map();       // slug -> { slug, cardUrl, card, outbound, skillRouted }
  const tasks = new Map();        // gateway task id -> { upstreamId, contextId, upstreamContext, owner, slug }
  const relays = new Map();       // relay id -> { token, client, owner, slug, queue }
  const log = [];
  let origin = null;
  const app = express();
  app.use(express.json({ type: ['application/json', 'application/a2a+json'] }));
  app.use((req, res, next) => { res.set('X-Quilr-Request-Id', newId('qreq')); next(); });

  const keyOf = (req) => req.get('x-quilr-a2a-key') ?? (/^Bearer\s+(sk-quilr-a2a-\S+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? null);
  const httpErr = (res, code, message) => {
    const [, status] = ERR[code];
    return res.status(status).json({ error: { code: status, status: code === 'a2a_unauthenticated' ? 'UNAUTHENTICATED' : code.toUpperCase(), message, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code.toUpperCase(), domain: 'quilr.ai', metadata: { quilr_error_code: code, request_id: res.get('X-Quilr-Request-Id') } }] } });
  };
  const rpcErr = (res, id, code, message, extra = {}) => {
    const [num, status] = ERR[code] ?? [code, 200];
    return res.status(typeof code === 'number' ? 200 : status).json({ jsonrpc: '2.0', id: id ?? null, error: { code: typeof code === 'number' ? code : num, message, data: { quilr_error_code: typeof code === 'number' ? undefined : code, request_id: res.get('X-Quilr-Request-Id'), ...extra } } });
  };
  const caller = (req) => { const k = keyOf(req); return k ? callers[k] ?? null : undefined; };
  const grantFor = (c, slug) => c?.grants?.[slug] ?? null;
  const base = () => `${origin}/a2a/${org}`;
  const servedCard = (a, grant) => ({
    ...a.card,
    supportedInterfaces: [{ url: `${base()}/${a.slug}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    securitySchemes: { quilr_key: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'Quilr A2A caller key' } } },
    securityRequirements: [{ schemes: { quilr_key: [] } }],
    skills: a.card.skills.filter((s) => grant.skills === '*' || grant.skills.includes(s.id)),
    url: undefined, preferredTransport: undefined, additionalInterfaces: undefined, protocolVersion: undefined,
  });
  const outboundHeaders = (a) => (a.outbound?.type === 'bearer' ? { Authorization: `Bearer ${a.outbound.token}` } : a.outbound?.type === 'header' ? { [a.outbound.name]: a.outbound.value } : {});

  function authed(req, res, next) {
    const c = caller(req);
    if (c === undefined) return req.method === 'POST' ? rpcErr(res, req.body?.id, 'a2a_unauthenticated', 'missing A2A caller key') : httpErr(res, 'a2a_unauthenticated', 'missing A2A caller key');
    if (c === null) return req.method === 'POST' ? rpcErr(res, req.body?.id, 'a2a_unauthenticated', 'invalid A2A caller key') : httpErr(res, 'a2a_unauthenticated', 'invalid A2A caller key');
    req.caller = c;
    next();
  }

  app.get(`/a2a/${org}/catalog`, authed, (req, res) => {
    const list = [...agents.values()].filter((a) => grantFor(req.caller, a.slug)).map((a) => ({ slug: a.slug, name: a.card.name, description: a.card.description, card_url: `${base()}/${a.slug}/.well-known/agent-card.json`, skills: servedCard(a, grantFor(req.caller, a.slug)).skills.map((s) => ({ id: s.id, name: s.name })) }));
    res.json({ agents: list });
  });

  app.get(`/a2a/${org}/:slug/.well-known/agent-card.json`, authed, (req, res) => {
    const a = agents.get(req.params.slug);
    const g = grantFor(req.caller, req.params.slug);
    if (!a || !g) return httpErr(res, 'a2a_agent_not_found', `agent ${req.params.slug} not found`);
    res.json(servedCard(a, g));
  });

  // Relay that agents post push updates to (path is internal to the gateway).
  app.post(`/a2a/${org}/_relay/:relay`, async (req, res) => {
    const r = relays.get(req.params.relay);
    const tok = req.get('x-a2a-notification-token') ?? (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!r || tok !== r.token) return res.status(401).json({ error: 'bad relay credentials' });
    const body = structuredClone(req.body ?? {});
    const upstreamTask = body.task?.id ?? body.statusUpdate?.taskId ?? body.artifactUpdate?.taskId;
    const gid = [...tasks.entries()].find(([, t]) => t.upstreamId === upstreamTask && t.slug === r.slug)?.[0];
    if (!gid) return res.status(404).json({ error: 'unknown task' });
    const t = tasks.get(gid);
    if (body.task) { body.task.id = gid; body.task.contextId = t.contextId; }
    if (body.statusUpdate) { body.statusUpdate.taskId = gid; body.statusUpdate.contextId = t.contextId; }
    if (body.artifactUpdate) { body.artifactUpdate.taskId = gid; body.artifactUpdate.contextId = t.contextId; }
    // Stored, acknowledged, then delivered in order to the caller's webhook with the caller's token.
    r.queue = r.queue.then(async () => {
      const c = r.client;
      const headers = { 'content-type': 'application/a2a+json' };
      if (c.authentication?.scheme) headers.authorization = `${c.authentication.scheme} ${c.authentication.credentials ?? ''}`.trim();
      if (c.token) headers['x-a2a-notification-token'] = c.token;
      const d = await fetchJson(c.url, { method: 'POST', headers, body });
      log.push({ op: 'push_relay', slug: r.slug, status: d.status, kind: body.task ? 'task' : 'statusUpdate' });
    });
    res.json({ ok: true });
  });

  app.post(`/a2a/${org}/:slug`, authed, async (req, res) => {
    const body = structuredClone(req.body ?? {});
    const { id, method } = body;
    const p = body.params ?? {};
    const a = agents.get(req.params.slug);
    const g = grantFor(req.caller, req.params.slug);
    if (!a || !g) return rpcErr(res, id, 'a2a_agent_not_found', `agent ${req.params.slug} not found`);
    const v = req.get('a2a-version');
    if (!/^[A-Z]/.test(method ?? '') || (v && !/^1(\.\d+)?$/.test(v))) return rpcErr(res, id, -32009, 'emulator speaks A2A 1.0 JSON-RPC only');
    if (g.methods !== '*' && !g.methods.includes(method)) return rpcErr(res, id, 'a2a_forbidden', `method ${method} not granted`, { reason: 'method_not_granted' });
    const upstream = cardEndpoint(a.card);
    const fwdHeaders = { ...outboundHeaders(a), 'A2A-Version': '1.0', 'X-Quilr-A2A-Chain': `chain.${Buffer.from(JSON.stringify({ hop: 1, caller: req.caller.id })).toString('base64url')}.sig`, baggage: `quilr.request_id=${res.get('X-Quilr-Request-Id')}` };
    const own = (gid) => { const t = tasks.get(gid); return t && t.owner === req.caller.id && t.slug === a.slug ? t : null; };
    const remap = (task, gid) => (task ? { ...task, id: gid, contextId: tasks.get(gid).contextId } : task);

    if (method === 'SendMessage') {
      const msg = p.message ?? {};
      if (msg.contextId || msg.taskId) {
        const known = [...tasks.values()].some((t) => t.owner === req.caller.id && (t.contextId === msg.contextId || tasks.get(msg.taskId)));
        if (!known) return rpcErr(res, id, -32602, 'unknown contextId/taskId: the gateway issues task and context IDs');
      }
      const granted = g.skills === '*' ? a.card.skills.map((s) => s.id) : g.skills;
      let skill = msg.metadata?.skill_id;
      if (a.skillRouted) {
        if (!skill) {
          if (granted.length === 1) skill = granted[0];
          else return rpcErr(res, id, 'a2a_forbidden', 'skill required', { reason: 'skill_required' });
        }
        if (!a.card.skills.some((s) => s.id === skill)) return rpcErr(res, id, 'a2a_forbidden', `skill ${skill} unknown`, { reason: 'skill_unknown' });
        if (!granted.includes(skill)) return rpcErr(res, id, 'a2a_forbidden', `skill ${skill} not granted`, { reason: 'skill_not_granted' });
        msg.metadata = { ...(msg.metadata ?? {}), skill_id: skill };
      }
      const clientPush = p.configuration?.taskPushNotificationConfig;
      let relay = null;
      if (clientPush) {
        if (!pushEnabled) return rpcErr(res, id, -32003, 'push notifications are not enabled for this organization');
        if (requireHttps && !/^https:\/\//.test(clientPush.url ?? '')) return rpcErr(res, id, -32602, 'webhook must be HTTPS on a public address');
        relay = { id: newId('rly'), token: newId('rtok'), client: clientPush, owner: req.caller.id, slug: a.slug, queue: Promise.resolve() };
        relays.set(relay.id, relay);
        p.configuration.taskPushNotificationConfig = { url: `${base()}/_relay/${relay.id}`, token: relay.token, authentication: { scheme: 'Bearer', credentials: relay.token } };
      }
      log.push({ op: 'forward', slug: a.slug, method, skill, upstream, headers: fwdHeaders, sentContextId: msg.contextId ?? null, callerKeyForwarded: JSON.stringify(fwdHeaders).includes('sk-quilr-a2a') });
      const up = await fetchJson(upstream, { method: 'POST', headers: fwdHeaders, body: { ...body, params: { ...p, message: msg } }, timeoutMs: 30000 });
      if (up.status === 0 || up.status >= 500) return rpcErr(res, id, 'a2a_upstream_error', up.data?.error?.message ?? `upstream HTTP ${up.status}`);
      if (up.status === 401 || up.status === 403) return rpcErr(res, id, 'a2a_upstream_error', `agent refused the gateway's outbound auth (HTTP ${up.status})`);
      const ut = up.data?.result?.task;
      if (!ut) return res.json(up.data);
      const gid = newId('qt');
      tasks.set(gid, { upstreamId: ut.id, upstreamContext: ut.contextId, contextId: newId('qc'), owner: req.caller.id, slug: a.slug });
      return res.json({ ...up.data, result: { task: remap(ut, gid) } });
    }
    if (['GetTask', 'CancelTask'].includes(method)) {
      const t = own(p.id);
      if (!t) return rpcErr(res, id, -32001, 'Task not found');
      log.push({ op: 'forward', slug: a.slug, method, upstream, headers: fwdHeaders });
      const up = await fetchJson(upstream, { method: 'POST', headers: fwdHeaders, body: { ...body, params: { ...p, id: t.upstreamId } } });
      if (up.data?.result) return res.json({ ...up.data, result: remap(up.data.result, p.id) });
      return res.json(up.data);
    }
    if (method === 'ListTasks') {
      const mine = [...tasks.entries()].filter(([, t]) => t.owner === req.caller.id && t.slug === a.slug).map(([gid]) => ({ id: gid }));
      return res.json({ jsonrpc: '2.0', id, result: { tasks: mine, nextPageToken: '', pageSize: 100, totalSize: mine.length } });
    }
    return rpcErr(res, id, -32004, `${method} not supported by the emulator`);
  });

  let server;
  return {
    agents, tasks, log, org,
    get base() { return base(); },
    async start() { server = await listen(app, 0, '127.0.0.1'); origin = `http://127.0.0.1:${server.address().port}`; return base(); },
    async stop() { await closeServer(server); },
    /** Admin registration (Quilr console → Agents → Card URL). */
    async registerAgent({ slug, cardUrl, outbound, skillRouted = false }) {
      if (requireHttps && !/^https:\/\//.test(cardUrl)) throw new Error('agent card URL must be HTTPS on a public address');
      const r = await fetchJson(cardUrl);
      if (!r.ok) throw new Error(`could not fetch card: HTTP ${r.status}`);
      if (!v1Interfaces(r.data).length && !r.data.url) throw new Error('card has no A2A 1.0 or 0.3 interface');
      agents.set(slug, { slug, cardUrl, card: r.data, outbound, skillRouted });
    },
  };
}
