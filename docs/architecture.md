# Architecture

## Services

**a2a-gateway** is both the Agent Registry and the gateway. It owns no business state. It keeps registered Agent Cards, health status, an audit trail, a routing log and a lightweight index of tasks it has seen.

**agent-a** (In-Vehicle Telemetry & Driver Assistant Agent) is an imperative Node service: a seeded `TelemetryGenerator`, local `maintenanceRules`, and a `VehicleAgent` that discovers a service agent, sends A2A tasks and tracks their status. It is both an A2A *client* (outbound tasks) and an A2A *server* (it accepts status pushes and serves a `vehicle_telemetry_query` skill).

**agent-b** (Dealership & Service Center Orchestration Agent) is deliberately built differently, as if it came from another vendor's framework. Work runs on **DealerFlow**, a small graph runtime (`runtime/flowRuntime.js`) whose nodes mutate a shared state object (`diagnose → check_inventory → reserve_parts → order_missing_parts → propose_appointment`). The **A2A adapter** (`adapters/a2aAdapter.js`) is the only module that knows A2A shapes; it converts A2A messages into DealerFlow work orders and DealerFlow transitions back into A2A task status messages and artifacts. This is the interoperability point A2A exists for: neither agent knows how the other is built.

**web-dashboard** is a static site served by Express. `/config.js` injects the browser-facing URLs of the other services. Pages poll each service's `/api/state`.

**partner-gateway-mock** is a stand-in for a third-party A2A gateway with a different API and fewer controls. Agents can register with it and route through it via a gateway profile (`docs/custom-gateways.md`).

**packages/shared** holds protocol code used by every service: Agent Card building and validation, JSON-RPC envelope helpers, the task store, the A2A HTTP client, the registry, telemetry schemas, authentication, policy, rate limiting, audit, and `AgentConnectivity` (toggle, registration heartbeat, gateway health and the security-controls description the UIs show).

## Replaceable seams

| Mock | Interface to keep | Real replacement |
|---|---|---|
| `TelemetryGenerator` | `generate(vehicleId, scenario) → telemetry` | CAN/OBD gateway, OEM connected-car cloud |
| `maintenanceRules.evaluate` | `telemetry → { alerts, predictedMaintenance }` | On-board ML model or LLM reasoning |
| `diagnosisRules.diagnose` | `telemetry → { findings, parts, services }` | OEM repair-procedure / labour-time service |
| `InventoryService` | `check`, `reserve`, `releaseByTask`, `list` | DMS / ERP inventory API |
| `PartsOrderService` | `create`, `cancelByTask`, `list` | Supplier purchase-order / EDI integration |
| `SchedulingService` | `propose`, `releaseByTask`, `view` | DMS service scheduler |
| Gateway adapter (`generic` mapping) | `register`, `discover`, `invoke`, `health`, `deregister` | Dedicated adapter for a production A2A gateway |
| `StaticTokenAuthenticator` | `authenticate(req) → principal` | OAuth 2.0 JWT, OIDC, mTLS |
| `AuditLog` sink | `sink(entry)` | SIEM, OpenTelemetry, append-only store |

## Data flow (gateway enabled)

1. Agents start and register their Agent Cards (heartbeat every 15 s).
2. Agent A generates telemetry, evaluates it locally and, on request, asks the registry for an agent with skill `vehicle_service_orchestration`.
3. Agent A sends `message/send` to `POST /a2a/agent-b` on the gateway with its own bearer token.
4. The gateway authenticates, validates, binds the envelope sender to the token's identity, rate-limits, authorizes the skill, resolves Agent B's endpoint from its card and forwards with the gateway forwarding token.
5. Agent B returns a `Task` (`submitted`, stage `received`) immediately and processes it asynchronously.
6. At each DealerFlow transition Agent B sends `tasks/pushNotification` to `POST /a2a/agent-a` on the gateway, which applies the same controls in the reverse direction.
7. The final push carries the `service-assessment` artifact.

The direct-mode flow skips steps 2's registry lookup (Agent A fetches Agent B's card from a configured URL) and every gateway control in steps 4 and 6. See `a2a-flow.md` for both sequence diagrams.
