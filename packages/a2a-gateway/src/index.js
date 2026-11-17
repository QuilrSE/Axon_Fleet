import { loadEnv } from '@axon-fleet/shared/node';
import { envInt, envStr, parseTokenMap, createLogger } from '@axon-fleet/shared';
import { createGateway } from './app.js';

loadEnv();
const logger = createLogger('a2a-gateway');
const gateway = createGateway({
  logger,
  authMode: envStr('AUTH_MODE', 'static'),
  tokens: parseTokenMap(envStr('GATEWAY_AGENT_TOKENS', 'agent-a:poc-gw-token-agent-a,agent-b:poc-gw-token-agent-b')),
  forwardToken: envStr('GATEWAY_FORWARD_TOKEN', 'poc-gw-forward-token'),
  extraSecrets: [envStr('AGENT_A_DIRECT_API_KEY'), envStr('AGENT_B_DIRECT_API_KEY')],
  rateLimit: { limit: envInt('RATE_LIMIT_MAX', 20), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 10_000) },
  healthIntervalMs: envInt('HEALTH_CHECK_INTERVAL_MS', 5000),
  corsOrigins: envStr('CORS_ORIGINS', '*'),
});
await gateway.start({ port: envInt('GATEWAY_PORT', 4000) });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await gateway.stop(); process.exit(0); });
