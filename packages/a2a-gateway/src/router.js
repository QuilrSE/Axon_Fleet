// Gateway-mediated A2A routing. Enforcement order:
//   authenticate → validate → bind sender identity → rate limit → authorize skill → resolve target → forward → audit
import {
  readEnvelope, validateRpcRequest, rpcError, RPC_ERRORS, normalizeMethod, METHODS, cardEndpoint,
  fetchJson, newId, nowIso,
} from '@axon-fleet/shared';

export function createRouter(ctx) {
  const { cfg, auth, policy, registry, audit, tasks, routeLog, rateLimitEvents, stats } = ctx;

  async function handle(req, res) {
    const requestId = newId('gwreq');
    const started = Date.now();
    const target = req.params.targetAgentId;
    const body = req.body;
    const env = readEnvelope(body);
    const base = {
      requestId,
      caller: env?.sender_agent_id ?? 'unknown',
      claimedSender: env?.sender_agent_id ?? null,
      target,
      skill: env?.skill ?? null,
      method: body?.method ? normalizeMethod(body.method) : null,
      taskId: env?.task_id ?? body?.params?.id ?? null,
      correlationId: env?.correlation_id ?? null,
    };

    const finish = (status, payload, extra) => {
      const durationMs = Date.now() - started;
      audit.record({ type: 'a2a_request', ...base, ...extra, responseStatus: status, durationMs });
      routeLog.push({ timestamp: nowIso(), ...base, decision: extra.routing, httpStatus: status, durationMs, reason: extra.reason ?? null, upstreamUrl: extra.upstreamUrl ?? null });
      res.status(status).set('x-gateway-request-id', requestId).json(payload);
    };
    const reject = (status, code, message, extra) => {
      finish(status, rpcError(body?.id, code, message, { requestId, enforcedBy: 'a2a-gateway', reason: extra.reasonCode }), { ...extra, routing: 'rejected', reason: message });
    };

    // 1. Authentication
    const authn = await auth.authenticate(req);
    if (!authn.ok) {
      stats.unauthenticated += 1;
      return reject(401, RPC_ERRORS.UNAUTHENTICATED, `Gateway authentication failed (${authn.reason})`, { authentication: 'fail', authorization: 'n/a', reasonCode: authn.reason });
    }
    base.caller = authn.principal.agentId;

    // 2. Request validation
    const errors = validateRpcRequest(body);
    if (errors.length) {
      stats.invalid += 1;
      return reject(400, RPC_ERRORS.INVALID_REQUEST, `Request validation failed: ${errors.join('; ')}`, { authentication: 'pass', authorization: 'n/a', reasonCode: 'invalid_request' });
    }

    // 3. Bind envelope identity to the authenticated principal (anti-spoofing)
    if (env.sender_agent_id !== authn.principal.agentId) {
      stats.denied += 1;
      return reject(403, RPC_ERRORS.FORBIDDEN, `Sender identity mismatch: credential belongs to '${authn.principal.agentId}' but envelope claims '${env.sender_agent_id}'`, { authentication: 'pass', authorization: 'deny', reasonCode: 'sender_mismatch' });
    }
    if (env.recipient_agent_id !== target) {
      stats.invalid += 1;
      return reject(400, RPC_ERRORS.INVALID_REQUEST, `Envelope recipient '${env.recipient_agent_id}' does not match route target '${target}'`, { authentication: 'pass', authorization: 'n/a', reasonCode: 'recipient_mismatch' });
    }

    // 4. Rate limiting (per authenticated caller)
    const rl = policy.checkRateLimit(authn.principal.agentId);
    if (!rl.allowed) {
      stats.rateLimited += 1;
      rateLimitEvents.push({ timestamp: nowIso(), requestId, caller: base.caller, target, skill: base.skill, count: rl.count, limit: rl.limit, resetMs: rl.resetMs });
      return reject(429, RPC_ERRORS.RATE_LIMITED, `Rate limit exceeded for '${base.caller}': ${rl.count}/${rl.limit} in current window`, { authentication: 'pass', authorization: 'n/a', reasonCode: 'rate_limited' });
    }

    // 5. Skill-level authorization
    const authz = policy.authorize({ caller: base.caller, target, skill: env.skill });
    if (!authz.allowed) {
      stats.denied += 1;
      return reject(403, RPC_ERRORS.FORBIDDEN, `Skill authorization denied: ${authz.reason}`, { authentication: 'pass', authorization: 'deny', reasonCode: 'skill_not_allowlisted' });
    }

    // 6. Resolve the target from the registry
    const entry = registry.get(target);
    if (!entry) {
      return reject(404, RPC_ERRORS.UPSTREAM_UNAVAILABLE, `Target agent '${target}' is not registered`, { authentication: 'pass', authorization: 'allow', reasonCode: 'target_not_registered' });
    }

    // 7. Forward
    const upstreamUrl = cardEndpoint(entry.card);
    const upstream = await fetchJson(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.forwardToken}`,
        'x-a2a-via-gateway': 'a2a-gateway',
        'x-a2a-caller': base.caller,
        'x-correlation-id': env.correlation_id,
        'x-gateway-request-id': requestId,
      },
      body,
      timeoutMs: 8000,
    });
    if (upstream.status === 0) {
      stats.upstreamErrors += 1;
      return reject(502, RPC_ERRORS.UPSTREAM_UNAVAILABLE, `Target agent unreachable: ${upstream.data?.error?.message}`, { authentication: 'pass', authorization: 'allow', reasonCode: 'upstream_unreachable', upstreamUrl });
    }

    stats.routed += 1;
    const result = upstream.data?.result;
    const pushed = body.params?.task;
    tasks.observe({
      taskId: result?.id ?? pushed?.id ?? base.taskId,
      caller: base.method === METHODS.PUSH_STATUS ? target : base.caller,
      target: base.method === METHODS.PUSH_STATUS ? base.caller : target,
      skill: base.method === METHODS.PUSH_STATUS ? pushed?.metadata?.envelope?.skill ?? base.skill : base.skill,
      state: result?.status?.state ?? pushed?.status?.state,
      stage: result?.metadata?.stage ?? pushed?.metadata?.stage,
      method: base.method,
      correlationId: base.correlationId,
    });
    return finish(upstream.status, upstream.data, {
      authentication: 'pass',
      authorization: 'allow',
      authorizationReason: authz.reason,
      routing: 'forwarded',
      routingDetail: `${base.caller} → a2a-gateway → ${target}`,
      upstreamUrl,
      upstreamError: upstream.data?.error?.message ?? null,
    });
  }

  return { handle };
}
