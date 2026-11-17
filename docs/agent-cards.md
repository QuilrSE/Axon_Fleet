# Agent Cards and registration

## Serving

Both agents serve their card at `GET /.well-known/agent-card.json`. Templates live in `packages/agent-*/src/agent-card.json`; `{{BASE_URL}}` and `{{VERSION}}` are filled at request time by `buildAgentCard`, so the card always matches the URL the agent was started with.

## Fields

| Field | Purpose |
|---|---|
| `protocolVersion` | A2A protocol version the card targets (`0.3.0`) |
| `name`, `description`, `version` | Identity |
| `provider.organization`, `provider.url` | Who operates the agent (fictional here) |
| `url`, `preferredTransport`, `additionalInterfaces` | Service endpoint and transport (JSON-RPC over HTTP) |
| `capabilities` | `streaming: false`, `pushNotifications`, `stateTransitionHistory` |
| `securitySchemes`, `security` | **Declared** auth: `gatewayBearer` and `directApiKey` (HTTP bearer). No values. |
| `defaultInputModes`, `defaultOutputModes` | MIME types |
| `skills[]` | `id`, `name`, `description`, `tags`, `examples`, `inputModes`, `outputModes`, plus PoC `x-poc-schemas` with input/output hints |

Agent B advertises `vehicle_service_orchestration`. Agent A advertises `service_status_updates` and `vehicle_telemetry_query`. Agent B also implements a hidden admin skill, `delete_inventory`, that is **not** in its card; it exists only to demonstrate skill-level authorization.

## No secrets in cards

Cards declare *which* schemes are accepted. Credentials travel only in the `Authorization` header and are provisioned out of band (`.env`). `validateAgentCard` rejects any card that has credential-like keys (`token`, `apiKey`, `secret`, `password`, …) with string values, or that contains any configured credential value. The gateway runs this check on every registration.

## Registration

```http
POST /registry/agents
Authorization: Bearer <the agent's gateway token>

{ "agentId": "agent-b", "agentCardUrl": "http://localhost:4002/.well-known/agent-card.json", "card": { … } }
```

The gateway checks that the token's identity equals `agentId`, that the agent is on the allowlist, and that the card is valid and secret-free. Agents re-post every `REGISTRATION_INTERVAL_MS` (heartbeat), retry every 3 s until registered, and re-register when the toggle is switched back on, so a restarted gateway repopulates itself. Heartbeats that change nothing are not audited; new or changed cards are.

## Discovery

A **curated registry** maintains Agent Cards and lets clients discover agents by skills, tags, provider, name or capabilities:

```bash
TOKEN='Authorization: Bearer poc-gw-token-agent-a'
curl -s -H "$TOKEN" 'http://localhost:4000/registry/agents?skill=vehicle_service_orchestration'
curl -s -H "$TOKEN" 'http://localhost:4000/registry/agents?tag=inventory'
curl -s -H "$TOKEN" 'http://localhost:4000/registry/agents?provider=dealer'
curl -s -H "$TOKEN" 'http://localhost:4000/registry/agents?capability=pushNotifications'
curl -s -H "$TOKEN" 'http://localhost:4000/registry/agents/agent-b/card'
```

Results include each agent's health, which the gateway refreshes every `HEALTH_CHECK_INTERVAL_MS` by calling the agent's `/health`. Agent A prefers a healthy match.
