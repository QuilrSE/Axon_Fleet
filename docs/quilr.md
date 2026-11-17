# Using the QuilrAI A2A Gateway

Source: [docs.quilrai.dev, A2A Gateway: How it works](https://docs.quilrai.dev/a2a-gateway/get-started/a2a-gateway). Both agents are built to that contract. The automated tests run them against an emulator written from that page (`tests/mocks/quilrMock.js`, `tests/quilr.test.js`). It is not Quilr itself, so confirm against your tenant.

## The 401 "missing A2A caller key"

Quilr authenticates **every** caller request with a caller key (`sk-quilr-a2a-…`, shown once when you create it under Callers), sent as `Authorization: Bearer sk-quilr-a2a-…` or `X-Quilr-A2A-Key: sk-quilr-a2a-…`. The generic gateway type sent no key on its health checks and appended paths Quilr doesn't have. The **QuilrAI A2A Gateway** type below sends the key on every request and uses Quilr's real endpoints.

## Setup (agents deployed on Cloudflare)

Quilr calls agents **only over HTTPS on public addresses** and never follows redirects. Push webhooks have the same rule. Use the Cloudflare deployment (`docs/cloudflare.md`), or put local agents behind a public HTTPS tunnel. Below, `https://<worker>` is your `*.workers.dev` URL.

### 1. Quilr console: register the agents

| | Agent B (the service agent: required) | Agent A (only if others call it) |
|---|---|---|
| Kind | Card URL | Card URL |
| Card URL | `https://<worker>/agent-b/.well-known/agent-card.json` | `https://<worker>/agent-a/.well-known/agent-card.json` |
| Outbound auth | **Bearer token**: a secret you choose, e.g. `quilr-forward-token` | same |
| Skill-routed | optional (Agent A always sends `skill_id`) | optional |
| Require signed card | **off** (the agents don't sign cards) | off |

The slug Quilr shows (e.g. `in-vehicle-telemetry-driver-assistant-agent`) goes into the dashboards in step 3.

**Card drift:** after approval, changing an agent's advertised URL or card format changes its card's interfaces. That counts as **high-severity drift**, so approve the pending version in Quilr.

### 2. Quilr console: caller and grants

- Create a **caller** for Agent A (optionally *bound* to Agent A), and copy its key.
- **Grant** it Agent B with methods `SendMessage`, `GetTask`, `CancelTask` and the push-notification-config methods, and skill `vehicle_service_orchestration` (or all skills).
- So the dashboard can verify Agent A's own registration, also grant the caller Agent A, or leave "Verify registration" off.
- Optional: in **Gateway settings**, turn on push notifications. Without push, Agent A polls `GetTask`; with it, every stage shows live.

### 3. Agent dashboards: add the QuilrAI gateway

**Agent A** → A2A gateways → Add a gateway → Start from **QuilrAI A2A Gateway**:
- **Gateway address:** https + paste any agent URL from Quilr, e.g. `guardrails-usa-1.quilr.ai/a2a/tadc5ab68a5195659/in-vehicle-telemetry-driver-assistant-agent`. The organization base and that agent's slug are filled in for you.
- **Agent → gateway:** *Bearer token*, value `sk-quilr-a2a-…`. Or *Header name + value* with `X-Quilr-A2A-Key`.
- **Gateway → agent:** `Authorization` = `Bearer quilr-forward-token`, the same value as the agents' outbound auth in Quilr.
- **Agent B slug in Quilr:** Agent B's slug.
- **Push notifications:** Auto.
- Tick **Route traffic through this gateway**.

**Agent B** → the same template:
- **Agent → gateway:** *No authentication*. Agent B never calls through Quilr. Use a caller key only if you want "Verify registration".
- **Gateway → agent:** the same `Authorization: Bearer quilr-forward-token`.
- Routing doesn't matter for Agent B. Its status updates go to the relay URL Quilr hands it.

Open **Equivalent curl** on the gateway card to see every request: catalog, card check, the call to Agent B, and what Quilr must send to the agent. **Reveal secrets** and run *Call agent-b through QuilrAI*: `-32001 Task not found` means key, grant, routing and outbound auth all work.

### 4. Send telemetry

The route reads `agent-a → quilrai-a2a-gateway → agent-b`. Agent A tracks the task under Quilr's task ID, and Quilr's request ID appears in the security events for support.

## Compliance matrix

| Quilr requirement (doc) | Agent A (caller) | Agent B (target) |
|---|---|---|
| Caller key as `Authorization: Bearer` or `X-Quilr-A2A-Key` | sent on every request (catalog, cards, calls) | n/a |
| Endpoints `/a2a/{org}/{agent}`, `…/.well-known/agent-card.json`, `/a2a/{org}/catalog` | used for calls, verification, discovery | serves a public A2A 1.0 card (`supportedInterfaces` JSONRPC 1.0, plus 0.3 fields) |
| Version from `A2A-Version`; 1.0 method names | sends `A2A-Version: 1.0`, `SendMessage`/`GetTask`/`CancelTask` | serves 1.0 and 0.3; rejects other versions with `-32009` |
| Gateway-issued task/context IDs; owner-only access | adopts the returned task ID; sends no client context ID | n/a (its own IDs stay behind Quilr) |
| Skill-routed: `message.metadata.skill_id` | always sent | acts only on the named skill; unknown skills get `-32004` |
| Outbound auth (Bearer or API-key header) added by Quilr; caller key never forwarded | n/a | accepts the configured header; everything else gets 401 with a fingerprint diagnosis |
| Push: HTTPS public webhook, `url`/`token`/`authentication`; `-32003` when off | attaches a webhook only when it is public HTTPS (*Auto*); on `-32003`, resends without one and polls | posts `StreamResponse` updates in order to Quilr's relay with Quilr's credentials |
| Retries, ordered delivery | webhook is idempotent; late or duplicate updates are ignored | n/a |
| `X-Quilr-A2A-Chain` + `baggage` | not needed (starts chains) | recorded per task; Agent B makes no onward gateway calls, so nothing to propagate |
| HTTPS, public addresses, no redirects | warns when the agent is not public HTTPS | Cloudflare deployment is public HTTPS |
| `-31xxx` errors, `X-Quilr-Request-Id` | explained in plain language with the request ID | n/a |
| Streaming | not used | card declares `streaming: false`; streaming methods get `-32004` |
| Extended card | n/a | `extendedAgentCard: false`; `GetExtendedAgentCard` gets `-32007` |

**Not implemented** (all optional in Quilr):
- signing agent cards (keep *Require signed card* off);
- sending an end-user token (add `X-Quilr-User-Token` as an *Additional header* if you need it);
- the HTTP+JSON binding (Quilr converts from JSON-RPC).

## Troubleshooting

| Gateway card says | Meaning / fix |
|---|---|
| *caller key is missing, invalid…* (`-31401`) | Wrong or missing key, or wrong header name. Only `Authorization: Bearer` and `X-Quilr-A2A-Key` are accepted. |
| *not visible to this caller key* / `-31404` | The caller has no grant for that agent, or the slug is wrong. Agents without a grant are invisible. |
| *grant does not allow this method or skill* (`-31403`) | Add the method or skill to the grant; for skill-routed agents check `skill_id`. |
| *card unapproved* (`-31409`) | Approve the agent's card (or its pending drift) in Quilr. |
| *could not reach the agent* (`-31502`) | The card URL must be public HTTPS, and Quilr's outbound auth must equal the agent's gateway → agent header. Agent B's security events show what arrived. |
| Timeline updates in jumps | No webhook (push off, or the agent is not public HTTPS); Agent A is polling. |
