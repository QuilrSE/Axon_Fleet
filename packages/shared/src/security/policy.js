// Centralized policy: agent allowlist + caller→target skill allowlist, plus rate limiting.
export const DEFAULT_POLICY = Object.freeze({
  version: 'poc-2026-11',
  defaultDecision: 'deny',
  agentAllowlist: ['agent-a', 'agent-b'],
  rules: [
    { caller: 'agent-a', target: 'agent-b', skills: ['vehicle_service_orchestration'] },
    { caller: 'agent-b', target: 'agent-a', skills: ['service_status_updates', 'vehicle_telemetry_query'] },
  ],
});

export class PolicyEngine {
  constructor(policy = DEFAULT_POLICY) { this.policy = structuredClone(policy); }

  isAllowlisted(agentId) { return this.policy.agentAllowlist.includes(agentId); }

  authorize({ caller, target, skill }) {
    if (!this.isAllowlisted(caller)) return { allowed: false, reason: `caller '${caller}' is not on the agent allowlist` };
    if (!this.isAllowlisted(target)) return { allowed: false, reason: `target '${target}' is not on the agent allowlist` };
    const rule = this.policy.rules.find((r) => r.caller === caller && r.target === target);
    if (!rule) return { allowed: false, reason: `no rule permits ${caller} → ${target}` };
    if (!rule.skills.includes(skill)) return { allowed: false, reason: `skill '${skill}' is not allowlisted for ${caller} → ${target}` };
    return { allowed: true, reason: `allowlisted: ${caller} → ${target} [${skill}]` };
  }

  describe() { return structuredClone(this.policy); }
}

/** Fixed-window rate limiter keyed by caller identity. */
export class RateLimiter {
  constructor({ limit = 20, windowMs = 10_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windows = new Map();
  }
  check(key, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    const allowed = w.count <= this.limit;
    return { allowed, count: w.count, limit: this.limit, remaining: Math.max(0, this.limit - w.count), resetMs: w.start + this.windowMs - now };
  }
  describe() { return { algorithm: 'fixed-window', limit: this.limit, windowMs: this.windowMs, key: 'authenticated caller agentId' }; }
}
