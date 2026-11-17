// A2A Agent Card helpers.
// Spec-aligned fields (A2A v0.3 AgentCard): protocolVersion, name, description, url, preferredTransport,
// additionalInterfaces, provider, version, capabilities, securitySchemes, security,
// defaultInputModes, defaultOutputModes, skills[].
// PoC extension: each skill may carry "x-poc-schemas" (JSON Schema-ish input/output hints).
export const A2A_PROTOCOL_VERSION = '0.3.0';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

const FORBIDDEN_KEYS = ['token', 'apikey', 'api_key', 'secret', 'password', 'clientsecret', 'privatekey', 'credential', 'credentials'];

export const CARD_FORMATS = Object.freeze({
  dual: 'A2A v1.0 + v0.3 compatibility fields (default)',
  v1: 'Strict A2A v1.0 only',
});
const V03_FIELDS = ['protocolVersion', 'url', 'preferredTransport', 'additionalInterfaces', 'security'];

/**
 * Fill a card template: replaces {{BASE_URL}} / {{VERSION}} placeholders.
 * format "dual" keeps v0.3 fields (url, preferredTransport, …) next to v1 supportedInterfaces;
 * format "v1" strips them for gateways/clients that want a strict v1 card.
 */
export function buildAgentCard(template, { baseUrl, version, format = 'dual' } = {}) {
  if (!baseUrl) throw new Error('buildAgentCard: baseUrl is required');
  const json = JSON.stringify(template)
    .replaceAll('{{BASE_URL}}', baseUrl.replace(/\/$/, ''))
    .replaceAll('{{VERSION}}', version ?? template.version ?? '0.0.0');
  const card = JSON.parse(json);
  normalizeSecurityRequirements(card);
  if (format === 'v1') for (const f of V03_FIELDS) delete card[f];
  else card.protocolVersion ??= A2A_PROTOCOL_VERSION;
  return card;
}

/**
 * Write security requirement scopes as plain arrays: { schemes: { bearer: [] } }.
 * ProtoJSON's canonical form is { "list": [...] }, but A2A Go SDK releases before v2.6.0
 * (used by gateways such as Bifrost) can only decode arrays and fail with
 * "cannot unmarshal object into Go struct field .0.schemes.<name> of type a2a.SecuritySchemeScopes".
 * Arrays are accepted by both old and new SDKs, so they are the interoperable choice.
 */
export function normalizeSecurityRequirements(card) {
  const fix = (reqs) => (Array.isArray(reqs) ? reqs.map((r) => ({
    ...r,
    schemes: Object.fromEntries(Object.entries(r?.schemes ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : Array.isArray(v?.list) ? v.list : []])),
  })) : reqs);
  if (card.securityRequirements) card.securityRequirements = fix(card.securityRequirements);
  for (const s of card.skills ?? []) if (s.securityRequirements) s.securityRequirements = fix(s.securityRequirements);
  return card;
}

/** v1 interfaces a gateway could proxy (JSONRPC / HTTP+JSON / GRPC with protocolVersion 1.x). */
export function v1Interfaces(card) {
  return (card?.supportedInterfaces ?? []).filter((i) => i?.url && ['JSONRPC', 'HTTP+JSON', 'GRPC'].includes(i.protocolBinding) && /^1(\.|$)/.test(String(i.protocolVersion ?? '')));
}

/** The JSON-RPC endpoint of a card, whichever version it is written in. */
export function cardEndpoint(card) {
  return v1Interfaces(card).find((i) => i.protocolBinding === 'JSONRPC')?.url
    ?? card?.url
    ?? (card?.supportedInterfaces ?? []).find((i) => i.protocolBinding === 'JSONRPC')?.url
    ?? null;
}

/** Structural validation. Returns { valid, errors[] }. */
export function validateAgentCard(card, { knownSecrets = [] } = {}) {
  const errors = [];
  if (!card || typeof card !== 'object') return { valid: false, errors: ['card must be an object'] };
  for (const f of ['name', 'description', 'version']) {
    if (typeof card[f] !== 'string' || !card[f]) errors.push(`missing or invalid "${f}"`);
  }
  // Either a v1 card (supportedInterfaces) or a v0.3 card (protocolVersion + url).
  const hasV1 = v1Interfaces(card).length > 0;
  if (!hasV1) {
    if (Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length) errors.push('"supportedInterfaces" has no entry with url, protocolBinding (JSONRPC | HTTP+JSON | GRPC) and protocolVersion 1.x');
    else if (typeof card.url !== 'string' || !card.url || typeof card.protocolVersion !== 'string') errors.push('card needs "supportedInterfaces" (A2A v1) or "protocolVersion" + "url" (A2A v0.3)');
  }
  const endpoint = cardEndpoint(card);
  if (endpoint && !/^https?:\/\//.test(endpoint)) errors.push('the JSON-RPC endpoint must be an absolute http(s) URL');
  if (!card.provider?.organization) errors.push('missing "provider.organization"');
  if (!card.capabilities || typeof card.capabilities !== 'object') errors.push('missing "capabilities"');
  if (!Array.isArray(card.defaultInputModes) || !card.defaultInputModes.length) errors.push('missing "defaultInputModes"');
  if (!Array.isArray(card.defaultOutputModes) || !card.defaultOutputModes.length) errors.push('missing "defaultOutputModes"');
  if (!Array.isArray(card.skills) || !card.skills.length) errors.push('"skills" must be a non-empty array');
  else {
    card.skills.forEach((s, i) => {
      if (!s.id || !s.name || !s.description) errors.push(`skills[${i}] needs id, name, description`);
      if (!Array.isArray(s.tags)) errors.push(`skills[${i}].tags must be an array`);
    });
  }
  if ((card.security || card.securityRequirements) && !card.securitySchemes) errors.push('security requirements reference schemes but "securitySchemes" is missing');
  errors.push(...findSecrets(card, knownSecrets));
  return { valid: errors.length === 0, errors };
}

/** Agent Cards must DECLARE auth schemes, never CONTAIN credentials. */
export function findSecrets(card, knownSecrets = []) {
  const problems = [];
  const walk = (node, path) => {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.includes(k.toLowerCase()) && typeof v === 'string') {
          problems.push(`possible secret in agent card at "${path}${k}"`);
        }
        walk(v, `${path}${k}.`);
      }
    }
  };
  walk(card, '');
  const json = JSON.stringify(card);
  for (const s of knownSecrets.filter(Boolean)) {
    if (json.includes(s)) problems.push('agent card contains a configured credential value');
  }
  return problems;
}

export const getSkill = (card, skillId) => card?.skills?.find((s) => s.id === skillId) ?? null;
export const cardOrigin = (card) => new URL(cardEndpoint(card)).origin;
