// Runs the real stack in-process and writes the actual A2A payloads it exchanges to examples/.
// Usage: npm run examples
import fs from 'node:fs';
import path from 'node:path';
import { startStack, waitFor, post, get, TOKENS } from '../tests/helpers.js';
import { createEnvelope, toJsonRpc, requestToV1, toV1Task, streamResponseFor } from '@axon-fleet/shared';

const out = path.resolve('examples');
fs.mkdirSync(out, { recursive: true });
const s = await startStack({ stepDelayMs: 30 });
const ports = { [new URL(s.aUrl).port]: 4001, [new URL(s.bUrl).port]: 4002, [new URL(s.gatewayUrl).port]: 4000 };
const tidy = (obj) => JSON.parse(JSON.stringify(obj).replace(/http:\/\/127\.0\.0\.1:(\d+)/g, (m, p) => `http://localhost:${ports[p] ?? p}`)
  .replace(/test-gw-token-a|test-gw-token-b|test-forward-token|test-direct-[ab]/g, '<redacted>'));
const write = (name, obj) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(tidy(obj), null, 2)}\n`);

try {
  write('agent-card-agent-a.json', (await get(`${s.aUrl}/.well-known/agent-card.json`)).body);
  write('agent-card-agent-b.json', (await get(`${s.bUrl}/.well-known/agent-card.json`)).body);
  write('00-registry-registration.json', { request: { method: 'POST', url: `${s.gatewayUrl}/registry/agents`, headers: { authorization: 'Bearer <agent gateway token>' }, body: { agentId: 'agent-b', agentCardUrl: `${s.bUrl}/.well-known/agent-card.json`, card: '<Agent Card — see agent-card-agent-b.json>' } }, discovery: (await get(`${s.gatewayUrl}/registry/agents?skill=vehicle_service_orchestration`, { authorization: `Bearer ${TOKENS['agent-a']}` })).body });

  await post(`${s.aUrl}/api/telemetry`, { vehicleId: 'veh-001', scenario: 'brake_wear' });
  const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
  await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed');
  write('01-telemetry-service-request.json', { description: 'Agent A → (gateway) → Agent B: message/send for skill vehicle_service_orchestration', request: sent.body.request, response: sent.body.initialResponse.body });

  const bState = (await get(`${s.bUrl}/api/state`)).body;
  const pushes = bState.exchanges.filter((x) => x.kind === 'status_push').reverse();
  const byStage = (st) => pushes.find((p) => p.request.params.task.metadata.stage === st);
  const files = { inventory_checked: '02-inventory-check.json', parts_reserved: '03-parts-reservation.json', parts_ordered: '04-parts-order-creation.json', appointment_proposed: '05-appointment-proposal.json', completed: '07-task-completed-push.json' };
  for (const [stage, file] of Object.entries(files)) {
    const p = byStage(stage);
    write(file, { description: `Agent B → (gateway) → Agent A: tasks/pushNotification at stage '${stage}'`, request: p.request, response: p.response.body });
  }
  const refreshed = await post(`${s.aUrl}/api/tasks/${sent.body.taskId}/refresh`, {});
  const getEx = (await get(`${s.aUrl}/api/state`)).body.exchanges.find((x) => x.request?.method === 'tasks/get');
  write('06-task-status-update.json', { description: 'Agent A → (gateway) → Agent B: tasks/get (alias get_task_status)', request: getEx.request, response: refreshed.body.response.body });

  const probe = await post(`${s.aUrl}/api/probe`, { type: 'unauthorized_skill' });
  const denied = (await get(`${s.aUrl}/api/state`)).body.exchanges.find((x) => x.kind === 'probe:unauthorized_skill');
  write('08-gateway-denied-unauthorized-skill.json', { description: 'Gateway rejects delete_inventory (not allowlisted for agent-a → agent-b)', request: denied.request, response: denied.response, probe: probe.body });

  const env = createEnvelope({ sender: 'agent-a', recipient: 'agent-b', skill: 'vehicle_service_orchestration', intent: 'cancel_task', taskId: 'task_example' });
  write('09-cancel-task-request.json', { description: 'cancel_task alias → tasks/cancel', request: toJsonRpc('cancel_task', env) });
  // A2A v1 wire shapes (what Bifrost and other v1 gateways exchange)
  const v1req = requestToV1(sent.body.request, { pushConfig: { url: 'http://host.docker.internal:4001/a2a/push', token: 'ptok_example', authentication: { scheme: 'Bearer', credentials: 'ptok_example' } } });
  const done = s.b.tasks.get(sent.body.taskId);
  write('10-a2a-v1-sendmessage.json', { description: 'A2A v1 SendMessage as Agent A sends it through Bifrost (header A2A-Version: 1.0)', request: v1req, response: { jsonrpc: '2.0', id: v1req.id, result: { task: toV1Task({ ...done, status: { state: 'submitted', timestamp: done.metadata.stageHistory[0].at }, artifacts: [] }) } } });
  write('11-a2a-v1-push-status-update.json', { description: 'A2A v1 push notification (StreamResponse.statusUpdate) POSTed to the webhook', body: streamResponseFor({ ...done, status: { state: 'working', timestamp: done.status.timestamp }, metadata: { ...done.metadata, stage: 'parts_ordered' } }, false) });
  write('12-a2a-v1-push-completed.json', { description: 'A2A v1 push notification for the terminal state (StreamResponse.task with artifact)', body: streamResponseFor(done, true) });
  console.log(`Wrote examples to ${out}`);
} finally {
  await s.stop();
}
