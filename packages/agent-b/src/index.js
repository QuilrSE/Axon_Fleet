import path from 'node:path';
import { loadEnv, fileStore } from '@axon-fleet/shared/node';
import { applyDemoEnvDefaults, envInt, envStr, envBool, createLogger } from '@axon-fleet/shared';
import { createAgentB } from './app.js';

loadEnv();
applyDemoEnvDefaults();
const logger = createLogger('agent-b');
const agent = createAgentB({
  logger,
  baseUrl: envStr('AGENT_B_PUBLIC_URL', 'http://localhost:4002'),
  gatewayUrl: envStr('GATEWAY_URL', 'http://localhost:4000'),
  gatewayToken: envStr('AGENT_B_GATEWAY_TOKEN', 'poc-gw-token-agent-b'),
  gatewayForwardToken: envStr('GATEWAY_FORWARD_TOKEN', 'poc-gw-forward-token'),
  directApiKey: envStr('AGENT_B_DIRECT_API_KEY', 'poc-direct-key-agent-b'),
  agentADirectApiKey: envStr('AGENT_A_DIRECT_API_KEY', 'poc-direct-key-agent-a'),
  agentADirectUrl: `${envStr('AGENT_A_PUBLIC_URL', 'http://localhost:4001')}/a2a`,
  gatewayDefaultEnabled: envBool('GATEWAY_DEFAULT_ENABLED', true),
  stepDelayMs: envInt('AGENT_B_STEP_DELAY_MS', 900),
  registrationIntervalMs: envInt('REGISTRATION_INTERVAL_MS', 15_000),
  runtimeStore: fileStore(path.resolve(envStr('RUNTIME_DIR', '.runtime'), 'agent-b.json')),
  corsOrigins: envStr('CORS_ORIGINS', '*'),
  cardFormat: envStr('AGENT_CARD_FORMAT', 'dual'),
  allowSecretReveal: envBool('DASHBOARD_ALLOW_SECRET_REVEAL', true),
  allowPrivateGateways: envBool('GATEWAY_ALLOW_PRIVATE_NETWORKS', true),
  requireHttpsForPublicGateways: envBool('GATEWAY_REQUIRE_HTTPS_FOR_PUBLIC', false),
  gatewayUrlAllowlist: envStr('GATEWAY_URL_ALLOWLIST', '').split(',').map((h) => h.trim()).filter(Boolean),
});
await agent.start({ port: envInt('AGENT_B_PORT', 4002) });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await agent.stop(); process.exit(0); });
