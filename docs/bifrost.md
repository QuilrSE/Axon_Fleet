# Using Bifrost as the A2A gateway

In the dashboard, this gateway type is listed as **Dummy A2A Gateway** (Gateway type), and its template is still named *Bifrost Agent Gateway*.

[Bifrost](https://docs.getbifrost.ai/features/agent-gateway) Agent Gateway proxies **A2A v1** only. Both agents now:

- publish an A2A v1 card: `supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]`, v1 `securitySchemes` / `securityRequirements` (the old v0.3 fields stay alongside unless you pick *strict v1*);
- serve A2A v1 JSON-RPC on the same `/a2a` endpoint: `SendMessage` (blocking or `returnImmediately`), `GetTask`, `ListTasks`, `CancelTask`, the `*TaskPushNotificationConfig` methods, `A2A-Version` checks (`-32009` for unsupported versions); v0.3 methods keep working for the built-in gateway;
- deliver status as **standard v1 push notifications** (a `StreamResponse` POSTed to the webhook from `taskPushNotificationConfig`, which Bifrost relays via `/agents/a2a/<name>/push/callback`); Agent A also polls `GetTask` as a fallback;
- talk to Bifrost through a **Bifrost gateway profile**: virtual key in `x-bf-vk`, calls to `/agents/a2a/<name>/json-rpc` with `A2A-Version: 1.0`, discovery through Bifrost's served cards, and either self-registration through `POST /api/agents` or verification of a manual registration.

## Why the original error happened

`Upstream agent card has no strict A2A v1 interface the gateway can proxy` — the cards were written in A2A v0.3 (`url` + `preferredTransport`). Bifrost reads only `supportedInterfaces` and keeps entries with a v1 `protocolVersion` and a `JSONRPC`, `HTTP+JSON` or `GRPC` binding. The cards now include that.

## Setup: Bifrost in Docker on `localhost:8080`, agents on the host (`npm start`)

### 1. Start the agents with Bifrost credentials

```bash
export BIFROST_VIRTUAL_KEY=sk-bf-...          # a Bifrost virtual key allowed to call the agents
export BIFROST_FORWARD_TOKEN=bifrost-forward-token   # what Bifrost will send to the agents (any secret you choose)
# Optional, lets the agents register themselves (otherwise register by hand in step 4).
# See "Self-registration" below for which one applies to your Bifrost:
export BIFROST_ADMIN_CREDENTIALS='admin:your-admin-password'
npm start
```

### 2. Make the agents reachable from the Bifrost container

Inside the container, `localhost` is Bifrost itself. On **both** agent dashboards open **Connection details → URL other systems use to reach this agent** and pick the suggestion:

- Agent A: `http://host.docker.internal:4001`
- Agent B: `http://host.docker.internal:4002`

The card now advertises `http://host.docker.internal:400x/a2a`, and Agent A's push webhook becomes `http://host.docker.internal:4001/a2a/push`. On Linux, start Bifrost with `--add-host=host.docker.internal:host-gateway`.

### 3. Configure Bifrost (Agents → Agent Settings)

- **External Client URL**: `http://localhost:8080`. Bifrost uses it in the cards it serves and in push-callback URLs. The agents run on the host, so they reach Bifrost there. Without it, the gateway endpoints return 503.
- **Private Network Allowlist**: add `host.docker.internal`. Bifrost blocks private destinations by default and checks the resolved address, so if calls are still blocked, also add the address it resolves to (Docker Desktop usually `192.168.65.254`; Linux `172.17.0.1`).

### 4. Register the agents in Bifrost

**Automatic** (if you exported a management credential): skip ahead to step 5. Adding the Bifrost gateway on each dashboard registers the agent through `POST /api/agents` with the card URL above and request authentication `Authorization: Bearer $BIFROST_FORWARD_TOKEN`.

**Manual** (Agents → Agent Catalog → New Agent), for each agent you want callable through Bifrost (at minimum `agent-b`):

| Field | Agent B | Agent A |
|---|---|---|
| Name | `agent-b` | `agent-a` |
| Agent card URL | `http://host.docker.internal:4002/.well-known/agent-card.json` | `http://host.docker.internal:4001/.well-known/agent-card.json` |
| Request authentication | header `Authorization` = `Bearer bifrost-forward-token` (your `BIFROST_FORWARD_TOKEN`) | same |
| Access | grant your virtual key, or turn on *Allow any virtual key* | same |

If you use other names in Bifrost, set **Bifrost agent names** on the gateway profile (for example `agent-b=dealership`).

### 5. Add Bifrost on both dashboards

On **Agent A** and **Agent B**: **A2A gateways → Add a gateway → Start from: Bifrost Agent Gateway**. The template fills `http://localhost:8080`, `x-bf-vk = env:BIFROST_VIRTUAL_KEY`, `env:BIFROST_FORWARD_TOKEN` and management auth. Choose *Manual registration* if you registered by hand. Tick **Route traffic through this gateway** and save.

The gateway card should show **A2A v1.0**, **registered (API)** or **listed (manual)**, and **healthy**. **Test** fetches Bifrost's served card for each agent.

### 6. Send a request

Generate telemetry on Agent A and send it. The route reads `agent-a → bifrost → agent-b`. The raw request viewer shows `SendMessage` with `A2A-Version: 1.0`, and the timeline fills in from pushes relayed by Bifrost, or from polling if the webhook cannot be reached. The calls appear in Bifrost's Agent Logs.

## Self-registration (management auth)

With management auth, each agent creates its own registration through `POST /api/agents` and keeps it in sync. It sends the card URL (the advertised URL), request authentication `Authorization: Bearer $BIFROST_FORWARD_TOKEN`, *Allow any virtual key* (checkbox) and optional virtual key IDs. After that, a heartbeat only checks `GET /api/agents/<name>`. The agent re-sends the registration only when something changes (for example the advertised URL), when you click **Register now**, or when the registration was deleted in Bifrost. An existing manual registration with the same name is taken over (`POST` reports it exists, so the agent uses `PUT`).

| Your Bifrost | Management auth (gateway form) | Credential | Notes |
|---|---|---|---|
| OSS, dashboard login enabled | **Admin username:password** (template default) | `env:BIFROST_ADMIN_CREDENTIALS` = `admin:password` | Admin bypasses permission checks. Works with private addresses. |
| Enterprise | **Management API key** | `env:BIFROST_MANAGEMENT_KEY` | Create in **Settings → API Keys** with scopes `AgentGateway:Create`, `AgentGateway:Update`, `AgentGateway:View` (add `AgentGateway:Delete` if removing the gateway should delete the registration). |
| OSS, no dashboard login | **Setup token** | `env:BIFROST_SETUP_TOKEN` (the server's `setup_token` / `BIFROST_SETUP_TOKEN`) | Bifrost only uses the Private Network Allowlist for dashboard-authenticated operations, so `host.docker.internal` agents cannot be registered this way. Enable dashboard login and use admin credentials. |

Steps:
1. Export the credential (above) in the shell that runs `npm start`, or put it in `.env`, and restart.
2. On each dashboard, **Edit** the Bifrost gateway, set **Management auth** and **Management credential** as in the table, keep **Allow any virtual key** ticked (or list virtual key IDs), and **Save**.
3. The gateway card shows **registered (API)** and *Bifrost registration "agent-b": created / updated*. Click **Register now** after changing settings in Bifrost by hand, because the agent's settings overwrite them.

Session tokens also work as Bearer credentials but expire, so they are a poor fit for a long-running agent. Virtual keys (`sk-bf-…`) are refused on management APIs.

## Seeing exactly which headers are sent

Open **Equivalent curl** on the Bifrost gateway card:
- *Register agent-x (Bifrost management API)*: the management header and the `runtime_auth` header Bifrost will send to the agent.
- *Call agent-y through Bifrost*: the virtual-key header (and any additional headers) the agent sends to Bifrost.
- *What Bifrost must send to agent-x*: the header the agent accepts. Run it (after **Reveal secrets**) to test the agent directly; it answers `-32001 Task not found` when authentication works.
- On Agent B, *Last received from this gateway* shows what Bifrost actually sent.

You can type every value (virtual key, admin credentials, forwarding header) directly in the form instead of using env vars.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Parse upstream agent card: json: cannot unmarshal object into Go struct field .0.schemes.bearer of type a2a.SecuritySchemeScopes` | Fixed: restart the agents on this version. The card now writes security scopes as arrays (`"bearer": []`). A2A Go SDK releases before v2.6.0, which Bifrost bundles, cannot decode the canonical `{"list": []}` form. |
| `no strict A2A v1 interface` | Restart the agents on this version; open the card URL and check `supportedInterfaces`. |
| Registration error mentioning private/blocked destinations | Add `host.docker.internal` (and its resolved IP) to the Private Network Allowlist. |
| `503` from Bifrost endpoints | Set External Client URL. |
| *did not accept the admin credentials* / *setup token* / *management token* | Wrong credential for the chosen management auth; see the table in *Self-registration*. If dashboard login is on, the setup token stops working. |
| *Authenticated, but not permitted (HTTP 403)* | Enterprise API key is missing `AgentGateway:Create` / `:Update` / `:View`. |
| `401` on registration check, calls or served card | The key was not accepted at all. Most often `BIFROST_VIRTUAL_KEY` is not set in the shell that runs `npm start`, so no key is sent (the gateway card now says so). Otherwise the key is mistyped, disabled, or from another Bifrost. |
| `403` | The key is valid but not granted on that agent's registration. Grant it, or turn on *Allow any virtual key*. |
| `failed to send HTTP request: Post "http://host.docker.internal:4002/a2a": unexpected upstream HTTP status: 401 Unauthorized` | Agent B rejected the credential Bifrost sent. Open Agent B → Security & audit events (or its log line `inbound_auth_rejected`):<br>• *No Authorization header was sent* → set the registration's request authentication: header `Authorization`, value `Bearer <BIFROST_FORWARD_TOKEN>`.<br>• *token not recognised … received … accepted …* → the fingerprints (last 4 chars + length) show which token arrived and which Agent B expects; make them the same, then restart the agents if you changed the env. A doubled `Bearer Bearer` or a bare token is accepted. |
| Timeline only updates every ~2.5 s | Pushes are not reaching `http://host.docker.internal:4001/a2a/push`; polling is covering. Check the allowlist and Agent A's advertised URL. |
| Bifrost rejects the card for unknown fields | Switch **Agent Card format** to *Strict A2A v1.0 only* on that agent. |

## What was tested

`tests/bifrost.test.js` runs both agents against an **emulation** of Bifrost written from its public docs (`tests/mocks/bifrostMock.js`):
- a strict v1 card check that reproduces the original error for v0.3 cards;
- registration via `/api/agents`;
- served-card discovery;
- v1-only JSON-RPC with a virtual key;
- runtime auth headers;
- push relay through `/push/callback`.

The card JSON and every v1 payload (`SendMessage` request, `SendMessage` result, push `StreamResponse`s, `Task`) were also decoded with the real A2A Go SDK, both at the release before v2.6.0 and at v2.8.0. `tests/fixtures/a2a-go-sendmessage-params.json` is the SDK's own encoding of a request, as a Go-based gateway forwards it, and Agent B is tested against it.

The emulation is not Bifrost. Confirm against your container, and if something differs, the request viewer on each dashboard shows the exact wire traffic.
