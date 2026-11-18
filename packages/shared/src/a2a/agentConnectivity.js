// Agent-side connectivity: gateway toggle (runtime, no restart), multiple gateway profiles
// (one active for routing, any number to publish the Agent Card to), registration heartbeats,
// per-gateway health, and the "which security controls apply right now" description for the UIs.
import { createGatewayAdapter, controlsFor, resolveSecret, CONTROL_DEFS, plannedRequests } from './gatewayAdapters.js';
import { inboundAuth, secretSources } from './gatewayHeaders.js';
import { toCurl } from './curl.js';
import { GatewayProfileStore } from './gatewayProfiles.js';
import { nowIso } from '../utils/ids.js';
import { describeUrl } from '../utils/network.js';

export const GATEWAY_CONTROLS = Object.freeze(CONTROL_DEFS.map((c) => c.name));
/** Back-compat helper: controls for the built-in gateway. */
export const securityControls = (gatewayEnabled, profile) => controlsFor(gatewayEnabled, profile);
export const DIRECT_MODE_WARNING = 'Gateway policy, centralized authentication, audit logging, rate limiting, and routing controls are bypassed.';

export class AgentConnectivity {
  /**
   * @param {object} o
   * @param {object} o.defaultGateway  profile built from env (id 'a2a-gateway')
   * @param {string[]} [o.allowlist]   allowed gateway hostnames (empty = any)
   */
  constructor({ agentId, peerAgentId, getCard, getCardUrl, runtime, defaultGateway, allowlist = [], allowPrivate = true, requireHttpsForPublic = false, registrationIntervalMs = 15_000, healthIntervalMs = 5000, allowReveal = true, logger }) {
    Object.assign(this, { agentId, getCard, getCardUrl, runtime, registrationIntervalMs, healthIntervalMs, logger, allowReveal });
    this.peerAgentId = peerAgentId ?? (agentId === 'agent-a' ? 'agent-b' : 'agent-a');
    this.sentRequests = new Map();   // profileId -> Map(op -> last request)
    this.inboundSeen = new Map();    // profileId -> last accepted request from that gateway
    this.lastRejectedInbound = null;
    this.profiles = new GatewayProfileStore({ runtime, defaults: [{ registerEnabled: true, ...defaultGateway }], allowlist, allowPrivate, requireHttpsForPublic });
    this.status = new Map();
    this.timers = [];
  }

