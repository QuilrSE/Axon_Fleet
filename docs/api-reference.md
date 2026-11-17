# API reference

All responses are JSON. Errors: `{ "error": { "code", "message", "details" } }` for REST, JSON-RPC `error` objects for A2A endpoints.

## A2A Gateway (`:4000`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Status, uptime, registered agent count |
| POST | `/registry/agents` | agent gateway token | Register / heartbeat an Agent Card |
| DELETE | `/registry/agents/:agentId` | own token | Deregister self |
| GET | `/registry/agents?skill=&tag=&name=&capability=&provider=` | agent gateway token | Discovery |
| GET | `/registry/agents/:agentId/card` | agent gateway token | Full Agent Card |
| POST | `/a2a/:targetAgentId` | caller's gateway token | Gateway-mediated A2A JSON-RPC |
| GET | `/api/state` | — (dev) | Dashboard state: agents, policy, routes, audit, rate-limit events, tasks, stats |
| GET | `/api/audit?agent=&type=&limit=` | — (dev) | Filtered audit trail |
| POST | `/api/logs/clear` | — (dev) | Clear logs and counters |

## Agent A (`:4001`)

| Method | Path | Description |
|---|---|---|
| GET | `/.well-known/agent-card.json` | Agent Card |
| GET | `/health` | Status + current gateway mode |
| POST | `/a2a` | A2A JSON-RPC. v1: `SendMessage` (skill `vehicle_telemetry_query`), `GetTask`. v0.3: `tasks/pushNotification`, `message/send`, `tasks/get` |
| POST | `/a2a/push` | A2A v1 push-notification webhook (`StreamResponse` body; per-request token from `taskPushNotificationConfig`) |
| GET/PUT | `/api/identity` | Card URL, endpoint, advertised URL, peer card URL, card format (`dual` \| `v1`) |
| GET | `/api/state?vehicleId=` | Dashboard state |
| POST | `/api/telemetry` `{vehicleId, scenario}` | Generate a reading. Scenarios: `normal`, `brake_wear`, `low_tire`, `battery_degradation`, `drivetrain_overheat`, `fault_code`, `multi_issue` |
| POST | `/api/service-request` `{vehicleId}` | Discover Agent B and send the latest telemetry as an A2A task |
| POST | `/api/discover` | Run discovery in the current mode |
| POST | `/api/tasks/:id/refresh` | `get_task_status` |
| POST | `/api/tasks/:id/cancel` | `cancel_task` |
| POST | `/api/probe` `{type}` | `unauthorized_skill`, `invalid_token`, `spoofed_sender`, `rate_limit_burst` |
| PUT | `/api/config` `{gatewayEnabled}` | Toggle the A2A Gateway |
| POST | `/api/config/reset` | Back to default mode (gateway list unchanged) |
| GET/POST/PUT/DELETE | `/api/gateways…` | Gateway profiles: see [custom-gateways.md](custom-gateways.md) |

## Agent B (`:4002`)

| Method | Path | Description |
|---|---|---|
| GET | `/.well-known/agent-card.json` | Agent Card |
| GET | `/health` | Status, mode, active task count |
| POST | `/a2a` | A2A JSON-RPC. v1: `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, `Create/Get/List/DeleteTaskPushNotificationConfig` (streaming → `-32004`). v0.3: `message/send`, `tasks/get`, `tasks/cancel` |
| GET/PUT | `/api/identity` | Card URL, endpoint, advertised URL, card format |
| GET | `/api/state` | Tasks, work orders, inventory, reservations, orders, schedule, events |
| PUT | `/api/config` `{gatewayEnabled}` | Toggle the A2A Gateway |
| POST | `/api/config/reset` | Back to default mode |
| POST | `/api/reset` | Reset inventory, schedule, orders and tasks |
| GET/POST/PUT/DELETE | `/api/gateways…` | Gateway profiles: see [custom-gateways.md](custom-gateways.md) |

## Partner A2A Exchange mock (`:4100`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | — | Health |
| PUT | `/v1/agents/:agentId` | `X-API-Key` (own) | Register raw Agent Card |
| DELETE | `/v1/agents/:agentId` | `X-API-Key` (own) | Remove |
| GET | `/v1/agents?skill=&tag=` | `X-API-Key` | `{ items: [{ id, name, url, status, card }] }` |
| POST | `/v1/agents/:agentId/rpc` | `X-API-Key` | Forward A2A JSON-RPC (sender must match key owner) |
| GET | `/v1/audit` | — (dev) | Audit events |

## curl walkthrough

```bash
# 1. Telemetry with an issue, then send it (path depends on Agent A's toggle)
curl -s -X POST localhost:4001/api/telemetry -H 'content-type: application/json' -d '{"vehicleId":"veh-001","scenario":"brake_wear"}'
curl -s -X POST localhost:4001/api/service-request -H 'content-type: application/json' -d '{"vehicleId":"veh-001"}'

