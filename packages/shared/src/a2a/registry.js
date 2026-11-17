// Curated Agent Registry: stores Agent Cards and answers discovery queries
// by skill id, tag, name, capability or provider.
import { validateAgentCard, cardEndpoint } from './agentCard.js';
import { nowIso, clone } from '../utils/ids.js';

export class AgentRegistry {
  constructor() { this.agents = new Map(); }

  register({ agentId, card, agentCardUrl }, { knownSecrets = [] } = {}) {
    if (!agentId || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(agentId)) {
      return { ok: false, errors: ['agentId must be lowercase alphanumeric/dashes'] };
    }
    const { valid, errors } = validateAgentCard(card, { knownSecrets });
    if (!valid) return { ok: false, errors };
    const existing = this.agents.get(agentId);
    const entry = {
      agentId,
      agentCardUrl: agentCardUrl ?? null,
      card: clone(card),
      registeredAt: existing?.registeredAt ?? nowIso(),
      updatedAt: nowIso(),
      registrations: (existing?.registrations ?? 0) + 1,
      health: existing?.health ?? { status: 'unknown', checkedAt: null },
    };
    this.agents.set(agentId, entry);
    const changed = !existing || JSON.stringify(existing.card) !== JSON.stringify(entry.card) || existing.agentCardUrl !== entry.agentCardUrl;
    return { ok: true, entry: clone(entry), created: !existing, changed };
  }

  get(agentId) { return clone(this.agents.get(agentId)) ?? null; }
  remove(agentId) { return this.agents.delete(agentId); }
  list() { return [...this.agents.values()].map(clone); }

  discover({ skill, tag, name, capability, provider } = {}) {
    const lc = (s) => String(s ?? '').toLowerCase();
    return this.list().filter(({ card }) => {
      if (skill && !card.skills.some((s) => s.id === skill)) return false;
      if (tag && !card.skills.some((s) => (s.tags ?? []).map(lc).includes(lc(tag)))) return false;
      if (name && !lc(card.name).includes(lc(name))) return false;
      if (capability && card.capabilities?.[capability] !== true) return false;
      if (provider && !lc(card.provider?.organization).includes(lc(provider))) return false;
      return true;
    });
  }

  setHealth(agentId, status, details = {}) {
    const entry = this.agents.get(agentId);
    if (entry) entry.health = { status, checkedAt: nowIso(), ...details };
  }
}

/** Compact discovery result shape returned by the gateway. */
export const summarizeEntry = (e) => ({
  agentId: e.agentId,
  name: e.card.name,
  description: e.card.description,
  provider: e.card.provider?.organization,
  version: e.card.version,
  url: cardEndpoint(e.card),
  agentCardUrl: e.agentCardUrl,
  skills: e.card.skills.map((s) => ({ id: s.id, name: s.name, tags: s.tags })),
  capabilities: e.card.capabilities,
  health: e.health,
  registeredAt: e.registeredAt,
  updatedAt: e.updatedAt,
});