  // ── active gateway ───────────────────────────────────────────────────
  get enabled() { return this.runtime.get('gatewayEnabled') !== false; }
  get active() { return this.profiles.active(); }
  get gatewayUrl() { return this.active?.url; }
  adapter(profile = this.active) {
    return createGatewayAdapter(profile, { onRequest: (r) => this.#recordSent(profile.id, r) });
  }

  #recordSent(profileId, r) {
    if (!this.sentRequests.has(profileId)) this.sentRequests.set(profileId, new Map());
    this.sentRequests.get(profileId).set(r.op, r);
  }

  /** Called by the agent's A2A routes for every inbound request (accepted or rejected). */
  recordInbound(inbound, req) {
    const relevant = new Set(['authorization', 'a2a-version', 'content-type']);
    for (const g of this.inboundCredentials()) { relevant.add(g.header); if (g.callerHeader) relevant.add(g.callerHeader.toLowerCase()); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (relevant.has(k) || k.startsWith('x-a2a') || k.startsWith('x-partner') || k.startsWith('x-bf')) headers[k] = String(v);
    const rec = { at: new Date().toISOString(), method: req.method, url: `${this.getCardUrl().replace('/.well-known/agent-card.json', '')}${req.originalUrl ?? req.url}`, headers, status: inbound.ok ? 200 : inbound.status, reason: inbound.reason, rpcMethod: req.body?.method ?? null };
    if (inbound.ok && inbound.via === 'gateway' && inbound.gateway?.id) this.inboundSeen.set(inbound.gateway.id, rec);
    if (!inbound.ok) this.lastRejectedInbound = rec;
  }

  /** Equivalent curl for a gateway: planned requests, the last ones actually sent, and the last inbound. */
  curls(profileOrId, { reveal = false } = {}) {
    const profile = typeof profileOrId === 'string' ? this.profiles.get(profileOrId) : profileOrId;
    if (!profile) return null;
    const allow = reveal && this.allowReveal;
    const sources = secretSources(profile);
    const cardUrl = this.getCardUrl();
    const agentEndpoint = cardUrl.replace('/.well-known/agent-card.json', '/a2a');
    const render = (req) => toCurl(req, { sources, reveal: allow });
    const summarizeBody = (b) => {
      if (b && typeof b === 'object' && b.skills && b.name) return { dataFile: 'agent-card.json', note: `Body: this agent's card (save it from ${cardUrl}).` };
      if (b && typeof b === 'object' && b.card) return { body: { ...b, card: '<agent card JSON>' }, note: 'The "card" field carries the full agent card.' };
      return { body: b };
    };
    // Only rendered output leaves the agent: raw headers/bodies would carry unmasked secrets.
    const planned = plannedRequests(profile, { agentId: this.agentId, peerId: this.peerAgentId, cardUrl, agentEndpoint })
      .map((r) => ({ id: r.id, title: r.title, direction: r.direction, note: r.note ?? null, method: r.method, url: r.url, curl: render(r) }));
    const sent = [...(this.sentRequests.get(profile.id)?.values() ?? [])].sort((a, b) => b.at.localeCompare(a.at)).map((r) => {
      const { body, dataFile, note } = summarizeBody(r.body);
      return { op: r.op, at: r.at, status: r.status, ms: r.ms, error: r.error, note, curl: render({ method: r.method, url: r.url, headers: r.headers, body, dataFile }) };
    });
    const seen = this.inboundSeen.get(profile.id);
    const inbound = seen ? { at: seen.at, status: seen.status, rpcMethod: seen.rpcMethod, curl: render({ method: seen.method, url: seen.url, headers: seen.headers }) } : null;
    // Rejected requests come from unknown senders: never reveal, mask any credential-looking header.
    const rj = this.lastRejectedInbound;
    const rejected = rj ? {
      at: rj.at, status: rj.status, reason: rj.reason, rpcMethod: rj.rpcMethod,
      curl: toCurl({ method: rj.method, url: rj.url, headers: Object.fromEntries(Object.entries(rj.headers).map(([k, v]) => [k, ['content-type', 'a2a-version'].includes(k) ? v : `<${v.split(/\s+/).length > 1 ? `${v.split(/\s+/)[0]} ` : ''}received …${v.slice(-4)}, ${v.length} chars>`])) }),
    } : null;
    return { gateway: { id: profile.id, name: profile.name }, revealed: allow, revealAllowed: this.allowReveal, envSecrets: sources.filter((x) => x.env).map((x) => x.env), planned, sent, inbound, rejected };
  }
  #st(id) {
    if (!this.status.has(id)) this.status.set(id, { registration: { status: 'pending', at: null, error: null }, health: { status: 'unknown', checkedAt: null } });
    return this.status.get(id);
  }
  get registration() { return this.#st(this.profiles.activeId()).registration; }
  get health() { return this.#st(this.profiles.activeId()).health; }

  setEnabled(enabled, by = 'dashboard') {
    const values = this.runtime.set({ gatewayEnabled: !!enabled }, by);
    this.logger?.info('gateway_mode_changed', { agentId: this.agentId, gatewayEnabled: !!enabled, by });
    if (enabled) this.registerOnce().catch(() => {});
    return values;
  }
  resetMode(by = 'reset') { return this.runtime.set({ gatewayEnabled: this.runtime.defaults.gatewayEnabled !== false }, by); }

  /** Credentials gateways present when they forward to this agent (accepted inbound). */
  inboundCredentials() {
    return this.profiles.list()
      .map((p) => { const a = inboundAuth(p); return a && { header: a.name.toLowerCase(), headerName: a.name, value: a.value, profileId: p.id, name: p.name, callerHeader: p.kind === 'bifrost' ? (p.callerHeader || '') : (p.callerHeader || 'x-a2a-caller') }; })
      .filter(Boolean);
  }

  // ── registration & health ────────────────────────────────────────────
  async registerWith(profile, { force = false } = {}) {
    const st = this.#st(profile.id);
    const res = await this.adapter(profile).register({ agentId: this.agentId, card: this.getCard(), agentCardUrl: this.getCardUrl() }, { force });
    const prev = st.registration.status;
    st.registration = res.ok
      ? { status: 'registered', at: nowIso(), error: null, httpStatus: res.status, mode: res.data?.mode ?? null, servedCardUrl: res.data?.servedCardUrl ?? null, action: res.data?.action ?? null, bifrostName: res.data?.name ?? null }
      : { status: ['bifrost', 'whitematter'].includes(profile.kind) && res.status === 404 ? 'not_registered' : 'failed', at: nowIso(), httpStatus: res.status, mode: profile.kind === 'bifrost' ? this.adapter(profile).registrationMode() : null, error: res.data?.error?.message ?? res.data?.message ?? res.data?.error ?? `HTTP ${res.status}` };
    if (prev !== st.registration.status) this.logger?.info('registration_status', { agentId: this.agentId, gateway: profile.id, ...st.registration });
    return st.registration;
  }

  /** Register with one gateway (by id) or with every profile that has registerEnabled. */
  async registerOnce(profileId, { force = false } = {}) {
    const targets = profileId ? [this.profiles.get(profileId)].filter(Boolean) : this.profiles.list().filter((p) => p.registerEnabled !== false);
    await Promise.all(targets.map((p) => this.registerWith(p, { force }).catch((e) => { this.#st(p.id).registration = { status: 'failed', at: nowIso(), error: e.message }; })));
    return this.registration;
  }

  async deregisterFrom(profile) {
    const res = await this.adapter(profile).deregister(this.agentId);
    this.#st(profile.id).registration = { status: 'deregistered', at: nowIso(), error: res.ok ? null : `HTTP ${res.status}` };
    return res;
  }

  async refreshHealth(profileId) {
    const targets = profileId ? [this.profiles.get(profileId)].filter(Boolean) : this.profiles.list();
    await Promise.all(targets.map(async (p) => {
      const r = await this.adapter(p).health();
      this.#st(p.id).health = { status: r.ok ? 'healthy' : 'unreachable', checkedAt: nowIso(), latencyMs: r.ms, httpStatus: r.status };
    }));
    return this.health;
  }

  start() {
    const loop = (fn, ms) => { const t = setInterval(() => fn().catch(() => {}), ms); t.unref?.(); this.timers.push(t); };
    this.registerOnce().catch(() => {});
    this.refreshHealth().catch(() => {});
    loop(async () => {
      const pending = this.profiles.list().filter((p) => p.registerEnabled !== false && this.#st(p.id).registration.status !== 'registered');
      await Promise.all(pending.map((p) => this.registerWith(p).catch(() => {})));
    }, 3000);
    loop(() => this.registerOnce(), this.registrationIntervalMs);
    loop(() => this.refreshHealth(), this.healthIntervalMs);
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  // ── UI ───────────────────────────────────────────────────────────────
  /** Can this gateway reach the agent, and is the link safe? Plain-language warnings for the UI. */
  warningsFor(p) {
    const gw = describeUrl(p.url);
    const card = describeUrl(this.getCardUrl());
    const w = [];
    if (!gw) return w;
    // env: references that resolve to nothing silently send no credential — say so.
    const unset = (ref) => typeof ref === 'string' && ref.startsWith('env:') && !process.env[ref.slice(4)];
    if (p.authScheme !== 'none' && unset(p.credential)) w.push({ level: 'warn', text: `${p.credential.slice(4)} is not set in this agent's environment, so no ${p.kind === 'bifrost' ? 'virtual key' : 'credential'} is sent to this gateway. Export it where you run npm start (or add it to .env) and restart.` });
    if (unset(p.inboundCredential)) w.push({ level: 'warn', text: `${p.inboundCredential.slice(4)} is not set, so this agent will reject requests forwarded by this gateway.` });
    if (p.kind === 'bifrost' && p.managementAuthScheme === 'setup-token' && card && card.scope !== 'public') w.push({ level: 'info', text: 'Setup-token mode is for Bifrost without dashboard login, and Bifrost only allows private destinations (such as host.docker.internal) for dashboard-authenticated operations. If registration is blocked, switch management auth to admin username:password or a management API key.' });
    if (p.kind === 'bifrost' && p.managementAuthScheme && p.managementAuthScheme !== 'none' && unset(p.managementCredential)) w.push({ level: 'info', text: `${p.managementCredential.slice(4)} is not set, so the agent cannot register itself and only checks a manual registration in the Agent Catalog.` });
    if (gw.scope === 'public' && !gw.secure) w.push({ level: 'warn', text: 'Plain HTTP over the public internet: credentials and payloads are not encrypted.' });
    if (p.kind === 'bifrost' && p.registerEnabled !== false && this.adapter(p).registrationMode() === 'manual') {
      w.push({ level: 'info', text: `Manual registration: in Bifrost → Agents → Agent Catalog add "${this.adapter(p).nameOf(this.agentId)}" with card URL ${this.getCardUrl()} and request header Authorization: Bearer <${p.inboundCredential?.startsWith('env:') ? p.inboundCredential.slice(4) : 'forwarding token'}>. Or set management auth so the agent registers itself.` });
    }
    if (p.tlsSkipVerify && gw.secure) w.push({ level: 'warn', text: 'TLS certificate verification is off for this gateway.' });
    if (p.kind === 'whitematter') {
      const cardUrl = this.getCardUrl();
      if (!(card?.secure && card.scope === 'public')) w.push({ level: 'warn', text: `Whitematter only calls agents over HTTPS on public addresses and never follows redirects. This agent's card URL is ${cardUrl}. Deploy to Cloudflare (or put it behind a public HTTPS tunnel) and register that URL in the Whitematter console.` });
      if (p.authScheme === 'none') w.push({ level: 'info', text: 'Target only: no caller key, so this agent can receive calls from Whitematter but cannot call other agents through it.' });
      if (!p.inboundCredential) w.push({ level: 'warn', text: 'Set the gateway → agent header and use the same value as this agent\'s outbound auth in the Whitematter console, otherwise calls from Whitematter are rejected.' });
      if (p.registerEnabled === false) w.push({ level: 'info', text: `Register this agent in the Whitematter console (Agents → Card URL: ${cardUrl}); the agent cannot register itself with Whitematter.` });
      return w;
    }
    if (p.kind === 'bifrost' && card?.scope === 'loopback') {
      const port = new URL(this.getCardUrl()).port;
      w.push({ level: 'warn', text: `If Bifrost runs in Docker, it cannot reach this agent at localhost. Set the advertised URL to http://host.docker.internal:${port} and add host.docker.internal to Bifrost's Private Network Allowlist.` });
    } else if (card?.scope === 'loopback' && gw.scope !== 'loopback') {
      w.push({ level: 'warn', text: `This gateway runs on another host, so it cannot reach this agent at ${this.getCardUrl().replace('/.well-known/agent-card.json', '')}. Set an advertised URL it can reach.` });
    } else if (card?.scope === 'private' && gw.scope === 'public') {
      w.push({ level: 'info', text: 'A public gateway usually cannot reach a private-network agent URL. Use a public URL or a tunnel if requests do not arrive.' });
    }
    return w;
  }

  gatewayList() {
    const activeId = this.profiles.activeId();
    return this.profiles.list().map((p) => ({ ...this.profiles.masked(p), active: p.id === activeId, network: describeUrl(p.url), warnings: this.warningsFor(p), ...this.#st(p.id) }));
  }

  /** Change the URL published in the Agent Card (and re-register everywhere). */
  async setAdvertisedBaseUrl(url, by = 'dashboard') {
    this.runtime.set({ advertisedBaseUrl: url || null }, by);
    await this.registerOnce();
    return this.getCardUrl();
  }

  describe({ peerLabel, peerDirectEndpoint, routingPath, directRoutingPath, inboundRoute, directInboundRoute, discovery }) {
    const on = this.enabled;
    const cfg = this.runtime.all();
    const active = this.active;
    const adapter = this.adapter(active);
    const activeInfo = { id: active.id, name: active.name, url: active.url, kind: active.kind, invokeUrl: adapter.invokeUrl(this.agentId), network: describeUrl(active.url) };
    return {
      gatewayEnabled: on,
      badge: on ? 'Gateway Enabled' : 'Gateway Disabled — Direct Mode',
      communicationMode: on ? 'Gateway-mediated A2A' : 'Direct A2A',
      activeGateway: activeInfo,
      gatewayUrl: active.url,
      gatewayHealth: this.health,
      registration: { ...this.registration, note: on ? null : 'Card stays registered, but traffic bypasses the gateway in direct mode' },
      registeredWith: this.gatewayList().filter((g) => g.registration.status === 'registered').map((g) => g.name),
      discovery: discovery ?? null,
      routingPath: on ? routingPath.map((n) => (n === '{gateway}' ? active.id : n)) : directRoutingPath,
      inboundRoute: on ? inboundRoute(activeInfo) : directInboundRoute,
      peer: { label: peerLabel, directEndpoint: peerDirectEndpoint },
      securityMode: on
        ? (active.kind === 'poc-gateway' ? 'Gateway-enforced: credential authn, allowlist, skill authz, rate limit, central audit' : `Delegated to ${active.name}: controls as declared by its operator`)
        : 'Direct endpoint auth only (static API key)',
      warning: on ? null : DIRECT_MODE_WARNING,
      auditVisibility: on ? `Audit at ${active.name} + agent-local log` : 'Agent-local log only — no central audit trail',
      controls: controlsFor(on, active),
      gateways: this.gatewayList(),
      updatedAt: cfg.updatedAt,
      updatedBy: cfg.updatedBy,
    };
  }
}
