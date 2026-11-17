// Authentication for the gateway and agents.
// PoC: static bearer tokens. Extension point: implement the Authenticator interface
//   authenticate(req) -> Promise<{ ok: true, principal: { agentId, scheme } } | { ok: false, reason }>
// for OAuth 2.0 (JWT access tokens), OpenID Connect (ID tokens / introspection) or mTLS (client cert subject).
import crypto from 'node:crypto';

export function parseBearer(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m ? m[1].trim() : null;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class StaticTokenAuthenticator {
  /** @param {Record<string,string>} tokensByAgent  { agentId: token } */
  constructor(tokensByAgent = {}) {
    this.scheme = 'static-bearer';
    this.entries = Object.entries(tokensByAgent);
  }
  async authenticate(req) {
    const token = parseBearer(req.headers?.authorization);
    if (!token) return { ok: false, reason: 'missing_bearer_token' };
    const match = this.entries.find(([, t]) => safeEqual(t, token));
    if (!match) return { ok: false, reason: 'invalid_token' };
    return { ok: true, principal: { agentId: match[0], scheme: this.scheme } };
  }
  describe() { return { scheme: this.scheme, principals: this.entries.map(([a]) => a) }; }
}

class NotImplementedAuthenticator {
  constructor(scheme) { this.scheme = scheme; }
  async authenticate() { return { ok: false, reason: `${this.scheme}_not_implemented_in_poc` }; }
  describe() { return { scheme: this.scheme, note: 'Extension point — see docs/gateway-security.md' }; }
}

export function createAuthenticator({ mode = 'static', tokens = {} } = {}) {
  switch (mode) {
    case 'static': return new StaticTokenAuthenticator(tokens);
    case 'oauth2': // validate JWT (iss, aud, exp, scope) against the IdP's JWKS
    case 'oidc': // validate ID/access token via discovery document + JWKS or token introspection
    case 'mtls': // map req.socket.getPeerCertificate().subject to an agentId
      return new NotImplementedAuthenticator(mode);
    default: throw new Error(`Unknown AUTH_MODE ${mode}`);
  }
}

/**
 * Agent-side inbound check, shared by Agent A and Agent B.
 *  - gateway-forwarded requests present the forwarding credential of any configured gateway profile
 *  - direct requests present the agent's own direct API key, and are only allowed when the
 *    agent's A2A Gateway toggle is DISABLED.
 */
/** Safe description of a secret for logs: length + last 4 characters, never the value. */
export const fingerprint = (t) => (t ? `…${String(t).slice(-4)} (${String(t).length} chars)` : 'none');

/**
 * Tokens to try from an Authorization header. Accepts the standard "Bearer <t>", a doubled prefix
 * ("Bearer Bearer <t>", produced when a gateway adds the scheme and the operator typed it too), and a
 * bare "<t>" (operator omitted the scheme). Only exact matches against configured secrets are accepted.
 */
export function tokenCandidates(header) {
  const raw = String(header ?? '').trim();
  if (!raw) return [];
  const out = [];
  let t = raw;
  while (/^Bearer\s+/i.test(t)) { t = t.replace(/^Bearer\s+/i, '').trim(); out.push(t); }
  if (!out.length) out.push(raw);
  return [...new Set(out)];
}

export function classifyInbound(req, { gatewayForwardToken, gatewayCredentials = [], directApiKey, gatewayEnabled }) {
  // Normalize: { header (lowercase), headerName, value (full header value), profileId, name, callerHeader }
  const gateways = gatewayCredentials.map((g) => (g.header ? g : { header: 'authorization', headerName: 'Authorization', value: `Bearer ${g.token}`, ...g }));
  if (gatewayForwardToken) gateways.push({ header: 'authorization', headerName: 'Authorization', value: `Bearer ${gatewayForwardToken}`, profileId: 'a2a-gateway', name: 'A2A Gateway', callerHeader: 'x-a2a-caller' });
  const accept = (gw, normalized) => ({ ok: true, via: 'gateway', gateway: { id: gw.profileId, name: gw.name }, verifiedCaller: gw.callerHeader ? (req.headers[gw.callerHeader.toLowerCase()] ?? null) : null, reason: 'gateway_forward_token', normalized });
  const tokenOf = (v) => String(v).replace(/^Bearer\s+/i, '').trim();
  const expected = gateways.map((g) => `${g.name} via ${g.headerName ?? g.header} ${fingerprint(/^Bearer\s/i.test(g.value) ? tokenOf(g.value) : g.value)}`).join(', ') || 'no gateway forwarding credentials configured';

  // 1. Gateways that authenticate with a custom header (exact value match).
  for (const g of gateways.filter((x) => x.header !== 'authorization')) {
    const got = req.headers?.[g.header];
    if (got !== undefined && safeEqual(String(got).trim(), String(g.value).trim())) return accept(g, null);
  }
  // 2. Authorization: Bearer tokens (tolerating "Bearer Bearer x" and a bare token) or an exact other scheme.
  const header = req.headers?.authorization;
  const candidates = tokenCandidates(header);
  for (const g of gateways.filter((x) => x.header === 'authorization')) {
    if (/^Bearer\s+/i.test(g.value)) {
      const want = tokenOf(g.value);
      const hit = candidates.find((c) => safeEqual(c, want));
      if (hit) return accept(g, hit !== candidates[0] || !/^Bearer\s/i.test(header) ? 'accepted a non-standard Authorization format' : null);
    } else if (header && safeEqual(String(header).trim(), String(g.value).trim())) {
      return accept(g, null);
    }
  }
  // 3. Direct calls with the agent's own API key.
  for (const token of candidates) {
    if (safeEqual(token, directApiKey)) {
      if (gatewayEnabled) {
        return { ok: false, status: 403, via: 'direct', reason: 'gateway_required', message: 'A2A Gateway is enabled on this agent — direct invocation is refused. Route through the gateway or disable the gateway toggle.' };
      }
      return { ok: true, via: 'direct', verifiedCaller: null, reason: 'direct_api_key' };
    }
  }
  const customSent = gateways.filter((g) => g.header !== 'authorization' && req.headers?.[g.header] !== undefined);
  if (!candidates.length && !customSent.length) {
    return { ok: false, status: 401, via: 'unknown', reason: 'missing_bearer_token', message: `No credential header was sent. A gateway must send its forwarding header (for Bifrost: the request authentication on the registration). Accepted: ${expected}.` };
  }
  const got = customSent.length
    ? customSent.map((g) => `${g.headerName ?? g.header} ${fingerprint(req.headers[g.header])}`).join(', ')
    : `Authorization scheme ${/^\S+\s/.test(String(header).trim()) ? String(header).trim().split(/\s+/)[0] : '(none)'}, token ${fingerprint(candidates.at(-1))}`;
  return {
    ok: false, status: 401, via: 'unknown', reason: 'invalid_credentials',
    message: `Credential not recognised: received ${got}; accepted ${expected}. Make the gateway send exactly the header and value configured on this agent.`,
  };
}
