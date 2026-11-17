# The A2A Gateway toggle

Each agent dashboard has a switch labelled **A2A Gateway** (Enabled / Disabled). It calls `PUT /api/config {"gatewayEnabled": bool}` on that agent. The value lives in a `RuntimeConfig` object that every outbound call and inbound check reads at request time, so the change applies to the very next request without restarting anything. It is persisted to `.runtime/agent-a.json` / `.runtime/agent-b.json`. **Reset to default** (or `npm run reset`) deletes it; the default comes from `GATEWAY_DEFAULT_ENABLED`.

The toggle chooses *gateway-mediated vs direct*. Which gateway is used when it is on is the **active gateway profile**, chosen in the *A2A gateways* panel (see [custom-gateways.md](custom-gateways.md)). **Reset to default** on the mode band resets only the toggle; *Restore default gateway list* resets the profiles.

## What each agent does in each mode

| | Agent A enabled | Agent A disabled | Agent B enabled | Agent B disabled |
|---|---|---|---|---|
| Discovery | Registry by skill | Card at `AGENT_B_CARD_URL` | — | — |
| Outbound | Active gateway's invoke path with A's credential for it | `POST agent-b/a2a` with B's API key | Pushes via the active gateway | Pushes to `pushNotificationConfig.url` with A's API key |
| Inbound accepted | Gateway-forwarded only | Gateway-forwarded or direct key | Gateway-forwarded only | Gateway-forwarded or direct key |
| UI | Green "Gateway Enabled", gateway URL, health, registration, discovery method, routing path | Amber "Gateway Disabled — Direct Mode", Agent B endpoint, security mode, bypass warning | Green, gateway URL, health, registration, inbound route | Amber, Agent A endpoint, security mode, bypass warning |

## Mixed modes

Mixed modes are allowed and make good talking points:

- **A disabled, B enabled**: Agent A calls Agent B directly and is refused with 403 *gateway required*. The service provider has opted into central governance, so callers cannot bypass it.
- **A enabled, B disabled**: requests reach B through the gateway (B still accepts gateway-forwarded calls), but B pushes status directly to A. A has the gateway enabled, so it refuses the direct push. The refusal appears in both agents' security events, and A's task stays at `received` until you click **Get task status**, which polls through the gateway.

For the clean before/after comparison, switch both agents together.
