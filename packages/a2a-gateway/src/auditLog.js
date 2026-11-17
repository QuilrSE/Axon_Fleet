// Gateway audit trail: every registration, discovery and A2A request decision lands here.
import { AuditLog } from '@axon-fleet/shared';

export function createAuditService({ logger, max = 2000 } = {}) {
  return new AuditLog({
    max,
    sink: (e) => logger?.info('audit', { type: e.type, caller: e.caller, target: e.target, skill: e.skill, authn: e.authentication, authz: e.authorization, routing: e.routing, status: e.responseStatus }),
  });
}
