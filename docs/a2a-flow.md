# A2A flow

## Gateway enabled

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent A (vehicle)
  participant G as A2A Gateway / Registry
  participant B as Agent B (dealership)

  Note over B,G: Registration
  B->>G: POST /registry/agents {agentId, card} (Bearer agent-b token)
  G->>G: authenticate, allowlist, validate card, reject embedded secrets
  G-->>B: 201 registered
  A->>G: POST /registry/agents {agentId, card} (Bearer agent-a token)
  G-->>A: 201 registered

  Note over A: Telemetry
  A->>A: generate synthetic telemetry (e.g. front pads 91%)
  A->>A: maintenanceRules → critical alert

  Note over A,G: Discovery
  A->>G: GET /registry/agents?skill=vehicle_service_orchestration
  G-->>A: [agent-b, healthy, url]

  Note over A,B: Task creation and routing
  A->>G: POST /a2a/agent-b  message/send (envelope: sender agent-a, skill vehicle_service_orchestration)
  G->>G: authenticate token → agent-a
  G->>G: validate JSON-RPC + envelope
  G->>G: bind sender (envelope.sender == agent-a)
  G->>G: rate limit agent-a
  G->>G: authorize agent-a → agent-b [vehicle_service_orchestration]
  G->>B: POST /a2a (Bearer gateway forward token, x-a2a-caller: agent-a)
  B-->>G: Task {state: submitted, stage: received}
  G->>G: audit + route log + task index
  G-->>A: Task (x-gateway-request-id)

  Note over B: DealerFlow processing
  loop each stage: diagnosed, inventory_checked, parts_reserved, parts_ordered, appointment_proposed
    B->>B: run node (diagnose / check stock / reserve / order shortfall / propose slot)
    B->>G: POST /a2a/agent-a tasks/pushNotification (Bearer agent-b token, skill service_status_updates)
    G->>G: authn, bind, rate limit, authorize agent-b → agent-a, audit
    G->>A: forward push
    A-->>G: {received: true}
    G-->>B: 200
  end
  B->>G: tasks/pushNotification {state: completed, artifact: service-assessment}
  G->>A: forward
  A->>A: show appointment, parts, order, estimate
```

## Gateway disabled (direct A2A)

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent A (vehicle)
  participant G as A2A Gateway (bypassed)
  participant B as Agent B (dealership)

  Note over A,B: Both dashboards: A2A Gateway = Disabled
  Note over G: Cards may still be registered,<br/>but no traffic passes through
  A->>A: generate telemetry + local alerts
  A->>B: GET /.well-known/agent-card.json (AGENT_B_CARD_URL)
  B-->>A: Agent Card (url = http://agent-b/a2a)
  A->>B: POST /a2a message/send (Bearer agent-b static API key)
  B->>B: check API key only. Sender is self-asserted, no allowlist, no skill authz, no rate limit
  B-->>A: Task {submitted, received}
  loop each stage
    B->>B: DealerFlow node
    B->>A: POST pushNotificationConfig.url (Bearer agent-a static API key)
    A-->>B: {received: true}
  end
  Note over A,B: No central audit, no x-gateway-request-id, no gateway route log
```

## Task lifecycle

| A2A `status.state` | `metadata.stage` | Meaning |
|---|---|---|
| submitted | received | Work order accepted |
| working | diagnosed | Findings and required parts determined |
| working | inventory_checked | Stock checked per part line |
| working | parts_reserved | Available stock reserved |
| working | parts_ordered | Purchase order placed for shortfalls (or "no order needed") |
| working | appointment_proposed | Mechanic + bay slot held |
| completed | completed | Artifact `service-assessment` attached |
| canceled | canceled | `tasks/cancel`; reservations, orders and held slots released |
| failed | failed | A DealerFlow node threw |

Parts orders progress independently: `placed → confirmed → in_transit`.

## Example payloads

All captured from a real run by `npm run examples`:

| Payload | File |
|---|---|
| Registration + discovery | `examples/00-registry-registration.json` |
| Telemetry service request (`message/send`) | `examples/01-telemetry-service-request.json` |
| Inventory check (status push) | `examples/02-inventory-check.json` |
| Parts reservation (status push) | `examples/03-parts-reservation.json` |
| Parts order creation (status push) | `examples/04-parts-order-creation.json` |
| Appointment proposal (status push) | `examples/05-appointment-proposal.json` |
| Task status (`tasks/get`) | `examples/06-task-status-update.json` |
| Completed task with artifact | `examples/07-task-completed-push.json` |
| Gateway denial of an unauthorized skill | `examples/08-gateway-denied-unauthorized-skill.json` |
| `cancel_task` request | `examples/09-cancel-task-request.json` |

Minimal `message/send` shape:

```json
{
  "jsonrpc": "2.0",
  "id": "rpc_…",
  "method": "message/send",
  "params": {
    "metadata": {
      "envelope": {
        "task_id": "task_…", "sender_agent_id": "agent-a", "recipient_agent_id": "agent-b",
        "skill": "vehicle_service_orchestration", "intent": "service_assessment_and_parts_order",
        "payload": { "vehicle": {…}, "telemetry": {…}, "detectedIssues": […], "preferences": {…} },
        "created_at": "2026-11-15T09:00:00.000Z", "status": "submitted", "correlation_id": "corr_…"
      }
    },
    "message": {
      "kind": "message", "role": "user", "messageId": "msg_…", "contextId": "corr_…", "taskId": "task_…",
      "parts": [
        { "kind": "text", "text": "service_assessment_and_parts_order (skill: vehicle_service_orchestration)" },
        { "kind": "data", "data": { "skill": "…", "intent": "…", "payload": {…} } }
      ]
    },
    "configuration": { "blocking": false, "pushNotificationConfig": { "url": "http://localhost:4001/a2a" } }
  }
}
```
