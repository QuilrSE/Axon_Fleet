// Gateway profiles: the list of A2A gateways an agent knows about, which one routes its traffic
// ("active"), and which ones it publishes its Agent Card to ("registerEnabled").
// Persisted in the agent's RuntimeConfig; credentials are masked whenever profiles leave the agent.
import { GATEWAY_KINDS, AUTH_SCHEMES, REGISTER_BODIES, CONTROL_KEYS, PROTOCOLS, MANAGEMENT_AUTH, withKindDefaults, parseQuilrUrl } from './gatewayAdapters.js';
import { HttpError } from '../utils/http.js';
import { HEADER_NAME_RE, RESERVED_HEADERS, isValidHeaderValue } from './gatewayHeaders.js';
import { normalizeGatewayUrl, hostScope } from '../utils/network.js';

const SECRET_FIELDS = ['credential', 'inboundCredential', 'managementCredential'];
const PATH_FIELDS = ['registerPath', 'deregisterPath', 'discoverPath', 'invokePath', 'healthPath'];
const EDITABLE = ['name', 'url', 'tlsSkipVerify', 'pushMode', 'inboundHeaderName', 'managementHeaderName', 'extraHeaders', 'protocol', 'managementAuthScheme', 'managementCredential', 'agentNames', 'allowByDefault', 'virtualKeyIds', 'discoverAgents', 'kind', 'authScheme', 'authHeader', 'credential', 'inboundCredential', 'callerHeader',
  'registerEnabled', 'registerMethod', 'registerBody', 'resultsPath', 'agentIdField', 'declaredControls', ...PATH_FIELDS];

export function maskSecret(v) {
  if (!v) return '';
  if (typeof v === 'string' && v.startsWith('env:')) return v; // a reference, not a secret
  return `••••${String(v).slice(-4)}`;
}
const isMasked = (v) => typeof v === 'string' && v.startsWith('••••');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'gateway';

/**
 * @param {object} policy
 * @param {string[]} [policy.allowlist]          allowed hostnames (empty = any)
 * @param {boolean} [policy.allowPrivate=true]   allow localhost / private-network gateways
 * @param {boolean} [policy.requireHttpsForPublic=false]  reject http:// for public hosts
 */
