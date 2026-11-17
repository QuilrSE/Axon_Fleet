// Gateway policy service: agent allowlist, skill-level authorization and rate limiting.
import { PolicyEngine, RateLimiter, DEFAULT_POLICY } from '@axon-fleet/shared';

export function createPolicyService({ policy = DEFAULT_POLICY, rateLimit }) {
  const engine = new PolicyEngine(policy);
  const limiter = new RateLimiter(rateLimit);
  return {
    isAllowlisted: (id) => engine.isAllowlisted(id),
    authorize: (q) => engine.authorize(q),
    checkRateLimit: (key) => limiter.check(key),
    describe: () => ({ ...engine.describe(), rateLimit: limiter.describe(), enforcementOrder: ['authenticate', 'validate request', 'bind sender identity', 'rate limit', 'authorize skill', 'resolve target', 'forward', 'audit'] }),
  };
}
