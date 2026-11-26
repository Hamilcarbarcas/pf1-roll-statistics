import { getMetric } from "./metrics.mjs";

/**
 * Group-and-reduce over events. §6.1
 */

/** Attack-group index: g → { attack, critConfirm, damage, critDamage, healing }. */
export function buildContext(events) {
  const groups = new Map();
  for (const e of events) {
    if (!e.g) continue;
    let g = groups.get(e.g);
    if (!g) groups.set(e.g, (g = {}));
    g[e.c] = e;
  }
  return { groups };
}

/**
 * @param {object[]} events
 * @param {object} spec
 * @param {(e: object) => boolean} [spec.filter]
 * @param {(e: object) => (string|string[]|null)} [spec.groupBy]  Null/empty skips the event.
 * @param {Record<string, string|{metric: string, opts?: object, filter?: (e: object) => boolean}>} spec.metrics
 *   Output key → metric id, or a metric with options and its own event filter.
 * @param {object} [spec.ctx]
 * @returns {Map<string, Record<string, any>>} group key → metric results
 */
export function aggregate(events, { filter, groupBy, metrics, ctx = buildContext(events) }) {
  const specs = Object.entries(metrics).map(([key, s]) => {
    const def = typeof s === "string" ? { metric: s } : s;
    return { key, m: getMetric(def.metric), opts: def.opts ?? {}, filter: def.filter };
  });
  const accs = new Map();
  for (const e of events) {
    if (filter && !filter(e)) continue;
    const raw = groupBy ? groupBy(e) : "all";
    const keys = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    for (const k of keys) {
      let acc = accs.get(k);
      if (!acc) accs.set(k, (acc = specs.map((s) => s.m.init(s.opts))));
      specs.forEach((s, i) => {
        if (!s.filter || s.filter(e)) s.m.add(acc[i], e, ctx, s.opts);
      });
    }
  }
  const out = new Map();
  for (const [k, acc] of accs) {
    const row = {};
    specs.forEach((s, i) => { row[s.key] = s.m.result(acc[i], s.opts); });
    out.set(k, row);
  }
  return out;
}
