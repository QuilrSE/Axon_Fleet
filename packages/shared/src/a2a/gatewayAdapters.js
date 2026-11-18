// Gateway adapters: one interface over any A2A gateway / agent registry.
//
//   health()                           → is the gateway up?
//   register({ agentId, card, agentCardUrl })
//   deregister(agentId)
//   discover({ skill, tag })           → { ok, status, agents: [{ agentId, name, url, card, health }] }
//   invoke(targetAgentId, rpc, opts)   → forward an A2A JSON-RPC request through the gateway
//
// Gateways differ in paths, auth headers and payload shapes, so a profile carries a small,
// declarative mapping. "poc-gateway" is this repo's gateway; "generic" fits most third-party
// registries/gateways that speak JSON over HTTP. For gateways that need more than a mapping
// (signed requests, OAuth token exchange, gRPC), add a new kind in ADAPTER_FACTORIES.
import crypto from 'node:crypto';
import { fetchJson } from '../utils/http.js';
import { resolveSecret, outboundAuth, outboundHeaders, managementHeaders, inboundAuth } from './gatewayHeaders.js';
import { createEnvelope, toJsonRpc } from './message.js';
import { WM_KEY_HEADER, WM_REQUEST_ID_HEADER, WM_ERROR_CODE_FIELD } from './whitematterProtocol.js';

/** fetchJson + a hook that records exactly what was sent (for "equivalent curl"). */
function makeSender(onRequest) {
  return async (op, url, init = {}) => {
    const res = await fetchJson(url, init);
    try { onRequest?.({ op, at: new Date().toISOString(), method: (init.method ?? 'GET').toUpperCase(), url, headers: { ...(init.headers ?? {}) }, body: init.body, status: res.status, ms: res.ms, error: res.ok ? null : res.data?.error?.message ?? null }); } catch { /* recording must never break a call */ }
    return res;
  };
}

export const GATEWAY_KINDS = Object.freeze({
  'poc-gateway': 'PoC A2A Gateway (this repository)',
  bifrost: 'Dummy A2A Gateway',
  whitematter: 'Whitematter A2A Gateway',
  generic: 'Third-party A2A gateway (configurable mapping)',
});
export const PROTOCOLS = Object.freeze({ poc: 'PoC JSON-RPC (A2A v0.3 method names)', 'a2a-v1': 'A2A v1.0 (SendMessage, GetTask, …)' });
export const MANAGEMENT_AUTH = Object.freeze({
  basic: 'Admin username:password (OSS with dashboard login; local admin)',
  bearer: 'Management API key (Enterprise) or session token',
  'setup-token': 'Setup token (OSS without dashboard login; cannot register private addresses)',
  header: 'Custom header name + value',
  none: 'Manual registration (agent only verifies it is listed)',
});

export const AUTH_SCHEMES = Object.freeze(['bearer', 'api-key', 'none']);
export const REGISTER_BODIES = Object.freeze({
  envelope: '{ agentId, agentCardUrl, card }',
  card: 'Agent Card JSON as the body',
  cardUrl: '{ agentId, agentCardUrl } (gateway fetches the card)',
});

export const CONTROL_DEFS = Object.freeze([
  { key: 'authentication', name: 'Gateway authentication (credential → agent identity)', short: 'authn' },
  { key: 'allowlist', name: 'Agent ID allowlist', short: 'allowlist' },
  { key: 'skill_authorization', name: 'Skill-level authorization', short: 'skill authz' },
  { key: 'sender_binding', name: 'Sender identity binding (anti-spoofing)', short: 'identity' },
  { key: 'request_validation', name: 'Centralized request validation', short: 'validate' },
  { key: 'rate_limiting', name: 'Rate limiting', short: 'rate limit' },
  { key: 'audit', name: 'Central audit logging', short: 'audit' },
  { key: 'tracing', name: 'Request tracing (gateway request IDs)', short: 'trace' },
  { key: 'policy_routing', name: 'Centralized policy & routing', short: 'policy' },
]);
export const CONTROL_KEYS = CONTROL_DEFS.map((c) => c.key);

