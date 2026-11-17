import path from 'node:path';
import { loadEnv, fileStore } from '@axon-fleet/shared/node';
import { applyDemoEnvDefaults, envInt, envStr, envBool, createLogger } from '@axon-fleet/shared';
import { createAgentA } from './app.js';

loadEnv();
applyDemoEnvDefaults();
const logger = createLogger('agent-a');
const agentBPublic = envStr('AGENT_B_PUBLIC_URL', 'http://localhost:4002');
const agent = createAgentA({
  logger,
  baseUrl: envStr('AGENT_A_PUBLIC_URL', 'http://localhost:4001'),
  gatewayUrl: envStr('GATEWAY_URL', 'http://localhost:4000'),
  gatewayToken: envStr('AGENT_A_GATEWAY_TOKEN', 'poc-gw-token-agent-a'),
  gatewayForwardToken: envStr('GATEWAY_FORWARD_TOKEN', 'poc-gw-forward-token'),
  directApiKey: envStr('AGENT_A_DIRECT_API_KEY', 'poc-direct-key-agent-a'),
  agentBDirectApiKey: envStr('AGENT_B_DIRECT_API_KEY', 'poc-direct-key-agent-b'),
  agentBCardUrl: envStr('AGENT_B_CARD_URL', `${agentBPublic}/.well-known/agent-card.json`),
  agentBDirectUrl: `${agentBPublic}/a2a`,
  gatewayDefaultEnabled: envBool('GATEWAY_DEFAULT_ENABLED', true),
  telemetrySeed: envInt('TELEMETRY_SEED', 42),
  registrationIntervalMs: envInt('REGISTRATION_INTERVAL_MS', 15_000),
  runtimeStore: fileStore(path.resolve(envStr('RUNTIME_DIR', '.runtime'), 'agent-a.json')),
  corsOrigins: envStr('CORS_ORIGINS', '*'),
  cardFormat: envStr('AGENT_CARD_FORMAT', 'dual'),
  allowSecretReveal: envBool('DASHBOARD_ALLOW_SECRET_REVEAL', true),
  allowPrivateGateways: envBool('GATEWAY_ALLOW_PRIVATE_NETWORKS', true),
  requireHttpsForPublicGateways: envBool('GATEWAY_REQUIRE_HTTPS_FOR_PUBLIC', false),
  gatewayUrlAllowlist: envStr('GATEWAY_URL_ALLOWLIST', '').split(',').map((h) => h.trim()).filter(Boolean),
});
await agent.start({ port: envInt('AGENT_A_PORT', 4001) });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await agent.stop(); process.exit(0); });