export function validateProfile(p, { allowlist = [], allowPrivate = true, requireHttpsForPublic = false } = {}) {
  const errors = [];
  if (!p.name || String(p.name).length > 80) errors.push('name is required (max 80 characters)');
  let url;
  try { url = new URL(normalizeGatewayUrl(p.url)); } catch (e) { errors.push(`url is not valid: ${e.message.replace(/^Invalid URL.*/, 'use host:port or http(s)://host:port')}`); }
  if (url && (url.username || url.password)) errors.push('url must not embed credentials — use the credential field');
  if (url && allowlist.length && !allowlist.includes(url.hostname)) errors.push(`host '${url.hostname}' is not in GATEWAY_URL_ALLOWLIST`);
  if (url) {
    const scope = hostScope(url.hostname);
    if (!allowPrivate && scope !== 'public') errors.push(`'${url.hostname}' is a ${scope === 'loopback' ? 'localhost' : 'private-network'} address and GATEWAY_ALLOW_PRIVATE_NETWORKS=false`);
    if (requireHttpsForPublic && scope === 'public' && url.protocol === 'http:') errors.push('public gateways must use https:// (GATEWAY_REQUIRE_HTTPS_FOR_PUBLIC=true)');
  }
  if (!GATEWAY_KINDS[p.kind]) errors.push(`kind must be one of ${Object.keys(GATEWAY_KINDS).join(', ')}`);
  const d = withKindDefaults(p);
  if (!AUTH_SCHEMES.includes(d.authScheme)) errors.push(`authScheme must be one of ${AUTH_SCHEMES.join(', ')}`);
  if (p.kind === 'quilr' && url && !/\/a2a\/[^/]+/.test(url.pathname)) errors.push('QuilrAI URL must contain /a2a/{org}, e.g. https://guardrails-usa-1.quilr.ai/a2a/tadc5ab68a5195659 (an agent or card URL is fine too)');
  if (p.kind === 'quilr' && d.authScheme === 'api-key' && d.authHeader && !['x-quilr-a2a-key', 'authorization'].includes(d.authHeader.toLowerCase())) errors.push('QuilrAI accepts the caller key only as "Authorization: Bearer …" or in the "X-Quilr-A2A-Key" header');
  if (d.authScheme !== 'none' && !p.credential) errors.push(p.kind === 'quilr' ? 'a Quilr caller key (sk-quilr-a2a-…) is required to call agents through Quilr; choose "No authentication" if this agent is only a target' : p.kind === 'bifrost' ? 'a Bifrost virtual key is required (value or env:VAR_NAME), or set authentication to "none" if Bifrost does not enforce it' : 'credential is required unless authScheme is "none" (a value or env:VAR_NAME)');
  if (!['bifrost', 'quilr'].includes(p.kind) && !REGISTER_BODIES[d.registerBody]) errors.push(`registerBody must be one of ${Object.keys(REGISTER_BODIES).join(', ')}`);
  if (d.protocol && !PROTOCOLS[d.protocol]) errors.push(`protocol must be one of ${Object.keys(PROTOCOLS).join(', ')}`);
  if (p.kind === 'bifrost') {
    if (!MANAGEMENT_AUTH[d.managementAuthScheme]) errors.push(`managementAuthScheme must be one of ${Object.keys(MANAGEMENT_AUTH).join(', ')}`);
    if (d.managementAuthScheme === 'header' && !p.managementHeaderName) errors.push('management header name is required for "Custom header name + value"');
    if (d.managementAuthScheme !== 'none' && !p.managementCredential) errors.push('managementCredential is required for the chosen management auth (value or env:VAR_NAME)');
    if (p.agentNames && !/^\s*[a-z0-9-]+\s*[=:]\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*(,\s*[a-z0-9-]+\s*[=:]\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*)*$/.test(p.agentNames)) errors.push('agentNames must look like "agent-b=dealership,agent-a=vehicle" (Bifrost names: lowercase letters, digits, single hyphens)');
  }
  if (!['bifrost', 'quilr'].includes(p.kind) && !['POST', 'PUT'].includes(String(d.registerMethod).toUpperCase())) errors.push('registerMethod must be POST or PUT');
  for (const f of PATH_FIELDS) if (d[f] && !String(d[f]).startsWith('/')) errors.push(`${f} must start with "/"`);
  if (d.authHeader && !HEADER_NAME_RE.test(d.authHeader)) errors.push('agent → gateway header name is not a valid HTTP header name');
  if (d.authHeader && d.authScheme === 'api-key' && RESERVED_HEADERS.has(d.authHeader.toLowerCase())) errors.push(`"${d.authHeader}" is managed by the agent and cannot carry credentials`);
  if (p.inboundHeaderName && !HEADER_NAME_RE.test(p.inboundHeaderName)) errors.push('gateway → agent header name is not a valid HTTP header name');
  if (p.managementHeaderName && !HEADER_NAME_RE.test(p.managementHeaderName)) errors.push('management header name is not a valid HTTP header name');
  for (const f of ['credential', 'inboundCredential', 'managementCredential']) if (p[f] && !isValidHeaderValue(String(p[f]))) errors.push(`${f} must not contain line breaks`);
  if (p.extraHeaders !== undefined) {
    if (!Array.isArray(p.extraHeaders) || p.extraHeaders.length > 10) errors.push('extraHeaders must be a list of at most 10 { name, value } entries');
    else for (const h of p.extraHeaders) {
      if (!HEADER_NAME_RE.test(h?.name ?? '')) errors.push(`additional header name "${h?.name ?? ''}" is not valid`);
      else if (RESERVED_HEADERS.has(h.name.toLowerCase())) errors.push(`additional header "${h.name}" is managed by the agent`);
      if (!isValidHeaderValue(String(h?.value ?? ''))) errors.push(`additional header "${h?.name}" value must not contain line breaks`);
    }
  }
  if (d.callerHeader && !/^[a-z0-9-]+$/i.test(d.callerHeader)) errors.push('callerHeader must be a valid header name');
  if (p.declaredControls && (!Array.isArray(p.declaredControls) || p.declaredControls.some((c) => !CONTROL_KEYS.includes(c)))) errors.push(`declaredControls must be a subset of ${CONTROL_KEYS.join(', ')}`);
  return errors;
}

export class GatewayProfileStore {
  constructor({ runtime, defaults, allowlist = [], allowPrivate = true, requireHttpsForPublic = false }) {
    this.runtime = runtime;
    this.defaults = defaults;
    this.allowlist = allowlist;
    this.policy = { allowlist, allowPrivate, requireHttpsForPublic };
  }

  list() { return this.runtime.get('gateways') ?? this.defaults; }
  get(id) { return this.list().find((p) => p.id === id) ?? null; }
  activeId() {
    const id = this.runtime.get('activeGatewayId');
    return this.get(id) ? id : this.list()[0]?.id;
  }
  active() { return this.get(this.activeId()); }

