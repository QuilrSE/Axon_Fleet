# Demo script (about 10 minutes)

Setup: `npm install && npm run reset && npm start`, then open three browser tabs: **Vehicle agent** (`/agent-a.html`), **Dealership agent** (`/agent-b.html`) and **Gateway** (`/gateway.html`) at `http://localhost:5173`.

## Act 1: discovery and registration

1. **Gateway tab.** Point to *Registered agents*: both cards, their skills and tags, health *healthy*. Expand Agent B's **Agent Card** and note `securitySchemes` declares bearer auth but holds no credentials.
2. Point to *Gateway policy*: default deny, two allowlist rules, rate limit, the eight-step enforcement order.

## Act 2: the happy path through the gateway

3. **Vehicle agent tab.** The mode band is green: *Gateway Enabled*, *Gateway-mediated A2A*, gateway URL, health, registration, routing path `agent-a → a2a-gateway → agent-b`. The routing strip shows the gateway node with its checks (authn, allowlist, skill authz, rate limit, audit, trace).
4. Select **EV sedan (SYN-001)** and **Brake-pad wear above threshold**. Click **Generate telemetry**. The *Front pads worn* tile turns red and a critical alert appears.
5. Click **Send Telemetry to Service Agent**. Discovery method updates to *Gateway registry lookup*. In *Service tasks* the timeline steps through seven stages, each tagged **via gateway**. The *Agent B response* shows the recommendation, a proposed slot, purchase order `PO-SYN-…` for the second rotor (one in stock, two needed), and an estimate.
6. **Dealership agent tab.** The same task arrived **via gateway** with caller **agent-a, verified**. Show inventory status (pads in stock, rotor partial), reservations, the parts order moving `placed → confirmed → in_transit`, and the held (blue) slot in the schedule grid.
7. **Gateway tab.** The routing log shows one `message/send` from agent-a and a run of `tasks/pushNotification` from agent-b, all *forwarded*. The audit trail records authN pass, authZ allow for each.

## Act 3: the gateway enforcing policy

8. **Vehicle agent tab → Security probes.**
   - **Unauthorized skill**: *Blocked (HTTP 403)*, skill `delete_inventory` not allowlisted.
   - **Invalid token**: *Blocked (HTTP 401)*.
   - **Spoofed sender**: *Blocked (HTTP 403)*, identity mismatch.
   - **Rate-limit burst**: about 5 of 25 calls get HTTP 429.
9. **Gateway tab.** *Denied*, *Unauthenticated* and *Rate-limited* counters went up. Filter the audit by *A2A requests* to show the deny rows with reasons, and see *Rate-limit events*.

## Act 4: turn the gateway off

10. **Dealership agent tab.** Switch **A2A Gateway** off. The band turns amber: *Gateway Disabled — Direct Mode*, Agent A's direct endpoint, *Direct endpoint auth only*, and the warning *Gateway policy, centralized authentication, audit logging, rate limiting, and routing controls are bypassed.* Nine of eleven controls are struck through.
11. **Vehicle agent tab.** Switch **A2A Gateway** off too. Same amber treatment; the routing strip shows the gateway crossed out with a dashed bypass line.
12. Choose **Battery degradation**, generate, and send. The route reads `agent-a → agent-b`; discovery says *Direct Agent Card fetch*; every timeline entry is **via direct**. The HV module is out of stock, so a parts order is placed and the appointment moves out past the ETA.
13. Run the probes again:
    - **Unauthorized skill**: *Allowed — reached Agent B.* On the Dealership tab a critical event reads *Destructive admin skill executed without centralized skill authorization*.
    - **Spoofed sender**: accepted; the Dealership task table shows caller **fleet-admin-agent, unverified**.
    - **Rate-limit burst**: all calls reach Agent B.
    - **Invalid token**: still 401, but enforced only by Agent B's local key check.
14. **Gateway tab.** Routing log and audit counters have not moved since step 11. On the Vehicle tab, *Central gateway audit* shows the direct-mode note and no new rows.

## Act 5 (optional): mixed mode

15. Turn the gateway back **on** for Agent B only and send again from Agent A (still direct). Agent A's request fails with *gateway required*: the provider enforces governance even when a caller tries to skip it. Turn Agent A back on and everything flows through the gateway again.

## Act 6: a custom, third-party gateway

16. Make sure both toggles are **on**. On the **Dealership agent** tab, open **A2A gateways → Add a gateway**, choose the template *Partner A2A Exchange (mock third-party, port 4100)*, tick **Route traffic through this gateway**, and **Save gateway**. It shows *registered* and *healthy*. Open **API mapping** to show the different paths, the `X-API-Key` header and the raw-card registration body.
17. Do the same on the **Vehicle agent** tab. Both agents are now listed on two gateways (*Agent Card published to* in the mode band) but route through the partner.
18. The routing strip now shows **Partner A2A Exchange** with only the controls it declares (authn, identity, audit), and the controls list marks them *declared by operator, not verified*.
19. Send a request. The task's route is `agent-a → partner-a2a-exchange → agent-b`; the PoC Gateway tab shows no new traffic; `http://localhost:4100/v1/audit` lists the forwarded calls.
20. Run the probes. **Spoofed sender** is blocked (the partner binds identity) but **Unauthorized skill** gets through, because this gateway has no skill policy. Governance depends on which gateway you route through.
21. Click **Route through this** on *PoC A2A Gateway* on both agents to switch back. No restarts at any point.

## What reviewers should take away

| Observation | Gateway enabled | Gateway disabled |
|---|---|---|
| Routing path | via gateway | direct |
| Who is the caller? | Verified by the gateway | Self-asserted |
| `delete_inventory` | Denied | Executed |
| Burst traffic | Throttled | Unlimited |
| Audit | Central, correlated, with request IDs | Scattered across agent-local logs |
