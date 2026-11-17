# Gateway security

## Enforcement order (`a2a-gateway/src/router.js`)

| Step | Control | Failure |
|---|---|---|
| 1 | **Authentication**: bearer token → agent identity (`StaticTokenAuthenticator`, timing-safe compare) | 401, `-32010` |
| 2 | **Request validation**: JSON-RPC 2.0 shape, envelope fields, method-specific params | 400, `-32600` |
| 3 | **Sender identity binding**: `envelope.sender_agent_id` must equal the authenticated identity; recipient must equal the route target | 403 `-32011` / 400 |
| 4 | **Rate limiting**: fixed window per authenticated caller (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`) | 429, `-32029` |
| 5 | **Skill-level authorization**: agent allowlist + caller→target skill allowlist | 403, `-32011` |
| 6 | **Target resolution** from the registry | 404 / 502 |
| 7 | **Forward** with the gateway forwarding credential and trace headers (`x-a2a-caller`, `x-correlation-id`, `x-gateway-request-id`) | |
| 8 | **Audit**: every decision, allowed or not | |

## Default policy

```json
{
  "defaultDecision": "deny",
  "agentAllowlist": ["agent-a", "agent-b"],
  "rules": [
    { "caller": "agent-a", "target": "agent-b", "skills": ["vehicle_service_orchestration"] },
    { "caller": "agent-b", "target": "agent-a", "skills": ["service_status_updates", "vehicle_telemetry_query"] }
  ]
}
```

`agent-a → agent-b [delete_inventory]` is therefore denied.

## Audit record

Every gateway-mediated request produces an entry with: timestamp, request ID, caller agent ID (authenticated), claimed sender, target agent ID, method, skill, task ID, correlation ID, authentication result, authorization result (and reason), routing decision and detail, upstream URL, response status and duration. Registration, discovery and authentication failures on registry endpoints are audited too. The `AuditLog` accepts a `sink` function for shipping entries to a SIEM or OpenTelemetry.

## Agent-side checks

Agents check the inbound credential themselves (`classifyInbound` in `shared/src/security/auth.js`):

- **Gateway forwarding token** → accepted; the caller identity comes from `x-a2a-caller`, which only the gateway sets after authenticating.
- **The agent's direct API key** → accepted only when that agent's A2A Gateway toggle is **off**. With the toggle on, the agent returns 403 `-32012` *gateway required*. This prevents callers from side-stepping gateway policy.
- Anything else → 401.

In direct mode the agent can only tell that the caller holds *its* API key. It cannot tell *which* agent is calling, so `sender_agent_id` is self-asserted. The spoofed-sender probe shows this.

## Probes

| Probe | Gateway enabled | Gateway disabled |
|---|---|---|
| Unauthorized skill (`delete_inventory`) | 403 at gateway, audited | Reaches Agent B and executes (simulated; no data changed), critical event on Agent B only |
| Invalid token | 401 at gateway, audited | 401 at Agent B, local event only |
| Spoofed sender (`fleet-admin-agent`) | 403 identity mismatch | Accepted; Agent B marks caller *unverified* |
| Rate-limit burst (25 calls) | Calls past the limit get 429 | All calls reach Agent B |

## Credentials and cards

Agent Cards declare schemes (`http` / `bearer`) and never contain values. Tokens and keys come from environment variables and travel in the `Authorization` header. The demo values in `.env.example` are for local use only.

## Extension points

`createAuthenticator({ mode })` already routes `oauth2`, `oidc` and `mtls` to stubs. To implement one, return `{ ok: true, principal: { agentId, scheme } }` from `authenticate(req)`:

- **OAuth 2.0 client credentials**: verify the JWT signature against the authorization server's JWKS, check `iss`, `aud`, `exp`, and map `client_id`/`sub` to an agent ID; use `scope` for coarse skill gating. Declare `"type": "oauth2"` with `flows.clientCredentials.tokenUrl` in the Agent Card.
- **OpenID Connect**: same validation via the discovery document, or token introspection. Card scheme `"type": "openIdConnect"` with `openIdConnectUrl`.
- **mTLS**: terminate TLS with `requestCert: true`, read `req.socket.getPeerCertificate()` and map the subject or SAN to an agent ID. Use mTLS for the gateway→agent hop as well, replacing the shared forwarding token. Card scheme `"type": "mutualTLS"`.

Other production hardening: signed Agent Cards, per-tenant policy, OPA/Cedar policy evaluation, sliding-window or token-bucket limits backed by Redis, persistent append-only audit, payload DLP inspection on the routed messages, and authenticated dashboard APIs.
