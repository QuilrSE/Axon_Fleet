# Axon Fleet

*Governed agent-to-agent (A2A) traffic for connected-vehicle service: a working demo of gateways, registries and policy between AI agents.*

Two independent AI agents discover each other through an **A2A Gateway / Agent Registry**, exchange A2A tasks, and turn a vehicle-telemetry anomaly into a parts reservation, a parts order and a proposed service appointment. A single **A2A Gateway** switch on each agent's dashboard flips between gateway-mediated and direct A2A, so you can watch routing, security enforcement and audit visibility change live.

> **Proof of concept.** Every vehicle, VIN, part, price, mechanic and organisation is synthetic. No real dealership, OEM, payment or vehicle APIs are called. The UI uses a *WhiteMatter-inspired* local design system and is not affiliated with WhiteMatter.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    D[web-dashboard :5173<br/>Agent A · Agent B · Gateway pages]
  end
  subgraph AgentA[agent-a :4001]
    A1[TelemetryEngine<br/>seeded generator + maintenance rules]
    A2[VehicleAgent]
    A3[A2A endpoint POST /a2a<br/>/.well-known/agent-card.json]
  end
  subgraph GW[a2a-gateway :4000]
    G1[Agent Registry<br/>cards · discovery · health]
    G2[Router<br/>authn → validate → identity bind → rate limit → skill authz → forward]
    G3[Audit log · route log · task index]
  end
  subgraph AgentB[agent-b :4002]
    B1[A2A adapter]
    B2[DealerFlow runtime<br/>diagnose → inventory → reserve → order → schedule]
    B3[Inventory · Parts orders · Scheduling]
  end
  D -- REST /api/* --> AgentA & AgentB & GW
  A2 -- "Gateway ON: POST /a2a/agent-b" --> G2 -- forward token --> B1
  B1 -- "Gateway ON: status push via /a2a/agent-a" --> G2 -- forward token --> A3
  A2 -. "Gateway OFF: direct POST /a2a (API key)" .-> B1
  B1 -. "Gateway OFF: direct push" .-> A3
  AgentA & AgentB -- register Agent Card --> G1
```

| Service | Port | Role |
|---|---|---|
| `a2a-gateway` | 4000 | Agent Registry + gateway-mediated A2A routing, authn/authz, rate limiting, audit |
| `agent-a` | 4001 | In-vehicle telemetry & driver-assistant agent (A2A client + endpoint) |
| `agent-b` | 4002 | Dealership & service-center orchestration agent (A2A server, separate "DealerFlow" runtime) |
| `partner-gateway-mock` | 4100 | Mock **third-party** A2A gateway with a different API, used to demo custom gateways |
| `web-dashboard` | 5173 | Static dashboards for all three services |
| `packages/shared` | — | A2A cards, messages, tasks, client, registry; telemetry; security; utils |

## Quick start

Requirements: Node.js 20+ (no database, no external services).

```bash
npm install
cp .env.example .env        # optional — defaults match .env.example
npm start                   # gateway, partner gateway mock, agent-b, agent-a, dashboard
open http://localhost:5173
```

Run services individually (separate terminals, in this order):

```bash
npm run start:gateway
npm run start:partner-gateway   # optional mock third-party gateway
npm run start:agent-b
npm run start:agent-a
npm run start:dashboard
```

Docker:

```bash
docker compose up --build
open http://localhost:5173
```

Tests (107 unit + integration tests, Node's built-in runner, no extra deps):

```bash
npm test
```

Regenerate the example payloads in `examples/` from a real run:

```bash
npm run examples
```

Reset persisted gateway-toggle state: `npm run reset` (or "Reset to default" on either dashboard).

## Deploy to Cloudflare

The whole PoC also runs as a single **Cloudflare Worker**: the dashboard as static assets, and each service as a Durable Object under `/gateway`, `/agent-a`, `/agent-b` and `/partner`. Push this folder to GitHub or GitLab, then in the Cloudflare dashboard choose **Workers & Pages → Create → Import a repository** and keep the defaults (`npx wrangler deploy`). Details, secrets, Cloudflare Access and Bifrost-via-tunnel: **[docs/cloudflare.md](docs/cloudflare.md)**. Verify with `npm run cf:smoke -- https://<your-worker>.workers.dev`.

## The demo in one minute

1. Open **Vehicle agent**, choose *Brake-pad wear above threshold*, click **Generate telemetry**, then **Send Telemetry to Service Agent**.
2. Watch the task timeline step through `received → diagnosed → inventory_checked → parts_reserved → parts_ordered → appointment_proposed → completed`, each update arriving *via gateway*.
3. Run the **Unauthorized skill** probe: the gateway returns 403 and records the denial.
4. Flip **A2A Gateway** off on both the Vehicle and Dealership dashboards. Repeat steps 1–3. The route becomes `agent-a → agent-b`, the controls list goes amber, the gateway audit stops growing, and the same probe now *succeeds* against Agent B.

The full reviewer script is in [`docs/demo-script.md`](docs/demo-script.md).

## Whitematter A2A Gateway

Both agents comply with the [Whitematter A2A Gateway](the Whitematter A2A Gateway documentation): caller keys on every request, gateway-issued task IDs, `skill_id` for skill-routed agents, push through Whitematter's relay (or polling when push is off), outbound-auth headers, and plain-language `-31xxx` errors. Add the *Whitematter A2A Gateway* template on both dashboards; you can paste an agent URL from the Whitematter console. Setup, console settings and a compliance matrix: **[docs/whitematter.md](docs/whitematter.md)**.

## Bifrost

Running Bifrost? See **[docs/bifrost.md](docs/bifrost.md)**. Add the *Bifrost Agent Gateway* template on both dashboards, point the agents' advertised URL at `http://host.docker.internal:400x`, and allowlist that host in Bifrost. The agents register themselves through Bifrost's management API (or you register them by hand) and then talk A2A v1 through `/agents/a2a/<name>/json-rpc`.

## Custom and third-party gateways

Each agent dashboard has an **A2A gateways** panel. Add any gateway URL, or a third-party gateway with a different API, and the agent registers its Agent Card there. It can be listed on several gateways at once while routing through the one you pick. Third-party APIs are handled by a declarative mapping (paths, auth header, payload shape, result fields). The repo ships a mock third-party gateway, *Partner A2A Exchange*, to show it working, and a preset that fills in its mapping.

```bash
# Agent A: register with a custom gateway URL (repeat on :4002 for Agent B; add "activate": true to route through it)
curl -s -X POST localhost:4001/api/gateways -H 'content-type: application/json' \
  -d '{"name":"Acme A2A Gateway","kind":"poc-gateway","url":"https://a2a.acme.example","credential":"env:ACME_GATEWAY_TOKEN","inboundCredential":"env:ACME_FORWARD_TOKEN"}'
```

Gateways may use **http or https** and live on **localhost, a private network (LAN, VPN, Docker, Kubernetes) or the public internet**. The address field has an explicit http/https switch, connection problems are explained in plain language (for example "does not speak HTTPS on this port, use http://"), and `HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS` are honored. Each agent page opens with its **Agent Card URL, A2A endpoint and Agent ID** ready to copy, plus an **advertised URL** setting for when a gateway on another host has to reach the agent.

Each hop's authentication is an explicit **header name + value** you can type directly (agent → gateway, gateway → agent, registration, plus additional headers), and every gateway card shows the **equivalent curl** for each request (planned, last sent, last received) with secrets masked. See [custom-gateways.md](docs/custom-gateways.md#authentication-headers-name--value).

Credentials also accept `env:VAR_NAME` references and are masked in every API response; `GATEWAY_URL_ALLOWLIST` limits which hosts a gateway URL may point to. When a third-party gateway is active, the dashboards show the controls its operator *declares*, marked as not verified. Details: [`docs/custom-gateways.md`](docs/custom-gateways.md).

## Agent Cards and the registry

Each agent serves an A2A Agent Card at `GET /.well-known/agent-card.json` (see [`examples/agent-card-agent-b.json`](examples/agent-card-agent-b.json)). Cards carry name, description, provider, version, endpoint URL, preferred transport (JSON-RPC), capabilities, **declared** security schemes, default I/O modes and skills with tags, examples and PoC input/output schemas (`x-poc-schemas`).

On start, and every 15 s as a heartbeat, each agent `POST`s its card to `/registry/agents` with its gateway token. A **curated registry** maintains these Agent Cards and lets clients discover agents by **skill, tag, provider, name or capability**. The gateway refuses cards that are malformed, that come from an identity not on the allowlist, that try to register under someone else's ID, or that embed credentials. Agent A finds Agent B by asking the registry for `skill=vehicle_service_orchestration`.

Details: [`docs/agent-cards.md`](docs/agent-cards.md).

## A2A communication

Transport is JSON-RPC 2.0 over HTTP using A2A method names. The PoC's business envelope rides in `params.metadata.envelope` so the gateway can authorize by skill without parsing message parts.

| PoC alias | A2A method | Used for |
|---|---|---|
| `send_message`, `create_task` | `message/send` | Start a service assessment (returns a `Task`) |
| `get_task_status` | `tasks/get` | Poll a task |
| `cancel_task` | `tasks/cancel` | Cancel; Agent B releases reservations, orders and held slots |
| `push_status` | `tasks/pushNotification` (PoC) | Agent B delivers status updates to Agent A |

Envelope fields: `task_id`, `sender_agent_id`, `recipient_agent_id`, `skill`, `intent`, `payload`, `created_at`, `status`, `correlation_id`.

Example request (gateway path):

```bash
jq '.request' examples/01-telemetry-service-request.json | \
  curl -s http://localhost:4000/a2a/agent-b \
    -H 'authorization: Bearer poc-gw-token-agent-a' -H 'content-type: application/json' -d @-
```

More in [`docs/a2a-flow.md`](docs/a2a-flow.md) and [`docs/api-reference.md`](docs/api-reference.md).

### Direct vs gateway-mediated invocation

```bash
# Gateway-mediated: caller authenticates to the gateway with ITS OWN token
curl -s -X POST http://localhost:4000/a2a/agent-b \
  -H 'authorization: Bearer poc-gw-token-agent-a' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"get_task_status","params":{"id":"task_x","metadata":{"envelope":{"task_id":"task_x","sender_agent_id":"agent-a","recipient_agent_id":"agent-b","skill":"vehicle_service_orchestration","intent":"get_task_status","payload":{},"created_at":"2026-11-15T00:00:00Z","status":"submitted","correlation_id":"corr_x"}}}}'

# Direct: caller presents the TARGET's static API key (only accepted when agent-b's gateway toggle is OFF)
curl -s -X POST http://localhost:4002/a2a \
  -H 'authorization: Bearer poc-direct-key-agent-b' -H 'content-type: application/json' \
  -d '<same body>'
```

With Agent B's gateway toggle **on**, the direct call returns `403` with error code `-32012` (*gateway required*).

## Gateway enabled vs disabled

| | Gateway enabled | Gateway disabled |
|---|---|---|
| Discovery | Registry lookup by skill | Fetch Agent B's card from `AGENT_B_CARD_URL` |
| Route | `agent-a → a2a-gateway → agent-b` | `agent-a → agent-b` |
| Authentication | Bearer token mapped to an agent identity at the gateway | Static API key at the agent endpoint only |
| Sender identity | Envelope sender must equal authenticated identity | Self-asserted, unverified |
| Agent allowlist / skill authorization | Enforced (`delete_inventory` → 403) | Not applied (`delete_inventory` executes, simulated) |
| Rate limiting | 20 req / 10 s per caller (configurable) | None |
| Audit / tracing | Central audit trail, route log, `x-gateway-request-id` | Agent-local logs only |
| Agent B inbound | Only gateway-forwarded calls accepted | Direct calls with API key accepted |

The toggle takes effect immediately (no restart) and is persisted to `.runtime/agent-*.json`. Mixed modes are allowed and instructive: see [`docs/gateway-toggle.md`](docs/gateway-toggle.md). Security design and extension points (OAuth 2.0, OIDC, mTLS): [`docs/gateway-security.md`](docs/gateway-security.md).

## What is A2A-aligned and what is PoC-specific

**A2A v1.0 (current spec):** Agent Cards advertise `supportedInterfaces` (JSONRPC, protocolVersion 1.0) with v1 `securitySchemes`/`securityRequirements`; agents serve `SendMessage`, `GetTask`, `ListTasks`, `CancelTask` and the push-notification-config methods with v1 enums (`TASK_STATE_*`, `ROLE_*`) and kind-less parts; `A2A-Version` is checked; push notifications are `StreamResponse` webhooks. This is what [Bifrost](docs/bifrost.md) and other v1 gateways require. Streaming (`SendStreamingMessage`, `SubscribeToTask`), gRPC and HTTP+JSON bindings are not implemented.

**Also supported for legacy clients (v0.3.x):** Agent Card at `/.well-known/agent-card.json` with `protocolVersion`, `url`, `preferredTransport`, `additionalInterfaces`, `provider`, `capabilities`, `securitySchemes`/`security`, `defaultInputModes`/`defaultOutputModes`, `skills`; JSON-RPC 2.0 binding; `message/send`, `tasks/get`, `tasks/cancel`; `Message` with `text`/`data` parts; `Task` with `status.state` from the A2A `TaskState` set; `Artifact`; error codes `-32001` (task not found), `-32002` (not cancelable), `-32004` (unsupported operation); credentials supplied in HTTP headers, never in cards.

**PoC-specific / A2A-inspired:** the envelope in `params.metadata.envelope`; method aliases; status delivery as a `tasks/pushNotification` JSON-RPC call (the spec delivers push notifications by POSTing to a client-registered webhook and configures them via `tasks/pushNotificationConfig/*`); gateway error codes `-32010…-32050`; the registry and gateway APIs (A2A does not standardise a registry API); `x-poc-schemas`; business stages in `task.metadata.stage`. Not implemented: `message/stream`, `tasks/resubscribe`, SSE, gRPC/REST transports, authenticated extended cards. The PoC has not been run against an official A2A SDK or conformance suite, so it claims no compliance.

## Repository layout

```text
axon-fleet/
├── README.md · package.json · docker-compose.yml · Dockerfile · .env.example
├── docs/            architecture, a2a-flow, agent-cards, gateway-security, gateway-toggle, custom-gateways, bifrost, whitematter, cloudflare, api-reference, demo-script
├── examples/        Agent Cards + captured A2A payloads (npm run examples)
├── wrangler.jsonc   Cloudflare Workers config (import-ready)
├── cloudflare/      worker.js (entry + Durable Objects), shims/ (express, cors, undici on the Fetch API)
├── scripts/         start-all.mjs, capture-examples.mjs, reset-runtime.mjs, cf-smoke.mjs
├── tests/           unit, integration, gateways, network, bifrost, headers, whitematter tests; mocks/ (Bifrost, Whitematter emulators); helpers.js
└── packages/
    ├── shared/src/  a2a/ (agentCard, message, task, client, registry, agentConnectivity, gatewayAdapters,
    │                gatewayProfiles, gatewayRoutes) · telemetry/ · security/ · utils/
    ├── agent-a/src/ index, app, agent, telemetryEngine, maintenanceRules, gatewayConfig, a2aRoutes, agent-card.json
    ├── agent-b/src/ index, app, agent, inventoryService, schedulingService, partsOrderService, diagnosisRules,
    │                gatewayConfig, a2aRoutes, runtime/flowRuntime.js, adapters/a2aAdapter.js, agent-card.json
    ├── a2a-gateway/src/ index, app, registry, router, taskStore, authService, policyEngine, auditLog, routes
    ├── partner-gateway-mock/src/ app.js, index.js   (mock third-party gateway)
    └── web-dashboard/ src/server.js · public/ (pages, ds/ design tokens + components, js/ incl. gateways.js)
```

### Substitutions (documented per the brief)

- **JavaScript (ES modules) instead of TypeScript.** Every service runs with plain `node`, no build step. Types are expressed through schemas, validation functions and JSDoc. Porting to TS is mechanical.
- **Static HTML + vanilla JS dashboard instead of React/Vite.** The brief allowed a simpler frontend; this keeps the dependency list to `express` and `cors`.
- **WhiteMatter design system.** No public component library or tokens were available, so `packages/web-dashboard/public/ds/` contains a local token set and components in a clean, governance-oriented style. Fonts load from Google Fonts with system fallbacks if offline.
- **Storage.** In-memory, with the gateway toggle persisted to small JSON files.

## Limitations

- Static bearer tokens and API keys; no token rotation, no OAuth/OIDC/mTLS (extension points only).
- The gateway→agent hop trusts a shared forwarding token; production would use mTLS or signed requests.
- Dashboard `/api/*` endpoints and the gateway's read APIs are unauthenticated for local development.
- In-memory state is lost on restart; agents re-register automatically.
- Single gateway instance, fixed-window rate limiting, no persistence of the audit log (pluggable sink provided).
- No streaming (SSE) or `tasks/resubscribe`; status arrives via push or polling.
- In Docker, agents advertise container hostnames; add the partner gateway as `http://partner-gateway:4100`, and use `http://host.docker.internal:<port>` for gateways running on the host.
- Network scope is judged from the hostname/IP without DNS, so a public-looking name that resolves to a private IP is labelled public.
- Third-party gateway support is a declarative HTTP/JSON mapping. Gateways that need signed requests, OAuth token exchange or non-HTTP transports need a dedicated adapter.
- Literal credentials typed into the dashboard are persisted in `.runtime/` (masked in APIs); use `env:` references for anything real.
- The "AI" in each agent is rule-based so the demo is deterministic; `diagnosisRules.js` and `maintenanceRules.js` are the seams where an LLM or OEM service would plug in.

## Implementation checklist

| Requirement | Where |
|---|---|
| Agent A: synthetic telemetry (VIN, timestamp, odometer, SoC, drivetrain temp, tires, brake wear, fault codes, predicted maintenance) | `agent-a/src/telemetryEngine.js`, `shared/src/telemetry/generator.js` |
| Agent A local analysis | `agent-a/src/maintenanceRules.js` |
| Agent B inventory, mechanics, bays, appointments, parts orders | `agent-b/src/inventoryService.js`, `schedulingService.js`, `partsOrderService.js` |
| Agent B on a distinct runtime with adapter layer | `agent-b/src/runtime/flowRuntime.js`, `adapters/a2aAdapter.js` |
| Agent Cards at `/.well-known/agent-card.json`, no secrets | `*/src/agent-card.json`, `shared/src/a2a/agentCard.js` |
| Gateway registry: register, discover (skill/tag/name/capability/provider), card retrieval, routing, health, logging | `a2a-gateway/src/*` |
| Envelope + `send_message` / `create_task` / `get_task_status` / `cancel_task` | `shared/src/a2a/message.js` |
| Async task progression | `agent-b/src/agent.js` (DealerFlow stages), `partsOrderService.js` (placed → confirmed → in_transit) |
| Direct + gateway endpoints on both agents, curl examples | `a2aRoutes.js` in each agent; this README; `docs/api-reference.md` |
| Gateway toggle on both dashboards, immediate, persisted, resettable, badges, warnings | `shared/src/a2a/agentConnectivity.js`, `web-dashboard/public/js/common.js` |
| Gateway security: token auth, allowlist, skill authz, validation, rate limit, audit, tracing, identity binding | `a2a-gateway/src/router.js`, `shared/src/security/*` |
| OAuth 2.0 / OIDC / mTLS extension points | `shared/src/security/auth.js`, `docs/gateway-security.md` |
| Agent A, Agent B and Gateway dashboards with all listed panels | `web-dashboard/public/*.html`, `public/js/*.js` |
| Mermaid architecture + two sequence diagrams | this README, `docs/a2a-flow.md` |
| Example payloads (service request, inventory check, reservation, order, appointment, status) | `examples/` |
| Demo script | `docs/demo-script.md` |
| Tests for every listed area | `tests/unit.test.js`, `tests/integration.test.js` |
| Custom gateway URL at runtime (add, edit, test, route through, remove) | `shared/src/a2a/gatewayProfiles.js`, `gatewayRoutes.js`, `web-dashboard/public/js/gateways.js` |
| A2A v1.0 cards and JSON-RPC methods, v1 push notifications, Bifrost gateway profile | `shared/src/a2a/v1.js`, `v1Server.js`, `gatewayAdapters.js`, `agent-b/src/a2aV1.js`, `docs/bifrost.md`, `tests/bifrost.test.js` |
| Explicit auth header name/value per hop, additional headers, equivalent curl (planned / sent / received) | `shared/src/a2a/gatewayHeaders.js`, `curl.js`, `gatewayAdapters.js#plannedRequests`, `web-dashboard/public/js/gateways.js`, `tests/headers.test.js` |
| Whitematter A2A Gateway compliance (caller keys, gateway task IDs, skill_id, push relay / -32003 fallback, -31xxx errors) | `gatewayAdapters.js` (Whitematter type), `agent-a/src/agent.js`, `agent-b/src/a2aV1.js`, `docs/whitematter.md`, `tests/whitematter.test.js` |
| Cloudflare Workers deployment (dashboard import), Durable Objects, smoke test | `wrangler.jsonc`, `cloudflare/`, `scripts/cf-smoke.mjs`, `docs/cloudflare.md` |
| HTTP and HTTPS gateways on localhost, private and public networks; proxy/CA support; diagnostics | `shared/src/utils/network.js`, `tests/network.test.js` |
| Copyable Agent Card URL / endpoint / ID, advertised URL, peer card URL | `shared/src/a2a/identityRoutes.js`, `web-dashboard/public/js/identity.js` |
| Registration with third-party A2A gateways (multiple at once, configurable API mapping) | `shared/src/a2a/gatewayAdapters.js`, `agentConnectivity.js`, `packages/partner-gateway-mock`, `tests/gateways.test.js` |
| `.env.example`, root start script, docker-compose, health checks, CORS, structured logs | repo root, `scripts/start-all.mjs`, `shared/src/utils/*` |
