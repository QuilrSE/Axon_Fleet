# Custom and third-party A2A gateways

Each agent keeps a list of **gateway profiles**. Every profile can do two independent jobs:

| Job | Setting | Effect |
|---|---|---|
| **Publish** | `registerEnabled` (checkbox "Register this agent's card") | The agent registers its Agent Card with that gateway on start, every `REGISTRATION_INTERVAL_MS`, and on demand. Any number of profiles can publish at once. |
| **Route** | "Route through this" (the *active* profile) | While the A2A Gateway switch is on, discovery, outbound tasks and status pushes go through this gateway. Exactly one profile is active. |

So an agent can stay listed on the built-in gateway, a partner exchange and a corporate registry at the same time, while routing traffic through only one of them. The A2A Gateway toggle still decides gateway-mediated vs direct; the profile decides *which* gateway.

The first profile, `a2a-gateway`, is built from `.env` (`GATEWAY_URL`, `AGENT_*_GATEWAY_TOKEN`, `GATEWAY_FORWARD_TOKEN`). You can edit its URL, add more profiles, or restore the default list.

## Authentication headers (name + value)

Every hop between an agent and a gateway is configured as an explicit HTTP header in **A2A gateways → Add/Edit → Authentication headers**:

| Hop | Fields | Sent / checked |
|---|---|---|
| **Agent → gateway** | Mode (*Header name + value*, *Bearer token*, *None*), header name, value | Sent on every call to the gateway. *Header name + value* sends the value exactly as typed (e.g. `x-bf-vk: sk-bf-…`); *Bearer token* sends `Authorization: Bearer <value>`. |
| **Gateway → agent** | Header name (default `Authorization`), value | The header the gateway must send when it forwards to this agent. Custom headers (e.g. `X-Agent-Secret`) are matched exactly. An `Authorization` value without a scheme is treated as a Bearer token. For Bifrost this exact header becomes the registration's request authentication. |
| **Registration** (Bifrost) | Management auth (admin user:pass, API key, setup token, *Custom header name + value*, manual), header name, value | Sent to the gateway's management API when the agent registers itself. |
| **Additional headers** | Any number of name/value rows (max 10) | Sent on every call to the gateway (tenant, routing, tracing headers). |

Values are typed directly. They are stored on the agent (`.runtime/`), masked in every API response, and kept when you save an edit with the field left blank. `env:VAR_NAME` is still accepted if you prefer the environment. Header names are validated, values may not contain line breaks (header injection), and agent-managed headers (`Host`, `Content-Type`, `A2A-Version`, …) cannot be overridden.

## Equivalent curl

Each gateway card has **Equivalent curl**, and the add/edit form has a live preview:

- **Planned requests**: what the agent will send to the gateway (health, register, discover, call through the gateway) and **what the gateway must send to this agent**, as runnable curl commands.
- **Last sent to the gateway**: the exact requests the agent made, with status and time.
- **Last received from this gateway**: the headers the gateway actually sent and the agent accepted.
- **Last rejected inbound request**: from any sender, shown with fingerprints only (`<received …abcd, 17 chars>`), never revealed.

Secrets are never shown by default. Values from `env:VAR` render as `${VAR}`, so the command runs unchanged in a shell where the variable is set. Literal values render as `••••abcd` until you click **Reveal secrets** (confirmation required; logged as a security event). Set `DASHBOARD_ALLOW_SECRET_REVEAL=false` to disable revealing.

API: `GET /api/gateways/<id>/curl[?reveal=1]`, `POST /api/gateways/curl-preview` (an unsaved form; nothing is stored).

## HTTP and HTTPS, localhost, private and public gateways

Gateways can be anywhere the agent can open a TCP connection to:

| Where the gateway runs | Example address | Notes |
|---|---|---|
| Same machine | `localhost:4100`, `http://127.0.0.1:4100` | http is normal here |
| Docker host, agent in a container | `http://host.docker.internal:4100` | compose maps `host.docker.internal` for both agents |
| Same compose network | `http://partner-gateway:4100` | service name |
| LAN / VPN / data centre | `http://10.0.4.12:8080`, `https://a2a.corp.internal` | private CA: set `NODE_EXTRA_CA_CERTS` |
| Public internet | `https://a2a.partner.example` | behind a proxy: set `HTTPS_PROXY` and `NO_PROXY` |

**Protocol.** The dashboard's address field has an explicit **http / https** switch, defaulting to **http**, and the agent never upgrades http to https. Paste a full URL and the switch follows it. Through the API, an explicit `http://`/`https://` or a `scheme` field always wins; a bare `host:port` becomes http for localhost/private hosts and https for public hosts.

**Network scope** is shown on every gateway as *localhost*, *private network* or *public internet* (judged from the name/IP, without DNS lookups), together with an HTTP/HTTPS chip.