# 2. Discover via the registry
curl -s -H 'authorization: Bearer poc-gw-token-agent-a' 'localhost:4000/registry/agents?skill=vehicle_service_orchestration'

# 3. Gateway-mediated get_task_status (replace TASK)
curl -s -X POST localhost:4000/a2a/agent-b -H 'authorization: Bearer poc-gw-token-agent-a' -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":"q1","method":"get_task_status",
  "params":{"id":"TASK","metadata":{"envelope":{"task_id":"TASK","sender_agent_id":"agent-a","recipient_agent_id":"agent-b",
  "skill":"vehicle_service_orchestration","intent":"get_task_status","payload":{},"created_at":"2026-11-15T00:00:00Z","status":"submitted","correlation_id":"corr_q1"}}}}'

# 4. Same call, direct (works only when Agent B's toggle is off)
curl -s -X POST localhost:4002/a2a -H 'authorization: Bearer poc-direct-key-agent-b' -H 'content-type: application/json' -d '<same body>'

# 5. Unauthorized skill through the gateway → 403
curl -s -X POST localhost:4000/a2a/agent-b -H 'authorization: Bearer poc-gw-token-agent-a' -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":"x","method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1","parts":[{"kind":"data","data":{}}]},
  "metadata":{"envelope":{"task_id":"t1","sender_agent_id":"agent-a","recipient_agent_id":"agent-b","skill":"delete_inventory","intent":"delete_all_inventory","payload":{},"created_at":"2026-11-15T00:00:00Z","status":"submitted","correlation_id":"c1"}}}}'

# 6. Toggle
curl -s -X PUT localhost:4001/api/config -H 'content-type: application/json' -d '{"gatewayEnabled":false}'
```

## Error codes

| Code | Meaning | HTTP |
|---|---|---|
| -32600 | Invalid request | 400 |
| -32601 | Method not found | 200 |
| -32602 | Invalid params (e.g. telemetry failed validation) | 200 |
| -32001 | Task not found (A2A) | 200 |
| -32002 | Task not cancelable (A2A) | 200 |
| -32004 | Unsupported operation / skill (A2A) | 200 |
| -32010 | Unauthenticated (PoC) | 401 |
| -32011 | Forbidden: identity mismatch or skill not allowlisted (PoC) | 403 |
| -32012 | Gateway required: direct call while the agent's gateway toggle is on (PoC) | 403 |
| -32029 | Rate limited (PoC) | 429 |
| -32050 | Upstream unavailable / not registered (PoC) | 404 / 502 |
| -32007 | Extended agent card not configured (A2A v1) | 200 |
| -32009 | `A2A-Version` not supported (A2A v1) | 400 |

## A2A v1 example (what Bifrost forwards to Agent B)

```bash
curl -s -X POST localhost:4002/a2a -H 'authorization: Bearer bifrost-forward-token' -H 'a2a-version: 1.0' \
  -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":"1","method":"SendMessage",
  "params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[
    {"text":"Assess this vehicle"},
    {"data":{"vehicle":{"vehicleId":"veh-001","vin":"SYNTH0EV0SEDAN001"},
             "telemetry":{"vehicleId":"veh-001","vin":"SYNTH0EV0SEDAN001","timestamp":"2026-11-15T09:00:00Z","odometerKm":28317,
               "batterySocPct":70,"batterySohPct":90,"drivetrainTempC":70,"tirePressurePsi":{"fl":35,"fr":35,"rl":35,"rr":35},
               "brakePadWearPct":{"front":91,"rear":60},"faultCodes":[],"powertrain":"BEV"}}}]}}}'
```

This works only if the Bifrost gateway profile (with that forwarding token) exists on Agent B. Without `configuration.returnImmediately: true`, the call blocks until the task completes (up to 25 s).
