// Pure environment helpers (no file access, so they also run on Cloudflare Workers).
// loadEnv() lives in '@axon-fleet/shared/node'.

export const envStr = (key, fallback) => process.env[key] ?? fallback;
export const envInt = (key, fallback) => {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};
export const envBool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

/** "agent-a:tok1,agent-b:tok2" -> { 'agent-a': 'tok1', 'agent-b': 'tok2' } */
export function parseTokenMap(str = '') {
  const out = {};
  for (const pair of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/** Demo credential defaults so gateway presets (which use env: references) work without a .env file. */
export function applyDemoEnvDefaults() {
  const d = {
    AGENT_A_GATEWAY_TOKEN: 'poc-gw-token-agent-a', AGENT_B_GATEWAY_TOKEN: 'poc-gw-token-agent-b', GATEWAY_FORWARD_TOKEN: 'poc-gw-forward-token',
    AGENT_A_PARTNER_GATEWAY_KEY: 'partner-key-agent-a', AGENT_B_PARTNER_GATEWAY_KEY: 'partner-key-agent-b', PARTNER_GATEWAY_FORWARD_TOKEN: 'partner-forward-token',
    BIFROST_FORWARD_TOKEN: 'bifrost-forward-token',
  };
  for (const [k, v] of Object.entries(d)) process.env[k] ??= v;
}