  #save(gateways, extra = {}, by = 'api') { this.runtime.set({ gateways, ...extra }, by); }
  #clean(input) {
    const out = {};
    for (const k of EDITABLE) if (input[k] !== undefined) out[k] = typeof input[k] === 'string' ? input[k].trim() : input[k];
    if (out.registerMethod) out.registerMethod = String(out.registerMethod).toUpperCase();
    if (out.url) {
      try { out.url = normalizeGatewayUrl(out.url, input.scheme); } catch { /* validateProfile reports it */ }
    }
    // QuilrAI: accept an agent URL or card URL; keep the /a2a/{org} base and remember the slug.
    if ((input.kind ?? '') === 'quilr' && out.url) {
      try {
        const { base, slug } = parseQuilrUrl(out.url);
        out.url = base;
        if (slug && !out.agentNames && input.pastedAgentId) out.agentNames = `${input.pastedAgentId}=${slug}`;
      } catch { /* validateProfile reports it */ }
    }
    if (out.tlsSkipVerify !== undefined) out.tlsSkipVerify = !!out.tlsSkipVerify;
    if (out.allowByDefault !== undefined) out.allowByDefault = !!out.allowByDefault;
    if (out.extraHeaders !== undefined) out.extraHeaders = (Array.isArray(out.extraHeaders) ? out.extraHeaders : []).map((h) => ({ name: String(h?.name ?? '').trim(), value: String(h?.value ?? '') })).filter((h) => h.name || h.value);
    if (out.registerEnabled !== undefined) out.registerEnabled = !!out.registerEnabled;
    return out;
  }

  add(input, by) {
    const p = { kind: 'generic', registerEnabled: true, ...this.#clean(input) };
    const errors = validateProfile(p, this.policy);
    if (errors.length) throw new HttpError(400, 'INVALID_GATEWAY', `Gateway profile rejected: ${errors.join('; ')}`, errors);
    const list = this.list();
    let id = slug(input.id || p.name);
    for (let i = 2; list.some((x) => x.id === id); i++) id = `${slug(input.id || p.name)}-${i}`;
    const profile = { id, ...p, createdAt: new Date().toISOString() };
    this.#save([...list, profile], {}, by);
    return profile;
  }

  update(id, patch, by) {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${id}'`);
    const clean = this.#clean(patch);
    for (const f of SECRET_FIELDS) if (clean[f] === '' || isMasked(clean[f])) delete clean[f]; // blank/masked = keep existing
    if (clean.extraHeaders) clean.extraHeaders = clean.extraHeaders.map((h) => (h.value === '' || isMasked(h.value) ? { name: h.name, value: (cur.extraHeaders ?? []).find((x) => x.name === h.name)?.value ?? '' } : h));
    const next = { ...cur, ...clean, id };
    const errors = validateProfile(next, this.policy);
    if (errors.length) throw new HttpError(400, 'INVALID_GATEWAY', `Gateway profile rejected: ${errors.join('; ')}`, errors);
    this.#save(this.list().map((p) => (p.id === id ? next : p)), {}, by);
    return next;
  }

  remove(id, by) {
    if (!this.get(id)) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${id}'`);
    const list = this.list().filter((p) => p.id !== id);
    if (!list.length) throw new HttpError(409, 'LAST_GATEWAY', 'Keep at least one gateway profile; edit it instead, or switch the A2A Gateway off');
    const extra = this.activeId() === id ? { activeGatewayId: list[0].id } : {};
    this.#save(list, extra, by);
    return list;
  }

  setActive(id, by) {
    if (!this.get(id)) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${id}'`);
    this.runtime.set({ activeGatewayId: id }, by);
  }

  restoreDefaults(by) { this.runtime.set({ gateways: this.defaults, activeGatewayId: this.defaults[0].id }, by); }

  masked(p) {
    const out = withKindDefaults(p);
    for (const f of SECRET_FIELDS) out[f] = maskSecret(p[f]);
    out.extraHeaders = (p.extraHeaders ?? []).map((h) => ({ name: h.name, value: maskSecret(h.value) }));
    return out;
  }

  /** An unsaved profile (for live previews): the input merged over a stored profile, never persisted. */
  draft(input, id) {
    const cur = id ? this.get(id) : null;
    const clean = this.#clean(input);
    if (cur) {
      for (const f of SECRET_FIELDS) if (clean[f] === '' || isMasked(clean[f])) delete clean[f];
      if (clean.extraHeaders) clean.extraHeaders = clean.extraHeaders.map((h) => (h.value === '' || isMasked(h.value) ? { name: h.name, value: (cur.extraHeaders ?? []).find((x) => x.name === h.name)?.value ?? '' } : h));
    }
    const p = { kind: 'generic', registerEnabled: true, ...(cur ?? {}), ...clean, id: cur?.id ?? 'preview', name: clean.name || cur?.name || 'New gateway' };
    return { profile: p, errors: validateProfile(p, this.policy) };
  }
}
