# Deploying to Cloudflare Workers

The whole PoC runs as **one Cloudflare Worker**, and you can deploy it by importing the repository in the Cloudflare dashboard. The Node.js version (`npm start`, Docker) keeps working from the same code.

## What runs where

| Path on your Worker | What it is | Runs as |
|---|---|---|
| `/`, `/agent-a.html`, `/agent-b.html`, `/gateway.html` | Dashboard | Workers static assets (`packages/web-dashboard/public`) |
| `/config.js` | Dashboard config (service URLs for this hostname) | Worker |
| `/gateway/…` | PoC A2A Gateway & Agent Registry | Durable Object `GatewayService` |
| `/agent-a/…` | In-vehicle telemetry agent | Durable Object `AgentAService` |
| `/agent-b/…` | Dealership orchestration agent | Durable Object `AgentBService` |
| `/partner/…` | Mock third-party gateway | Durable Object `PartnerGatewayService` |

Each service is the same app as on Node.js, running inside a single Durable Object instance. The Durable Object keeps its in-memory state, timers and background work (Agent B's processing, heartbeats) alive like a long-running server. Small shims (`cloudflare/shims/`, wired in through `alias` in `wrangler.jsonc`) give the Express, cors and undici APIs the code uses on top of the Fetch API. Calls between services on the Worker's own hostname are dispatched internally, because a Worker cannot fetch its own public URL. Settings changed in the dashboard (the gateway toggle, gateway profiles, advertised URL, card format) are stored in Durable Object storage and survive restarts and redeploys.

Agent Cards automatically advertise the Worker's public URL, for example `https://axon-fleet.<subdomain>.workers.dev/agent-b/.well-known/agent-card.json`. Any external gateway can reach the agents without tunnels or allowlists.

## Import in the Cloudflare dashboard

1. Push this folder to a GitHub or GitLab repository, with the folder as the repository root:
   ```bash
   git init && git add . && git commit -m "Axon Fleet"
   git remote add origin git@github.com:<you>/axon-fleet.git
   git push -u origin main
   ```
2. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a repository**, connect your Git account, and pick the repository.
3. Keep the defaults:
   - **Project / Worker name:** `axon-fleet` (it must match `name` in `wrangler.jsonc`; change both if you want another name)
   - **Build command:** empty
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/`
4. **Deploy.** Workers Builds installs dependencies from `package-lock.json`, uses the Wrangler version pinned in `package.json`, bundles `cloudflare/worker.js`, uploads the dashboard, and creates the Durable Objects (migration `v1`).
5. Open `https://axon-fleet.<your-subdomain>.workers.dev/`.

From then on, every push to the production branch redeploys. Durable Object Workers don't get preview URLs for non-production branches.

The SQLite-backed Durable Objects used here are available on the Workers **Free** plan. Background timers pause after 10 minutes without dashboard or API traffic, so idle Durable Objects can be evicted. The first request after a pause resumes them; agents re-register within seconds.

### Deploy from your machine instead (optional)

```bash
npm install
npx wrangler login
npm run cf:deploy          # = wrangler deploy
```

### Worker name

The Worker is named `axon-fleet` (`name` in `wrangler.jsonc`; the dashboard project must use the same name). To use another name, change both. A Worker under a new name is a new Worker: a new `*.workers.dev` URL, fresh Durable Object storage (gateway entries and settings start empty), and agent card URLs that external gateways such as Quilr or Bifrost must be updated to.

## Configuration and secrets

`wrangler.jsonc` → `vars` holds the same **demo** tokens as `.env.example`, so the deployment works immediately. For anything beyond a demo:

1. Remove the token entries from `vars` in `wrangler.jsonc`.
2. Add them as **encrypted Secrets** in the dashboard (**Worker → Settings → Variables and Secrets → Add → Secret**) or with `npx wrangler secret put GATEWAY_FORWARD_TOKEN` (and so on).

Useful settings:

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | the request hostname | Set it when you add a custom domain, so cards advertise that domain. |
| `DASHBOARD_ALLOW_SECRET_REVEAL` | `true` | Set `false` on a shared deployment. |
| `REGISTRATION_INTERVAL_MS`, `HEALTH_CHECK_INTERVAL_MS` | 30000 / 15000 | Heartbeat periods. |
| `AGENT_B_STEP_DELAY_MS` | 900 | Pause between Agent B processing stages. |

**The dashboard and its `/…/api/*` endpoints are public and unauthenticated** (local-dev design). Anyone with the URL can change settings or reveal typed secrets. Before sharing the URL, put the Worker behind **Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted → your `workers.dev` hostname or custom domain), or at least set `DASHBOARD_ALLOW_SECRET_REVEAL=false`.

## Connecting Bifrost (or any gateway) to the Cloudflare deployment

The agents are on the public internet now, so the direction that used to be hard is easy: Bifrost can reach them directly. The other direction needs work, because **a Worker cannot reach `localhost` or a private network.** If Bifrost runs in Docker on your laptop, expose it with a tunnel and use that public URL:

```bash
cloudflared tunnel --url http://localhost:8080      # prints https://<random>.trycloudflare.com
```

Then:
1. In Bifrost → Agents → Agent Settings, set **External Client URL** to the tunnel URL. Agent B posts push notifications to it.
2. Register `agent-b` (and `agent-a`) in Bifrost with card URL `https://<worker>/agent-b/.well-known/agent-card.json`. This is a public address, so no Private Network Allowlist entry is needed. Or let the agents register themselves (management auth in the gateway form).
3. On both agent dashboards, add the Bifrost gateway with the **tunnel URL** as its address (https), then route through it.

For a long-lived setup, use a named Cloudflare Tunnel or host Bifrost on a public address.

## Connecting the QuilrAI A2A Gateway

Quilr only calls agents over public HTTPS, so the Cloudflare deployment is the natural home for agents behind Quilr. Register `https://<worker>/agent-b/.well-known/agent-card.json` in the Quilr console, then add the *QuilrAI A2A Gateway* template on both dashboards. Step by step: [quilr.md](quilr.md).

## What differs from the Node.js version

| | Node.js | Cloudflare Workers |
|---|---|---|
| Hostnames | one port per service | one hostname, services under path prefixes |
| Settings persistence | `.runtime/*.json` | Durable Object storage |
| Gateway URLs | localhost, LAN, Docker, public | public only (tunnel anything private) |
| HTTP(S) proxy, `NODE_EXTRA_CA_CERTS`, "skip TLS verification" | supported | not applicable: Workers use Cloudflare's network and trust store. The skip option has no effect. |
| LAN address suggestions in Connection details | yes | no (only the Worker URL) |
| Raw request logs | terminal | Worker → Logs (observability is enabled) |

## Verifying a deployment

```bash
npm run cf:smoke -- https://axon-fleet.<your-subdomain>.workers.dev
```

The smoke test checks:
- the dashboard and both agent cards;
- registration;
- a full request in gateway mode and in direct mode;
- that the gateway blocks an unauthorized skill;
- registration with and routing through the third-party partner gateway;
- the equivalent-curl output.

It leaves the deployment in its default state.

Locally, `npm run cf:dev` runs the same Worker in `workerd` (the Workers runtime) at `http://localhost:8787`. `npm run cf:check` bundles without deploying.