/** Defaults applied per kind; anything the profile sets wins. */
export const KIND_DEFAULTS = Object.freeze({
  'poc-gateway': {
    authScheme: 'bearer', authHeader: 'authorization', callerHeader: 'x-a2a-caller',
    registerMethod: 'POST', registerPath: '/registry/agents', registerBody: 'envelope',
    deregisterPath: '/registry/agents/{agentId}', discoverPath: '/registry/agents?skill={skill}',
    invokePath: '/a2a/{agentId}', healthPath: '/health', resultsPath: 'agents', agentIdField: 'agentId',
    declaredControls: CONTROL_KEYS,
  },
  generic: {
    authScheme: 'bearer', authHeader: 'authorization', callerHeader: 'x-a2a-caller',
    registerMethod: 'POST', registerPath: '/agents', registerBody: 'envelope',
    deregisterPath: '', discoverPath: '/agents?skill={skill}',
    invokePath: '/agents/{agentId}/a2a', healthPath: '/health', resultsPath: '', agentIdField: '',
    declaredControls: ['authentication'],
  },
  whitematter: {
    authScheme: 'bearer', authHeader: WM_KEY_HEADER, callerHeader: '', protocol: 'a2a-v1',
    registerMethod: 'GET', registerPath: '', registerBody: 'cardUrl', deregisterPath: '',
    discoverPath: '/catalog', invokePath: '/{agentName}', healthPath: '/catalog', resultsPath: '', agentIdField: '',
    agentNames: '', inboundHeaderName: 'Authorization', registerEnabled: false, pushMode: 'auto',
    declaredControls: ['authentication', 'allowlist', 'skill_authorization', 'rate_limiting', 'audit', 'tracing', 'policy_routing', 'request_validation'],
  },
  bifrost: {
    authScheme: 'api-key', authHeader: 'x-bf-vk', callerHeader: '', protocol: 'a2a-v1',
    registerMethod: 'POST', registerPath: '/api/agents', registerBody: 'bifrost',
    deregisterPath: '/api/agents/{agentName}', discoverPath: '/agents/a2a/{agentName}/.well-known/agent-card.json',
    invokePath: '/agents/a2a/{agentName}/json-rpc', healthPath: '/health', resultsPath: '', agentIdField: '',
    managementAuthScheme: 'basic', allowByDefault: true, agentNames: '',
    declaredControls: ['authentication', 'allowlist', 'audit', 'tracing', 'policy_routing'],
  },
});

export { resolveSecret };

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
const join = (base, path) => `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
const pick = (obj, path) => (path ? path.split('.').reduce((o, k) => o?.[k], obj) : undefined);
/** Drop "?skill=" style params left empty after templating. */
const tidyQuery = (url) => url.replace(/([?&])[\w-]+=(?=&|$)/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');

export function withKindDefaults(profile) {
  const defaults = KIND_DEFAULTS[profile.kind] ?? KIND_DEFAULTS.generic;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(profile)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/** Legacy helper: the agent → gateway auth header for a profile and a secret value. */
export function authHeaders(p, secret) {
  const a = outboundAuth(p, secret);
  return a ? { [a.name.toLowerCase()]: a.value } : {};
}

function normalizeAgents(data, p) {
  let list = Array.isArray(data) ? data : pick(data, p.resultsPath);
  if (!Array.isArray(list)) list = data?.agents ?? data?.items ?? data?.results ?? data?.data ?? [];
  return list.map((item) => {
    const card = item.card ?? (item.skills && item.url ? item : null);
    return {
      agentId: (p.agentIdField && item[p.agentIdField]) ?? item.agentId ?? item.id ?? item.name,
      name: item.name ?? card?.name ?? null,
      url: item.url ?? card?.url ?? null,
      provider: item.provider ?? card?.provider?.organization ?? null,
      agentCardUrl: item.agentCardUrl ?? null,
      health: { status: item.health?.status ?? item.status ?? 'unknown' },
      card,
    };
  }).filter((a) => a.agentId);
}

/** "agent-b=dealership,agent-a=vehicle" → { 'agent-b': 'dealership', … }; unmapped IDs use the agent ID. */
export function parseAgentNames(str = '') {
  const out = {};
  for (const pair of String(str).split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, name] = pair.split(/[=:]/).map((x) => x.trim());
    if (id && name) out[id] = name;
  }
  return out;
}

export function createGatewayAdapter(profile, opts = {}) {
  if (profile.kind === 'bifrost') return createBifrostAdapter(profile, opts);
  if (profile.kind === 'whitematter') return createWhitematterAdapter(profile, opts);
  return createGenericAdapter(profile, opts);
}

function createGenericAdapter(profile, { timeoutMs = 4000, onRequest } = {}) {
  const p = withKindDefaults(profile);
  const v1 = p.protocol === 'a2a-v1';
  const tls = { tlsSkipVerify: !!p.tlsSkipVerify };
  const send = makeSender(onRequest);
  const headers = (override) => outboundHeaders(p, override);

  return {
    profile: p,
    protocol: v1 ? 'a2a-v1' : 'poc',
    invokeUrl: (agentId) => join(p.url, fill(p.invokePath, { agentId })),
    health: () => send('health', join(p.url, p.healthPath), { timeoutMs: 2500, ...tls }),

    register({ agentId, card, agentCardUrl }) {
      const body = p.registerBody === 'card' ? card : p.registerBody === 'cardUrl' ? { agentId, agentCardUrl } : { agentId, agentCardUrl, card };
      return send('register', join(p.url, fill(p.registerPath, { agentId })), { method: p.registerMethod, headers: headers(), body, timeoutMs, ...tls });
    },

    async deregister(agentId) {
      if (!p.deregisterPath) return { ok: true, status: 204, data: { skipped: 'no deregisterPath configured' } };
      return send('deregister', join(p.url, fill(p.deregisterPath, { agentId })), { method: 'DELETE', headers: headers(), timeoutMs, ...tls });
    },

    async discover({ skill, tag } = {}) {
      const url = tidyQuery(join(p.url, fill(p.discoverPath, { skill, tag })));
      const res = await send('discover', url, { headers: headers(), timeoutMs, ...tls });
      return { ...res, url, agents: res.ok ? normalizeAgents(res.data, p) : [] };
    },

    async invoke(targetAgentId, rpc, { credentialOverride } = {}) {
      const url = join(p.url, fill(p.invokePath, { agentId: targetAgentId }));
      const res = await send('invoke', url, {
        method: 'POST',
        headers: { ...headers(credentialOverride), ...(v1 ? { 'a2a-version': '1.0' } : {}), 'x-a2a-route': 'gateway', ...(rpc?.params?.metadata?.envelope?.correlation_id ? { 'x-correlation-id': rpc.params.metadata.envelope.correlation_id } : {}) },
        body: rpc,
        timeoutMs: 8000,
        ...tls,
      });
      return { ...res, route: 'gateway', url, gateway: { id: p.id, name: p.name } };
    },
  };
}

// ── Bifrost Agent Gateway ─────────────────────────────────────────────────────────────
// Docs: docs.getbifrost.ai/features/agent-gateway. Callers use a virtual key (x-bf-vk);
// registration uses management auth on POST /api/agents (or is done by hand in Agents → Agent Catalog).
// Bifrost fetches the agent's card, keeps only A2A v1 interfaces, and serves a rewritten card at
// /agents/a2a/{name}/.well-known/agent-card.json. Calls go to /agents/a2a/{name}/json-rpc.

const bifrostError = (res) => {
  const d = res.data ?? {};
  return d.error?.message ?? d.message ?? (typeof d.error === 'string' ? d.error : null) ?? (d.raw ? String(d.raw).slice(0, 200) : `HTTP ${res.status}`);
};

// Last registration body sent per Bifrost URL + agent name (hashed). Heartbeats with an unchanged body
// only check that the registration still exists instead of re-sending it.
const lastRegistered = new Map();
const digest = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

function managementHint(p, res) {
  const msg = bifrostError(res);
  const scheme = p.managementAuthScheme;
  if (res.status === 401) {
    if (scheme === 'setup-token') return `Bifrost did not accept the setup token (HTTP 401). If dashboard login is enabled, the setup token no longer works; use "Admin username:password" or a management API key instead. Bifrost said: ${msg}`;
    if (scheme === 'basic') return `Bifrost did not accept the admin credentials (HTTP 401). The management credential must be "username:password" for the Bifrost admin account. Bifrost said: ${msg}`;
    return `Bifrost did not accept the management token (HTTP 401): it is wrong, revoked, or a virtual key (sk-bf-…), which management APIs refuse. Bifrost said: ${msg}`;
  }
  if (res.status === 403) {
    if (scheme === 'setup-token') return `Bifrost refused the setup token (HTTP 403): it does not match setup_token / BIFROST_SETUP_TOKEN on the Bifrost server. Bifrost said: ${msg}`;
    return `Authenticated, but not permitted (HTTP 403). A management API key needs the scopes AgentGateway:Create, AgentGateway:Update and AgentGateway:View (Settings → API Keys). Bifrost said: ${msg}`;
  }
  if (/private|allowlist|blocked|not permitted|forbidden destination/i.test(msg)) return `Bifrost blocked the agent's address: ${msg}. Add the host (for example host.docker.internal) to Agents → Agent Settings → Private Network Allowlist; private destinations need dashboard authentication, so register with admin credentials or an API key, not the setup token.`;
  return msg;
}

