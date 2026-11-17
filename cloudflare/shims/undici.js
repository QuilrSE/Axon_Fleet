// "undici" stand-in for Workers. fetch() goes through the Workers runtime; requests addressed to this
// Worker's own hostname are dispatched internally to the right Durable Object (a Worker cannot call its
// own public URL over the network). Dispatchers (proxy / TLS options) do not apply on Workers.
export async function fetch(input, init = {}) {
  const { dispatcher, ...rest } = init;
  const internal = globalThis.__A2A_INTERNAL_FETCH__;
  if (internal) {
    const res = await internal(String(input), rest);
    if (res) return res;
  }
  return globalThis.fetch(input, rest);
}
export class Agent { constructor(opts) { this.opts = opts; } }
export class EnvHttpProxyAgent extends Agent {}
