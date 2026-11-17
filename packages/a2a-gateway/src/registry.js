// Registry service: shared AgentRegistry + periodic health checks of registered agents.
import { AgentRegistry, fetchJson, cardOrigin } from '@axon-fleet/shared';

export function createRegistryService({ logger, healthIntervalMs = 5000 }) {
  const registry = new AgentRegistry();
  let timer = null;

  async function checkAll() {
    await Promise.all(registry.list().map(async (e) => {
      const res = await fetchJson(`${cardOrigin(e.card)}/health`, { timeoutMs: 1500 });
      const status = res.ok ? 'healthy' : 'unhealthy';
      if (e.health.status !== status) logger?.info('agent_health_changed', { agentId: e.agentId, status });
      registry.setHealth(e.agentId, status, { httpStatus: res.status, latencyMs: res.ms, gatewayMode: res.data?.gatewayEnabled });
    }));
  }

  return {
    registry,
    register: (...a) => registry.register(...a),
    get: (id) => registry.get(id),
    list: () => registry.list(),
    discover: (q) => registry.discover(q),
    remove: (id) => registry.remove(id),
    checkAll,
    startHealthChecks() {
      if (timer || !healthIntervalMs) return;
      timer = setInterval(() => checkAll().catch(() => {}), healthIntervalMs);
      timer.unref?.();
    },
    stopHealthChecks() { clearInterval(timer); timer = null; },
  };
}