function createBifrostAdapter(profile, { timeoutMs = 6000, onRequest } = {}) {
  const p = withKindDefaults(profile);
  const tls = { tlsSkipVerify: !!p.tlsSkipVerify };
  const send = makeSender(onRequest);
  const names = parseAgentNames(p.agentNames);
  const nameOf = (agentId) => names[agentId] ?? agentId;
  const idOf = (name) => Object.entries(names).find(([, n]) => n === name)?.[0] ?? name;
  const vkHeaders = (override) => outboundHeaders(p, override);
  const servedCardUrl = (agentId) => join(p.url, fill(p.discoverPath, { agentName: nameOf(agentId) }));

  /** Explain why no virtual key is being sent, or null if one is. */
  function missingKey() {
    if (p.authScheme === 'none' || resolveSecret(p.credential)) return null;
    return String(p.credential ?? '').startsWith('env:')
      ? `${p.credential.slice(4)} is not set in the environment that runs this agent, so no virtual key was sent. Export it in the shell that runs npm start (or add it to .env) and restart, or paste the key into this gateway's "Bifrost virtual key" field.`
      : 'No virtual key is configured on this gateway.';
  }

  async function verifyListed(agentId) {
    const url = servedCardUrl(agentId);
    const res = await send('verify', url, { headers: vkHeaders(), timeoutMs, ...tls });
    if (res.ok) return { ...res, data: { listed: true, mode: 'verified', servedCardUrl: url } };
    let hint = bifrostError(res);
    if (res.status === 404) hint = `"${nameOf(agentId)}" is not in Bifrost's Agent Catalog. Register it there (or set management auth on this gateway so the agent registers itself).`;
    if (res.status === 503) hint = 'Bifrost Agent Gateway endpoints are disabled: set Agents → Agent Settings → External Client URL.';
    if (res.status === 401) hint = missingKey() ?? `Bifrost did not accept the virtual key (HTTP 401): it is mistyped, disabled, expired, or from a different Bifrost instance. Check it in Bifrost → Virtual Keys. Bifrost said: ${bifrostError(res)}`;
    if (res.status === 403) hint = `Bifrost accepted the virtual key but it may not call "${nameOf(agentId)}" (HTTP 403). Grant the key on that agent's registration, or turn on "Allow any virtual key".`;
    return { ok: false, status: res.status, data: { error: { message: hint } } };
  }

  return {
    profile: p,
    protocol: 'a2a-v1',
    nameOf,
    servedCardUrl,
    registrationMode: () => (managementHeaders(p) ? 'management-api' : 'manual'),
    missingKey,
    invokeUrl: (agentId) => join(p.url, fill(p.invokePath, { agentName: nameOf(agentId) })),
    health: () => send('health', join(p.url, p.healthPath), { timeoutMs: 2500, ...tls }),

    /**
     * Self-register through the management API when credentials exist; otherwise verify a manual registration.
     * Sends POST /api/agents (falling back to PUT when the name exists) only when the registration body
     * changed or `force` is set; otherwise checks GET /api/agents/{name} and re-creates it if it was deleted.
     */
    async register({ agentId, agentCardUrl }, { force = false } = {}) {
      const mgmt = managementHeaders(p);
      if (!mgmt) return verifyListed(agentId);
      const inbound = inboundAuth(p);
      const vkIds = String(p.virtualKeyIds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const body = {
        name: nameOf(agentId),
        agent_card_url: agentCardUrl,
        enabled: true,
        allow_by_default: p.allowByDefault !== false,
        runtime_auth: inbound ? { type: 'headers', headers: { [inbound.name]: inbound.value } } : { type: 'none' },
        ...(vkIds.length ? { virtual_key_ids: vkIds } : {}),
      };
      const key = `${p.url}|${body.name}`;
      const sig = digest(body);
      const one = join(p.url, `/api/agents/${encodeURIComponent(body.name)}`);

      if (!force && lastRegistered.get(key) === sig) {
        const chk = await send('check', one, { headers: mgmt, timeoutMs, ...tls });
        if (chk.ok) return { ...chk, data: { listed: true, mode: 'management-api', name: body.name, action: 'unchanged' } };
        if (chk.status === 403) return { ok: true, status: 200, data: { listed: true, mode: 'management-api', name: body.name, action: 'unchanged (not verified: credential lacks AgentGateway:View)' } };
        if (chk.status !== 404) return { ...chk, data: { error: { message: `Could not check the registration of "${body.name}": ${managementHint(p, chk)}` } } };
        lastRegistered.delete(key); // deleted in Bifrost → re-create below
      }

      let action = 'created';
      let res = await send('register', join(p.url, '/api/agents'), { method: 'POST', headers: mgmt, body, timeoutMs, ...tls });
      if (!res.ok && (res.status === 409 || /exist|already|duplicate|conflict|unique/i.test(bifrostError(res)))) {
        action = 'updated';
        res = await send('update', one, { method: 'PUT', headers: mgmt, body, timeoutMs, ...tls });
      }
      if (!res.ok) {
        lastRegistered.delete(key);
        return { ...res, data: { error: { message: `Bifrost rejected the registration of "${body.name}": ${managementHint(p, res)}` } } };
      }
      lastRegistered.set(key, sig);
      return { ...res, data: { listed: true, mode: 'management-api', name: body.name, action } };
    },

    async deregister(agentId) {
      const mgmt = managementHeaders(p);
      if (!mgmt) return { ok: true, status: 204, data: { skipped: 'manual registration — remove it in Bifrost → Agent Catalog' } };
      return send('deregister', join(p.url, fill(p.deregisterPath, { agentName: nameOf(agentId) })), { method: 'DELETE', headers: mgmt, timeoutMs, ...tls });
    },

    /** Discovery: read Bifrost's served card for each known agent name and keep those with the skill. */
    async discover({ skill } = {}) {
      const candidates = [...new Set([...Object.keys(names), 'agent-a', 'agent-b', ...String(p.discoverAgents ?? '').split(',').map((x) => x.trim()).filter(Boolean)])];
      const results = await Promise.all(candidates.map(async (agentId) => {
        const url = servedCardUrl(agentId);
        const r = await send('discover', url, { headers: vkHeaders(), timeoutMs, ...tls });
        return { agentId, url, r };
      }));
      const agents = results
        .filter(({ r }) => r.ok && r.data?.skills)
        .filter(({ r }) => !skill || r.data.skills.some((s) => s.id === skill))
        .map(({ agentId, url, r }) => ({ agentId, name: r.data.name, url: r.data.supportedInterfaces?.find((i) => i.protocolBinding === 'JSONRPC')?.url ?? null, provider: r.data.provider?.organization ?? null, agentCardUrl: url, health: { status: 'healthy' }, card: r.data }));
      const firstErr = results.find(({ r }) => !r.ok && r.status !== 404)?.r;
      const ok = agents.length > 0 || !firstErr;
      return { ok, status: ok ? 200 : firstErr.status, url: join(p.url, '/agents/a2a/'), agents, data: ok ? { agents } : { error: { message: bifrostError(firstErr) } } };
    },

    async invoke(targetAgentId, rpc, { credentialOverride } = {}) {
      const url = join(p.url, fill(p.invokePath, { agentName: nameOf(targetAgentId) }));
      const res = await send('invoke', url, {
        method: 'POST',
        headers: { ...vkHeaders(credentialOverride), 'a2a-version': '1.0', ...(rpc?.params?.metadata?.envelope?.correlation_id ? { 'x-correlation-id': rpc.params.metadata.envelope.correlation_id } : {}) },
        body: rpc, timeoutMs: 30000, ...tls,
      });
      return { ...res, route: 'gateway', url, gateway: { id: p.id, name: p.name } };
    },
    idOf,
  };
}

// ── Whitematter A2A Gateway ──────────────────────────────────────────────────────────────
// Docs: docs.whitematterai.dev/a2a-gateway/get-started/a2a-gateway
//   Base URL  https://<host>/a2a/{org}; each agent at /a2a/{org}/{agent-slug}
//   Caller key on EVERY request: Authorization: Bearer <key>, or the caller-key header (WM_KEY_HEADER)
//   POST /{slug} (JSON-RPC, A2A 1.0 via A2A-Version), GET /{slug}/.well-known/agent-card.json, GET /catalog
//   Agents are registered by an admin in the Whitematter console (no self-registration API).
//   Gateway errors use -31xxx with an error-code field (WM_ERROR_CODE_FIELD); every response carries a request ID (WM_REQUEST_ID_HEADER).
export const WHITEMATTER_ERRORS = Object.freeze({
  a2a_unauthenticated: 'The caller key is missing, invalid, expired or disabled (or a required user token is missing). Send it as "Authorization: Bearer <caller key>" or in the gateway\'s caller-key header.',
  a2a_forbidden: 'The caller\'s grant does not allow this method or skill, or the source IP is not allowed. Check the grant on the caller in the Whitematter console (and message.metadata.skill_id for skill-routed agents).',
  a2a_agent_not_found: 'Unknown or disabled agent, or this caller key has no grant for it (agents without a grant are invisible). Check the slug and the caller\'s grants.',
  a2a_card_unapproved: 'The agent has no approved card, or its card changed and is blocked until an admin approves the new version (Whitematter console → Agents → pending changes).',
  a2a_rate_limited: 'A rate, concurrency or open-task limit was reached; retry after the Retry-After interval.',
  a2a_blocked_by_dlp: 'Whitematter DLP blocked the request, response, stream or push update.',
  a2a_upstream_error: 'Whitematter could not reach the agent or got an invalid response. Whitematter only calls agents over HTTPS on public addresses: check the card URL and the agent\'s outbound auth.',
  a2a_unavailable: 'The A2A gateway is off on this deployment or temporarily unavailable; retry later.',
  a2a_upstream_timeout: 'The agent did not answer in time.',
  a2a_chain_limit: 'Delegation chain too deep, a loop, or a required delegation-chain token is missing.',
});
const WHITEMATTER_BY_CODE = { '-31401': 'a2a_unauthenticated', '-31403': 'a2a_forbidden', '-31404': 'a2a_agent_not_found', '-31409': 'a2a_card_unapproved', '-31429': 'a2a_rate_limited', '-31451': 'a2a_blocked_by_dlp', '-31502': 'a2a_upstream_error', '-31503': 'a2a_unavailable', '-31504': 'a2a_upstream_timeout', '-31508': 'a2a_chain_limit' };

/** Turn any Whitematter error body (JSON-RPC -31xxx or google.rpc-style HTTP error) into one actionable line. */
export function explainWhitematterError(res) {
  const d = res?.data ?? {};
  const e = d.error ?? {};
  const detail = (e.details ?? []).find((x) => x?.metadata) ?? {};
  const code = e.data?.[WM_ERROR_CODE_FIELD] ?? detail.metadata?.[WM_ERROR_CODE_FIELD] ?? WHITEMATTER_BY_CODE[String(e.code)] ?? (String(detail.reason ?? '').toLowerCase() || null);
  const requestId = e.data?.request_id ?? detail.metadata?.request_id ?? res?.headers?.[WM_REQUEST_ID_HEADER] ?? null;
  const reason = e.data?.reason ? ` (${e.data.reason})` : '';
  const original = e.message ?? (typeof e === 'string' ? e : null) ?? `HTTP ${res?.status}`;
  if (e.code === -32003) return { code: 'push_not_enabled', message: 'Push notifications are not enabled for this Whitematter organization (-32003).', requestId };
  const hint = code && WHITEMATTER_ERRORS[code] ? `${WHITEMATTER_ERRORS[code]}${reason}` : original;
  return { code, message: `${hint}${code && WHITEMATTER_ERRORS[code] ? ` Whitematter said: ${original}.` : ''}${requestId ? ` Gateway request ID: ${requestId}` : ''}`, requestId };
}

/** Accept a base URL, an agent URL or an agent card URL; return { base, slug } (base = …/a2a/{org}). */
export function parseWhitematterUrl(url) {
  const u = new URL(url);
  const m = /^(.*?\/a2a\/[^/]+)(?:\/([^/]+))?(?:\/\.well-known\/agent(?:-card)?\.json)?\/?$/.exec(u.pathname);
  if (!m) return { base: url.replace(/\/+$/, ''), slug: null };
  const slug = m[2] && !['catalog', '.well-known'].includes(m[2]) ? m[2] : null;
  return { base: `${u.origin}${m[1]}`, slug };
}

function createWhitematterAdapter(profile, { timeoutMs = 8000, onRequest } = {}) {
  const p = withKindDefaults(profile);
  const send = makeSender(onRequest);
  const { base } = parseWhitematterUrl(p.url);
  const names = parseAgentNames(p.agentNames);
  const nameOf = (agentId) => names[agentId] ?? agentId;
  const idOf = (slug) => Object.entries(names).find(([, n]) => n === slug)?.[0] ?? slug;
  const keyHeaders = (override) => outboundHeaders(p, override);
  const cardUrlOf = (agentId) => `${base}/${encodeURIComponent(nameOf(agentId))}/.well-known/agent-card.json`;
  const fail = (res, prefix) => ({ ...res, ok: false, data: { error: { message: `${prefix}${explainWhitematterError(res).message}` } } });

  return {
    profile: p,
    protocol: 'a2a-v1',
    base,
    nameOf,
    idOf,
    cardUrlOf,
    registrationMode: () => 'manual',
    invokeUrl: (agentId) => `${base}/${encodeURIComponent(nameOf(agentId))}`,

    /** Whitematter has no health endpoint: an authenticated catalog read proves reachability AND a valid key. */
    async health() {
      const res = await send('health', `${base}/catalog`, { headers: keyHeaders(), timeoutMs: 4000 });
      return res.ok ? res : fail(res, '');
    },

    /** Registration happens in the Whitematter console; verify it by reading the card Whitematter serves for this agent. */
    async register({ agentId }) {
      const url = cardUrlOf(agentId);
      const res = await send('verify', url, { headers: keyHeaders(), timeoutMs });
      if (res.ok) return { ...res, data: { listed: true, mode: 'verified', servedCardUrl: url } };
      return fail(res, `Whitematter does not serve "${nameOf(agentId)}" to this caller key: `);
    },
    async deregister() { return { ok: true, status: 204, data: { skipped: 'Whitematter registrations are managed in the Whitematter console' } }; },

    /** Discovery: the caller's catalog (agents it has grants for), then each candidate's served card. */
    async discover({ skill } = {}) {
      const cat = await send('discover', `${base}/catalog`, { headers: keyHeaders(), timeoutMs });
      let slugs = [];
      if (cat.ok) {
        const d = cat.data;
        const list = Array.isArray(d) ? d : d?.agents ?? d?.items ?? d?.results ?? d?.data ?? [];
        slugs = list.map((a) => a.slug ?? a.agent ?? a.handle ?? (a.url ? parseWhitematterUrl(a.url).slug : null) ?? (a.card_url ? parseWhitematterUrl(a.card_url).slug : null) ?? a.id ?? a.name).filter(Boolean);
      }
      for (const n of Object.values(names)) if (!slugs.includes(n)) slugs.push(n);
      const cards = await Promise.all(slugs.map(async (slug) => {
        const url = `${base}/${encodeURIComponent(slug)}/.well-known/agent-card.json`;
        const r = await send('discover', url, { headers: keyHeaders(), timeoutMs });
        return { slug, url, r };
      }));
      const agents = cards
        .filter(({ r }) => r.ok && Array.isArray(r.data?.skills))
        .filter(({ r }) => !skill || r.data.skills.some((s) => s.id === skill || s.name === skill))
        .map(({ slug, url, r }) => ({ agentId: idOf(slug), slug, name: r.data.name, url: r.data.supportedInterfaces?.find((i) => i.protocolBinding === 'JSONRPC')?.url ?? `${base}/${slug}`, provider: r.data.provider?.organization ?? null, agentCardUrl: url, health: { status: 'healthy' }, card: r.data }));
      if (!cat.ok && !agents.length) return { ...fail(cat, 'Whitematter catalog: '), url: `${base}/catalog`, agents: [] };
      return { ok: true, status: 200, url: `${base}/catalog`, agents, data: { agents } };
    },

    async invoke(targetAgentId, rpc, { credentialOverride, headers: extra = {} } = {}) {
      const url = `${base}/${encodeURIComponent(nameOf(targetAgentId))}`;
      const res = await send('invoke', url, { method: 'POST', headers: { ...keyHeaders(credentialOverride), 'A2A-Version': '1.0', ...extra }, body: rpc, timeoutMs: 30_000 });
      const out = { ...res, route: 'gateway', url, gateway: { id: p.id, name: p.name }, whitematterRequestId: res.headers?.[WM_REQUEST_ID_HEADER] ?? null };
      if (!res.ok || res.data?.error?.code <= -31000) {
        const ex = explainWhitematterError(res);
        if (res.data?.error && typeof res.data.error === 'object' && 'code' in res.data.error && typeof res.data.error.code === 'number' && res.data.error.code < 0) {
          out.data = { ...res.data, error: { ...res.data.error, message: ex.message } };
        } else if (!res.ok) {
          out.data = { error: { message: ex.message, whitematterCode: ex.code } };
        }
      }
      return out;
    },
  };
}

/** Which gateway controls apply for the active profile. */
export function controlsFor(gatewayEnabled, profile) {
  const name = profile?.name ?? 'a2a-gateway';
  const isPoc = !profile || profile.kind === 'poc-gateway';
  const declared = new Set(isPoc ? CONTROL_KEYS : withKindDefaults(profile).declaredControls);
  const gw = CONTROL_DEFS.map((c) => {
    if (!gatewayEnabled) return { ...c, applied: false, enforcedBy: 'not applied (gateway bypassed)' };
    if (!declared.has(c.key)) return { ...c, applied: false, enforcedBy: `not provided by ${name}` };
    return { ...c, applied: true, enforcedBy: isPoc ? name : `${name} (declared by operator, not verified by this agent)` };
  });
  return [
    ...gw,
    { key: 'endpoint_credential', name: 'Endpoint credential check', short: 'endpoint auth', applied: true, enforcedBy: gatewayEnabled ? `agent (${name} forwarding credential)` : 'agent (static direct API key only)' },
    { key: 'local_validation', name: 'Agent-local payload validation', short: 'local validation', applied: true, enforcedBy: 'agent' },
  ];
}

/**
 * The requests an agent makes to (and expects from) a gateway, as data. Rendered to curl by the caller.
 * @param {object} ctx  { agentId, peerId, cardUrl, agentEndpoint }
 */
export function plannedRequests(profile, { agentId, peerId, cardUrl, agentEndpoint }) {
  const p = withKindDefaults(profile);
  const v1 = p.kind === 'bifrost' || p.protocol === 'a2a-v1';
  const json = { 'Content-Type': 'application/json' };
  const ver = v1 ? { 'A2A-Version': '1.0' } : {};
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const sample = (sender, recipient) => (v1
    ? { jsonrpc: '2.0', id: 'curl-check', method: 'GetTask', params: { id: 'task_curl_check' } }
    : toJsonRpc('tasks/get', createEnvelope({ sender, recipient, skill: 'vehicle_service_orchestration', intent: 'get_task_status', taskId: 'task_curl_check' })));
  const out = [{ id: 'health', title: 'Health check', direction: 'agent → gateway', method: 'GET', url: join(p.url, p.healthPath), headers: {}, note: 'Sent without credentials.' }];
  const inb = inboundAuth(p);

  if (p.kind === 'whitematter') {
    const { base } = parseWhitematterUrl(p.url);
    const names = parseAgentNames(p.agentNames);
    const slug = (id) => names[id] ?? id;
    out[0] = { id: 'health', title: 'Reachability + caller key check (catalog)', direction: 'agent → gateway', method: 'GET', url: `${base}/catalog`, headers: outboundHeaders(p), note: 'Whitematter has no health endpoint; an authenticated catalog read proves the address and the caller key.' };
    out.push({ id: 'register', title: `Verify ${agentId} is registered (card served by Whitematter)`, direction: 'agent → gateway', method: 'GET', url: `${base}/${slug(agentId)}/.well-known/agent-card.json`, headers: outboundHeaders(p), note: `Agents are registered by an admin in the Whitematter console (card URL ${cardUrl}, outbound auth = the gateway → agent header below). This read needs a caller key with a grant for "${slug(agentId)}".` });
    out.push({ id: 'discover', title: 'Discover agents this caller key can reach', direction: 'agent → gateway', method: 'GET', url: `${base}/catalog`, headers: outboundHeaders(p) });
    out.push({ id: 'invoke', title: `Call ${peerId} through ${p.name}`, direction: 'agent → gateway', method: 'POST', url: `${base}/${slug(peerId)}`, headers: { ...outboundHeaders(p), 'A2A-Version': '1.0', ...json }, body: { jsonrpc: '2.0', id: 'curl-check', method: 'GetTask', params: { id: 'task_curl_check' } }, note: 'A harmless GetTask: -32001 (task not found) means the key, grant and routing work. -31401/-31403/-31404 are explained in the gateway card.' });
    out.push({
      id: 'inbound', title: `What ${p.name} must send to ${agentId} (its "outbound auth")`, direction: 'gateway → agent', method: 'POST', url: agentEndpoint,
      headers: { ...(inb ? { [inb.name]: inb.value } : {}), 'A2A-Version': '1.0', ...json },
      body: { jsonrpc: '2.0', id: 'curl-check', method: 'GetTask', params: { id: 'task_curl_check' } },
      note: inb ? `In the Whitematter console, set this agent's outbound auth to ${/^bearer\s/i.test(inb.value) && inb.name.toLowerCase() === 'authorization' ? 'Bearer token' : `API key header "${inb.name}"`} with this value.` : 'No gateway → agent header configured: this agent will reject calls from Whitematter.',
    });
    return out;
  }
  if (p.kind === 'bifrost') {
    const names = parseAgentNames(p.agentNames);
    const nameOf = (id) => names[id] ?? id;
    const mh = managementHeaders(p);
    const vkIds = String(p.virtualKeyIds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (mh) {
      out.push({
        id: 'register', title: `Register ${agentId} (Bifrost management API)`, direction: 'agent → gateway', method: 'POST', url: join(p.url, '/api/agents'),
        headers: { ...mh, ...json },
        body: { name: nameOf(agentId), agent_card_url: cardUrl, enabled: true, allow_by_default: p.allowByDefault !== false, runtime_auth: inb ? { type: 'headers', headers: { [inb.name]: inb.value } } : { type: 'none' }, ...(vkIds.length ? { virtual_key_ids: vkIds } : {}) },
        note: `If "${nameOf(agentId)}" already exists, the same body goes to PUT /api/agents/${nameOf(agentId)}. Later heartbeats only GET that URL. runtime_auth is the header Bifrost will send to this agent.`,
      });
    } else {
      out.push({ id: 'register', title: `Verify ${agentId} is listed (manual registration)`, direction: 'agent → gateway', method: 'GET', url: join(p.url, fill(p.discoverPath, { agentName: nameOf(agentId) })), headers: outboundHeaders(p), note: `Management auth is off. Register "${nameOf(agentId)}" by hand in Bifrost → Agents → Agent Catalog with card URL ${cardUrl}${inb ? ` and request header ${inb.name}` : ''}.` });
    }
    out.push({ id: 'discover', title: `Discover ${peerId}`, direction: 'agent → gateway', method: 'GET', url: join(p.url, fill(p.discoverPath, { agentName: nameOf(peerId) })), headers: outboundHeaders(p) });
    out.push({ id: 'invoke', title: `Call ${peerId} through ${p.name}`, direction: 'agent → gateway', method: 'POST', url: join(p.url, fill(p.invokePath, { agentName: nameOf(peerId) })), headers: { ...outboundHeaders(p), ...ver, ...json }, body: sample(agentId, peerId), note: 'A harmless GetTask for a non-existent task: success means authentication worked end to end (expect error -32001 Task not found).' });
  } else {
    const regUrl = join(p.url, fill(p.registerPath, { agentId }));
    const reg = { id: 'register', title: `Register ${agentId}`, direction: 'agent → gateway', method: p.registerMethod, url: regUrl, headers: { ...outboundHeaders(p), ...json } };
    if (p.registerBody === 'card') reg.bodyFrom = `curl -sS ${q(cardUrl)}`;
    else if (p.registerBody === 'cardUrl') reg.body = { agentId, agentCardUrl: cardUrl };
    else reg.bodyFrom = `curl -sS ${q(cardUrl)} | jq -c ${q(`{agentId: "${agentId}", agentCardUrl: "${cardUrl}", card: .}`)}`;
    out.push(reg);
    out.push({ id: 'discover', title: 'Discover agents with the service skill', direction: 'agent → gateway', method: 'GET', url: tidyQuery(join(p.url, fill(p.discoverPath, { skill: 'vehicle_service_orchestration' }))), headers: outboundHeaders(p) });
    out.push({ id: 'invoke', title: `Call ${peerId} through ${p.name}`, direction: 'agent → gateway', method: 'POST', url: join(p.url, fill(p.invokePath, { agentId: peerId })), headers: { ...outboundHeaders(p), ...ver, ...json }, body: sample(agentId, peerId), note: 'A harmless get-task call for a non-existent task: a "task not found" answer means authentication worked end to end.' });
  }

  out.push({
    id: 'inbound', title: `What ${p.name} must send to ${agentId}`, direction: 'gateway → agent', method: 'POST', url: agentEndpoint,
    headers: { ...(inb ? { [inb.name]: inb.value } : {}), ...(p.kind !== 'bifrost' && p.callerHeader ? { [p.callerHeader]: peerId } : {}), ...ver, ...json },
    body: sample(peerId, agentId),
    note: inb ? `${agentId} accepts requests from ${p.name} only with this ${inb.name} header${p.kind === 'bifrost' ? ' (the request authentication on its Bifrost registration)' : ''}.` : `No forwarding credential is configured, so ${agentId} will reject requests from ${p.name}.`,
  });
  return out;
}