**Policy switches** (env): `GATEWAY_ALLOW_PRIVATE_NETWORKS` (default `true`), `GATEWAY_REQUIRE_HTTPS_FOR_PUBLIC` (default `false`), `GATEWAY_URL_ALLOWLIST`.

**TLS.** For a private CA use `NODE_EXTRA_CA_CERTS`. For a dev gateway with a self-signed certificate, tick *Skip TLS certificate verification* on that gateway only (`tlsSkipVerify: true`); the gateway card then shows a warning.

**Diagnostics.** Connection failures are explained in plain language on the gateway card, for example:
- *"https://localhost:4100 does not speak HTTPS on this port. Use http:// instead."*
- *"Connection refused … If this agent runs in Docker, "localhost" is the container itself; use host.docker.internal …"*
- *"Cannot resolve host …"*, *"TLS certificate not trusted …"*, *"Gateway redirected … (it wants https://)"*
- *"Port 6000 is on the WHATWG fetch blocked-port list …"*

Writes are not auto-redirected, so a POST is never silently replayed as a GET after an http→https redirect.

## Making the agent reachable from the gateway

A gateway calls the agent at the URL in its **Agent Card**. By default that is `http://localhost:4001` / `:4002`, which only works when the gateway is on the same machine. Each agent dashboard has a **Connection details** panel showing, with copy buttons:

- the **Agent Card URL** (paste this into a gateway's registry or portal),
- the **A2A endpoint**,
- the **Agent ID**,
- on Agent A, **Agent B's card URL** used in direct mode (editable).

Under *URL other systems use to reach this agent*, set an **advertised URL**: a LAN address, `http://host.docker.internal:4001`, a compose service name, or a public/tunnel URL. The panel suggests the machine's own addresses. Saving updates the Agent Card and re-registers with every gateway. Listening addresses do not change. If a gateway is on another host while the card still advertises `localhost`, the gateway card warns that the gateway cannot reach the agent.

API: `GET /api/identity`, `PUT /api/identity { advertisedBaseUrl, peerCardUrl }`, `POST /api/identity/check-peer`.

## Adding a gateway in the dashboard

On either agent dashboard, open **A2A gateways → Add a gateway**.

1. **Start from** a template: the built-in PoC gateway, the mock *Partner A2A Exchange*, or blank.
2. Set **Name**, choose **http** or **https**, and enter the address (`host:port` plus an optional base path). The line under the field shows the exact URL and network scope. Set **Gateway type**:
   - *PoC A2A Gateway*: speaks this repo's gateway API; only URL and credentials are needed.
   - *Third-party*: uses the **API mapping** section to adapt to the other gateway's API.
3. **Credential the agent sends**: what the agent presents to the gateway (bearer token or API key header).
4. **Credential the gateway forwards with**: what the gateway presents when it delivers requests *to* this agent. The agent accepts inbound calls from any configured profile that has one. **Caller identity header** is where that gateway puts the authenticated caller ID (`x-a2a-caller` for ours, `x-partner-caller` for the mock).
5. Tick **Register** and/or **Route traffic through this gateway**, then **Save gateway**. The result shows registration and health immediately; **Test** checks health and runs a discovery call.

To route an end-to-end flow through a different gateway, configure it on **both** agents: each one authenticates to the gateway with its own credential, and the gateway must know both agents to route requests one way and status updates the other.

## API mapping for third-party gateways

Placeholders: `{agentId}`, `{skill}`, `{tag}`. Empty query parameters are dropped.

Set **Wire protocol** to *A2A v1.0* for gateways that require v1 method names. For Bifrost and QuilrAI use their dedicated gateway types instead ([bifrost.md](bifrost.md), [quilr.md](quilr.md)).

| Field | Meaning | Built-in default | Generic default |
|---|---|---|---|
| `authScheme` | `bearer`, `api-key`, `none` | bearer | bearer |
| `authHeader` | Header for `api-key` | — | `x-api-key` |
| `registerMethod` / `registerPath` | Card registration call | POST `/registry/agents` | POST `/agents` |
| `registerBody` | `envelope` = `{agentId, agentCardUrl, card}`; `card` = the raw Agent Card; `cardUrl` = `{agentId, agentCardUrl}` for gateways that fetch the card themselves | envelope | envelope |
| `deregisterPath` | DELETE on removal (blank = skip) | `/registry/agents/{agentId}` | — |
| `discoverPath` | Discovery query | `/registry/agents?skill={skill}` | `/agents?skill={skill}` |
| `resultsPath`, `agentIdField` | Where the list is in the response and which field is the agent ID (dotted paths allowed). Blank = auto-detect `agents`/`items`/`results`/`data` and `agentId`/`id`/`name` | agents / agentId | auto |
| `invokePath` | Where A2A JSON-RPC is POSTed for a target | `/a2a/{agentId}` | `/agents/{agentId}/a2a` |
| `healthPath` | Health probe | `/health` | `/health` |
| `declaredControls` | Controls the operator says the gateway enforces | all | `authentication` |

The adapter lives in `packages/shared/src/a2a/gatewayAdapters.js`. Gateways that need more than a mapping (request signing, OAuth token exchange, gRPC, mTLS) get a new entry in `KIND_DEFAULTS` plus custom code in `createGatewayAdapter`. That is also where a dedicated adapter for a production gateway would go.

## Security model

- **Credentials** may be literal values or `env:VAR_NAME` references. Literal values are stored in the agent's runtime file (`.runtime/agent-*.json`, git-ignored) and are always **masked** in API responses (`••••1234`). Editing a profile with a blank or masked credential keeps the stored one. Prefer `env:` references outside a demo.
- **URL checks**: http(s) only, no `user:pass@` in URLs, an optional host allowlist (`GATEWAY_URL_ALLOWLIST=gw.corp.example,localhost`) and the private/public policy switches above. Set the allowlist in any shared environment: a gateway URL makes the agent send requests (and its credentials) to that host.
- **Cards** are validated before registration by our gateway and by the mock; neither accepts embedded credentials.
- **Declared vs verified controls.** For the built-in gateway the dashboards list controls this PoC actually enforces. For a third-party gateway they show what the operator *declares*, labelled "declared by operator, not verified by this agent", and the routing strip shows only those. Use the security probes to check behaviour for yourself.
- The dashboard management API is unauthenticated, like the rest of the PoC's `/api/*`. Protect it before using this outside a laptop.

## The mock third-party gateway

`packages/partner-gateway-mock` ("Partner A2A Exchange", port 4100) starts with `npm start`. It deliberately looks different from the built-in gateway:

| | PoC A2A Gateway | Partner A2A Exchange (mock) |
|---|---|---|
| Auth | `Authorization: Bearer` | `X-API-Key` |
| Register | `POST /registry/agents` `{agentId, card}` | `PUT /v1/agents/{agentId}` raw card |
| Discover | `GET /registry/agents?skill=` → `{agents:[…]}` | `GET /v1/agents?skill=` → `{items:[{id,…}]}` |
| Invoke | `POST /a2a/{agentId}` | `POST /v1/agents/{agentId}/rpc` |
| Caller header to agents | `x-a2a-caller` | `x-partner-caller` |
| Controls | authn, allowlist, skill authz, identity binding, validation, rate limit, audit, tracing | authn, identity binding, audit only |

Its audit list is at `GET http://localhost:4100/v1/audit`.

## REST API (both agents)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/gateways` | Profiles (masked), status, active ID, presets, enums |
| POST | `/api/gateways` | Profile fields; `activate: true` to route through it. Registers immediately if `registerEnabled` |
| PUT | `/api/gateways/:id` | Partial update; blank/masked credentials are kept |
| DELETE | `/api/gateways/:id` | Removes and deregisters; the active profile falls back to the first remaining one |
| POST | `/api/gateways/:id/activate` | Route through this gateway |
| POST | `/api/gateways/:id/register` | Register now |
| POST | `/api/gateways/:id/test` | Health + discovery; optional `{ skill }` |
| POST | `/api/gateways/reset` | Restore the default list from `.env` |

Example: add a third-party gateway to Agent A and route through it.

```bash
curl -s -X POST localhost:4001/api/gateways -H 'content-type: application/json' -d '{
  "name": "Partner A2A Exchange", "kind": "generic", "url": "http://localhost:4100",
  "authScheme": "api-key", "authHeader": "x-api-key", "credential": "env:AGENT_A_PARTNER_GATEWAY_KEY",
  "inboundCredential": "env:PARTNER_GATEWAY_FORWARD_TOKEN", "callerHeader": "x-partner-caller",
  "registerMethod": "PUT", "registerPath": "/v1/agents/{agentId}", "registerBody": "card",
  "deregisterPath": "/v1/agents/{agentId}", "discoverPath": "/v1/agents?skill={skill}",
  "invokePath": "/v1/agents/{agentId}/rpc", "healthPath": "/healthz", "resultsPath": "items", "agentIdField": "id",
  "declaredControls": ["authentication", "sender_binding", "audit"], "activate": true }'
```

Repeat for Agent B (`localhost:4002`, `env:AGENT_B_PARTNER_GATEWAY_KEY`).

Pointing at a gateway on another host only needs a URL change, e.g. `"url": "https://a2a.partner.example"`, with that gateway's credentials and mapping.
