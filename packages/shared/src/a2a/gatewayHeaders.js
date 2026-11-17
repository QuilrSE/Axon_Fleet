// One header model for every hop between an agent and a gateway.
//
//   agent  → gateway   outboundHeaders(p): auth header (authScheme/authHeader/credential) + extraHeaders
//   agent  → gateway   managementAuth(p):  registration through a management API (Bifrost)
//   gateway → agent    inboundAuth(p):     the header the gateway must send and the agent accepts
//
// Every value may be typed literally or be an env reference ("env:VAR_NAME"). Values are sent exactly as
// configured: with authScheme "api-key" (shown as "Header name + value") nothing is added; "bearer" adds
// "Bearer "; an inbound Authorization value without a scheme is treated as a Bearer token.

export const resolveSecret = (ref) => {
  if (!ref) return '';
  if (typeof ref === 'string' && ref.startsWith('env:')) return process.env[ref.slice(4)] ?? '';
  return ref;
};
export const envName = (ref) => (typeof ref === 'string' && ref.startsWith('env:') ? ref.slice(4) : null);

export const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
export const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'content-type', 'a2a-version', 'x-correlation-id']);
export const isValidHeaderValue = (v) => typeof v === 'string' && v.length <= 8192 && !/[\r\n\0]/.test(v);
const b64 = (s) => Buffer.from(s).toString('base64');

/** The auth header the agent sends to the gateway (null when none). */
export function outboundAuth(p, override) {
  const ref = override ?? p.credential;
  const secret = resolveSecret(ref);
  if (p.authScheme === 'none' || !secret) return null;
  if (p.authScheme === 'api-key') return { name: p.authHeader || 'x-api-key', value: secret, ref };
  return { name: 'Authorization', value: `Bearer ${secret}`, ref };
}

/** Extra headers sent on every agent → gateway request. */
export function extraHeaderList(p) {
  return (Array.isArray(p.extraHeaders) ? p.extraHeaders : [])
    .map((h) => ({ name: String(h?.name ?? '').trim(), value: resolveSecret(h?.value), ref: h?.value }))
    .filter((h) => h.name && h.value);
}

export function outboundHeaders(p, override) {
  const h = {};
  for (const x of extraHeaderList(p)) h[x.name] = x.value;
  const auth = outboundAuth(p, override);
  if (auth) h[auth.name] = auth.value;
  return h;
}

/** Management (registration) auth header for Bifrost-style gateways; null = manual registration. */
export function managementAuth(p) {
  const v = resolveSecret(p.managementCredential);
  const scheme = p.managementAuthScheme;
  if (!v || !scheme || scheme === 'none') return null;
  if (scheme === 'setup-token') return { name: 'X-Bifrost-Setup-Token', value: v, ref: p.managementCredential };
  if (scheme === 'basic') return { name: 'Authorization', value: `Basic ${v.includes(':') ? b64(v) : v}`, ref: p.managementCredential, encoded: v.includes(':') ? 'base64' : null };
  if (scheme === 'header') return { name: p.managementHeaderName || 'Authorization', value: v, ref: p.managementCredential };
  return { name: 'Authorization', value: `Bearer ${v}`, ref: p.managementCredential };
}
export const managementHeaders = (p) => { const a = managementAuth(p); return a ? { [a.name]: a.value } : null; };

/** The header a gateway must send when it forwards to this agent (and what Bifrost registration sends). */
export function inboundAuth(p) {
  const v = resolveSecret(p.inboundCredential);
  if (!v) return null;
  const name = p.inboundHeaderName || 'Authorization';
  const value = name.toLowerCase() === 'authorization' && !/^\S+\s+\S/.test(v) ? `Bearer ${v}` : v;
  return { name, value, ref: p.inboundCredential };
}

/** Every secret a profile can put on the wire, with where it came from (for masking in curl output). */
export function secretSources(p) {
  const out = [];
  const add = (ref, label, prefix = '') => {
    const v = resolveSecret(ref);
    if (!v) return;
    out.push({ secret: v, env: envName(ref), label });
    if (prefix === 'basic' && v.includes(':')) out.push({ secret: b64(v), env: envName(ref), encode: 'base64', label: `${label} (base64)` });
  };
  add(p.credential, 'agent → gateway credential');
  add(p.inboundCredential, 'gateway → agent credential');
  add(p.managementCredential, 'management credential', p.managementAuthScheme === 'basic' ? 'basic' : '');
  for (const h of Array.isArray(p.extraHeaders) ? p.extraHeaders : []) add(h?.value, `header ${h?.name}`);
  return out.sort((a, b) => b.secret.length - a.secret.length);
}
