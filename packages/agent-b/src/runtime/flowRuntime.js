// "DealerFlow" — a deliberately different agent runtime from Agent A.
// Agent A is a simple imperative service; Agent B runs work as a graph of named nodes over a shared
// state object, the way frameworks like LangGraph/Semantic Kernel planners do. The A2A protocol
// never sees this: the adapter layer (../adapters/a2aAdapter.js) translates at the boundary.
import { sleep } from '@axon-fleet/shared';

export class FlowRuntime {
  /** @param {{ name: string, nodes: Array<{ id: string, stage: string, run: (state) => Promise<object>|object, summarize?: (state) => { text: string, data?: object } }> }} def */
  constructor({ name, nodes }) {
    this.name = name;
    this.nodes = nodes;
  }

  describe() { return { runtime: 'DealerFlow', flow: this.name, nodes: this.nodes.map((n) => ({ id: n.id, stage: n.stage })) }; }

  async run(state, { onTransition, isCanceled = () => false, delayMs = 0 } = {}) {
    for (const node of this.nodes) {
      if (isCanceled()) return { status: 'canceled', state };
      if (delayMs) await sleep(delayMs);
      if (isCanceled()) return { status: 'canceled', state };
      try {
        Object.assign(state, await node.run(state));
      } catch (err) {
        return { status: 'failed', state, error: { node: node.id, message: err.message } };
      }
      await onTransition?.({ node: node.id, stage: node.stage, state, summary: node.summarize?.(state) ?? { text: node.id } });
    }
    return { status: 'completed', state };
  }
}
