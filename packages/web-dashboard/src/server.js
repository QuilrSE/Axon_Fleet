// Static web dashboard. Injects the browser-facing service URLs via /config.js.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@axon-fleet/shared/node';
import { envInt, envStr, createLogger, listen } from '@axon-fleet/shared';

loadEnv();
const logger = createLogger('web-dashboard');
const here = path.dirname(fileURLToPath(import.meta.url));
const config = {
  agentAUrl: envStr('DASHBOARD_AGENT_A_URL', 'http://localhost:4001'),
  agentBUrl: envStr('DASHBOARD_AGENT_B_URL', 'http://localhost:4002'),
  gatewayUrl: envStr('DASHBOARD_GATEWAY_URL', 'http://localhost:4000'),
};

const app = express();
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'web-dashboard', config }));
app.get('/config.js', (req, res) => res.type('application/javascript').send(`window.POC_CONFIG = ${JSON.stringify(config)};`));
app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

const port = envInt('DASHBOARD_PORT', 5173);
await listen(app, port);
logger.info('dashboard_started', { url: `http://localhost:${port}`, ...config });
