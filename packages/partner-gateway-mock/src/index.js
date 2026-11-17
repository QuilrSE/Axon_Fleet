import { loadEnv } from '@axon-fleet/shared/node';
import { envInt, envStr, parseTokenMap, createLogger } from '@axon-fleet/shared';
import { createPartnerGateway } from './app.js';

loadEnv();
const gw = createPartnerGateway({
  logger: createLogger('partner-gateway'),
  apiKeys: parseTokenMap(envStr('PARTNER_GATEWAY_API_KEYS', 'agent-a:partner-key-agent-a,agent-b:partner-key-agent-b')),
  forwardToken: envStr('PARTNER_GATEWAY_FORWARD_TOKEN', 'partner-forward-token'),
  corsOrigins: envStr('CORS_ORIGINS', '*'),
});
await gw.start({ port: envInt('PARTNER_GATEWAY_PORT', 4100) });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await gw.stop(); process.exit(0); });
