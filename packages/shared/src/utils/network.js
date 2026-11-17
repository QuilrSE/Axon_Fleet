// Network helpers for reaching gateways anywhere: localhost, private networks (LAN, VPN, Docker,
// Kubernetes) and the public internet — over plain HTTP or HTTPS.
import { Agent, EnvHttpProxyAgent } from 'undici';

const isIPv4 = (h) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h);
const isIPv6 = (h) => h.includes(':') && /^[0-9a-f:.]+$/i.test(h);
let interfacesProvider = () => ({});
/** Node.js registers os.networkInterfaces here ('@axon-fleet/shared/node'); Workers have no local interfaces. */
export function setNetworkInterfacesProvider(fn) { interfacesProvider = fn; }

/** Classify a hostname by name/IP only (no DNS lookup): 'loopback' | 'private' | 'public'. */
export function hostScope(hostname = '') {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '0.0.0.0') return 'loopback';
  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  if (isIPv6(h)) return /^(fc|fd|fe8|fe9|fea|feb)/.test(h) ? 'private' : 'public';
  // Single-label names (docker-compose service names, intranet hosts) and common private suffixes.
  if (!h.includes('.') || /\.(local|internal|lan|home|corp|intranet|private|svc|cluster\.local)$/.test(h) || h === 'host.docker.internal') return 'private';
  return 'public';
}

export const SCOPE_LABELS = Object.freeze({ loopback: 'This machine (localhost)', private: 'Private network', public: 'Public internet' });

/**
 * Normalize what a person types into a gateway URL.
 *  - Accepts "host:port", "host:port/base", "http://…", "https://…".
 *  - An explicit scheme argument or an explicit scheme in the input always wins — http is never upgraded.
 *  - With no scheme at all: http for localhost / private hosts, https for public hosts.
 */
export function normalizeGatewayUrl(input, scheme) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('url is required');
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (m) {
    raw = `${m[1].toLowerCase()}://${raw.slice(m[0].length)}`;
    if (scheme && ['http', 'https'].includes(scheme)) raw = `${scheme}://${raw.slice(m[0].length)}`;
  } else {
    const hostPart = raw.split('/')[0].replace(/:\d+$/, '');
    const chosen = ['http', 'https'].includes(scheme) ? scheme : (hostScope(hostPart) === 'public' ? 'https' : 'http');
    raw = `${chosen}://${raw}`;
  }
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url must use http:// or https://');
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function describeUrl(u) {
  try {
    const url = new URL(u);
    return { protocol: url.protocol.slice(0, -1), host: url.host, hostname: url.hostname, scope: hostScope(url.hostname), secure: url.protocol === 'https:' };
  } catch { return null; }
}

/** Local addresses this process could be reached on — offered as advertised-URL suggestions. */
export function localAddressSuggestions(port, current) {
  if (!port) return current ? [{ label: 'Current', url: current, scope: describeUrl(current)?.scope ?? 'public' }] : [];
  const out = [];
  const add = (label, url, scope) => { if (!out.some((s) => s.url === url)) out.push({ label, url, scope }); };
  if (current) add('Current', current, describeUrl(current)?.scope ?? 'loopback');
  add('Same machine', `http://localhost:${port}`, 'loopback');
  for (const [name, addrs] of Object.entries(interfacesProvider() ?? {})) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      add(`LAN (${name})`, `http://${a.address}:${port}`, hostScope(a.address));
    }
  }
  add('From a Docker container on this host', `http://host.docker.internal:${port}`, 'private');
  return out;
}

const PROXY_SET = () => !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
const dispatchers = new Map();
/**
 * undici dispatcher per connection policy.
 *  - Honors HTTP(S)_PROXY / NO_PROXY when set (EnvHttpProxyAgent), so public gateways work behind a
 *    corporate proxy while localhost/private hosts listed in NO_PROXY stay direct.
 *  - tlsSkipVerify: accept self-signed certificates (dev only). For private CAs prefer NODE_EXTRA_CA_CERTS.
 */
export function dispatcherFor({ tlsSkipVerify = false } = {}) {
  const key = `${PROXY_SET()}|${tlsSkipVerify}`;
  if (!dispatchers.has(key)) {
    const opts = { connect: { rejectUnauthorized: !tlsSkipVerify } };
    dispatchers.set(key, PROXY_SET() ? new EnvHttpProxyAgent(opts) : new Agent(opts));
  }
  return dispatchers.get(key);
}

const TLS_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/** Turn low-level network errors into an actionable sentence. */
export function explainNetworkError(err, url) {
  const code = err?.cause?.code ?? err?.code ?? '';
  const reason = err?.cause?.reason ?? err?.cause?.message ?? err?.message ?? '';
  let u; try { u = new URL(url); } catch { /* ignore */ }
  const where = u ? `${u.protocol}//${u.host}` : url;
  if (err?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return { code: 'TIMEOUT', message: `No response from ${where} in time. Check the host, port, firewall/VPN, or proxy settings.` };
  if (/bad port/i.test(reason)) return { code: 'BLOCKED_PORT', message: `Port ${u?.port} is on the WHATWG fetch blocked-port list (e.g. 1, 9, 6000, 6667), so no HTTP client will call it. Run the gateway on another port.` };
  if (code === 'ECONNREFUSED') {
    const docker = u && hostScope(u.hostname) === 'loopback' ? ' If this agent runs in Docker, "localhost" is the container itself; use host.docker.internal or the compose service name.' : '';
    return { code, message: `Connection refused at ${where}: nothing is listening on that port.${docker}` };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code, message: `Cannot resolve host "${u?.hostname}". Check the spelling, DNS, or VPN connection.` };
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || /wrong version number|packet length too long/i.test(reason)) return { code: 'TLS_TO_HTTP', message: `${where} does not speak HTTPS on this port. Use http:// instead.` };
  if (TLS_CODES.has(code)) return { code, message: `TLS certificate not trusted for ${where} (${code}). For a private CA set NODE_EXTRA_CA_CERTS; for a dev gateway with a self-signed cert enable "skip TLS verification" on the gateway.` };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return { code, message: `Connection to ${where} was reset. If the gateway only serves HTTPS, use https://.` };
  return { code: code || 'NETWORK_ERROR', message: `${reason || 'Network error'} (${where})` };
}
