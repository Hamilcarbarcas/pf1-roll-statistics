import { outcome } from "./outcome.mjs";

/**
 * Pluggable reducers. §4.3
 *
 * A metric: { init(opts) → acc, add(acc, event, ctx, opts), merge(a, b) → acc, result(acc, opts) }.
 * `merge` combines partial results (per-day → multi-day).
 */

const registry = new Map();

export function registerMetric(id, def) {
  registry.set(id, def);
}

export function getMetric(id) {
  const m = registry.get(id);
  if (!m) throw new Error(`pf1-roll-statistics | unknown metric "${id}"`);
  return m;
}

const mean = (sum, count) => (count ? sum / count : null);

/* -------------------------------------------- */

/** Per die size: count, mean vs expected, z, face histogram. opts.activeOnly drops discarded dice. */
registerMetric("dice", {
  init: () => ({}),
  add(acc, e, _ctx, opts = {}) {
    for (const [faces, result, active] of e.d ?? []) {
      if (opts.activeOnly && !active) continue;
      if (opts.faces && faces !== opts.faces) continue;
      const f = (acc[faces] ??= { count: 0, sum: 0, hist: {} });
      f.count++;
      f.sum += result;
      f.hist[result] = (f.hist[result] ?? 0) + 1;
    }
  },
  merge(a, b) {
    for (const [faces, f] of Object.entries(b)) {
      const t = (a[faces] ??= { count: 0, sum: 0, hist: {} });
      t.count += f.count;
      t.sum += f.sum;
      for (const [r, n] of Object.entries(f.hist)) t.hist[r] = (t.hist[r] ?? 0) + n;
    }
    return a;
  },
  result(acc) {
    const out = {};
    for (const [key, f] of Object.entries(acc)) {
      const n = Number(key);
      const expected = (n + 1) / 2;
      const avg = mean(f.sum, f.count);
      // Uniform discrete die: variance (n² − 1) / 12.
      const se = Math.sqrt((n * n - 1) / 12 / f.count);
      out[n] = {
        faces: n,
        count: f.count,
        mean: avg,
        expected,
        dev: avg - expected,
        z: se ? (avg - expected) / se : 0,
        hist: f.hist,
        max: f.hist[n] ?? 0,
        min: f.hist[1] ?? 0,
      };
    }
    return out;
  },
});

/** Normalised luck over every die: each result scaled to −1 (a 1) … +1 (max face). §6.3 */
registerMetric("luck", {
  init: () => ({ count: 0, sum: 0, variance: 0 }),
  add(acc, e) {
    for (const [faces, result] of e.d ?? []) {
      if (faces < 2) continue;
      acc.count++;
      acc.sum += (result - (faces + 1) / 2) / ((faces - 1) / 2);
      // Variance of one normalised result: ((n² − 1) / 12) / ((n − 1) / 2)² = (n + 1) / (3(n − 1)).
      acc.variance += (faces + 1) / (3 * (faces - 1));
    }
  },
  merge: (a, b) => ({ count: a.count + b.count, sum: a.sum + b.sum, variance: a.variance + b.variance }),
  result: (acc) => ({
    count: acc.count,
    total: acc.sum,
    mean: mean(acc.sum, acc.count),
    z: acc.variance ? acc.sum / Math.sqrt(acc.variance) : 0,
  }),
});

/** Modified totals. */
registerMetric("total", {
  init: () => ({ count: 0, sum: 0, min: null, max: null }),
  add(acc, e) {
    if (!Number.isFinite(e.tot)) return;
    acc.count++;
    acc.sum += e.tot;
    acc.min = acc.min === null ? e.tot : Math.min(acc.min, e.tot);
    acc.max = acc.max === null ? e.tot : Math.max(acc.max, e.tot);
  },
  merge(a, b) {
    const pick = (x, y, fn) => (x === null ? y : y === null ? x : fn(x, y));
    return { count: a.count + b.count, sum: a.sum + b.sum, min: pick(a.min, b.min, Math.min), max: pick(a.max, b.max, Math.max) };
  },
  result: (acc) => ({ count: acc.count, mean: mean(acc.sum, acc.count), min: acc.min, max: acc.max }),
});

/** The natural d20 that counted for each roll. */
registerMetric("natural", {
  init: () => ({ count: 0, sum: 0, n20: 0, n1: 0 }),
  add(acc, e) {
    if (!Number.isFinite(e.nat)) return;
    acc.count++;
    acc.sum += e.nat;
    if (e.nat === 20) acc.n20++;
    if (e.nat === 1) acc.n1++;
  },
  merge: (a, b) => ({ count: a.count + b.count, sum: a.sum + b.sum, n20: a.n20 + b.n20, n1: a.n1 + b.n1 }),
  result: (acc) => ({ ...acc, mean: mean(acc.sum, acc.count) }),
});

/** Success / fail / unknown. §5 */
registerMetric("outcome", {
  init: () => ({ success: 0, fail: 0, unknown: 0 }),
  add(acc, e) {
    const r = outcome(e);
    if (r === true) acc.success++;
    else if (r === false) acc.fail++;
    else acc.unknown++;
  },
  merge: (a, b) => ({ success: a.success + b.success, fail: a.fail + b.fail, unknown: a.unknown + b.unknown }),
  result(acc) {
    const known = acc.success + acc.fail;
    return { ...acc, known, rate: known ? acc.success / known : null };
  },
});

/**
 * Damage per attack group. opts.critMode "combined" adds a confirmed crit's damage into its
 * group's damage. Counts damage events only; crit damage alone (no normal damage) is skipped.
 */
registerMetric("damage", {
  init: () => ({ count: 0, sum: 0 }),
  add(acc, e, ctx, opts = {}) {
    if (e.c !== "damage") return;
    let tot = e.tot;
    if (opts.critMode === "combined") {
      const crit = ctx?.groups.get(e.g)?.critDamage;
      if (crit) tot += crit.tot;
    }
    acc.count++;
    acc.sum += tot;
  },
  merge: (a, b) => ({ count: a.count + b.count, sum: a.sum + b.sum }),
  result: (acc) => ({ count: acc.count, mean: mean(acc.sum, acc.count) }),
});

/** Attacks that threatened (their group has a crit confirmation). */
registerMetric("threats", {
  init: () => ({ attacks: 0, threats: 0 }),
  add(acc, e, ctx) {
    if (e.c !== "attack") return;
    acc.attacks++;
    if (ctx?.groups.get(e.g)?.critConfirm) acc.threats++;
  },
  merge: (a, b) => ({ attacks: a.attacks + b.attacks, threats: a.threats + b.threats }),
  result: (acc) => ({ ...acc, rate: acc.attacks ? acc.threats / acc.attacks : null }),
});

registerMetric("count", {
  init: () => ({ n: 0 }),
  add(acc) {
    acc.n++;
  },
  merge: (a, b) => ({ n: a.n + b.n }),
  result: (acc) => acc.n,
});
