import { aggregate, buildContext } from "./engine.mjs";
import { loadScope } from "./loader.mjs";

/**
 * Report registry and built-in report data. §6.1, §6.2
 * Rendering is separate (B7); compute() returns plain data with ids, names resolved later.
 */

const registry = new Map();

/**
 * @param {object} def
 * @param {string} def.id
 * @param {string} def.label           Localization key.
 * @param {boolean} [def.basic=false]  Always on, visible to everyone.
 * @param {boolean} [def.needsActor=false]  Scoped to one actor (params.actorId); runReport picks a default.
 * @param {"all"|"gm"|"owners"} [def.visibility="gm"]  Default for non-basic reports.
 * @param {object} [def.params]        Default parameters.
 * @param {(events: object[], ctx: object, params: object) => object} def.compute
 */
export function registerReport(def) {
  registry.set(def.id, { basic: false, visibility: "gm", params: {}, ...def });
}

export function getReport(id) {
  const r = registry.get(id);
  if (!r) throw new Error(`pf1-roll-statistics | unknown report "${id}"`);
  return r;
}

export function listReports() {
  return [...registry.values()];
}

const COMMON_PARAMS = { scope: { type: "day" }, includeBackfill: true };

/**
 * Load the scope's events and compute a report.
 * @param {string} id
 * @param {object} [params]
 * @param {object} [options]
 * @param {{days: string[], events: object[]}} [options.loaded]  Events already loaded for params.scope.
 * @param {(actorId: string) => boolean} [options.actorFilter]  Limits the actors offered (and chosen).
 * @returns {Promise<{id: string, params: object, days: string[], actors: string[], data: object}>}
 */
export async function runReport(id, params = {}, { loaded, actorFilter } = {}) {
  const def = getReport(id);
  const p = { ...COMMON_PARAMS, ...def.params, ...params };
  let { days, events } = loaded ?? (await loadScope(p.scope));
  if (p.includeBackfill === false) events = events.filter((e) => !e.bf);

  let actors = [...new Set(events.map((e) => e.a).filter(Boolean))];
  if (actorFilter) actors = actors.filter(actorFilter);
  if (def.needsActor && !actors.includes(p.actorId)) {
    const own = game.user.character?.id;
    p.actorId = actors.includes(own) ? own : (actors[0] ?? null);
  }
  return { id, params: p, days, actors, data: def.compute(events, buildContext(events), p) };
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** userId → whether that user rolled as a GM in these events. */
function gmUsers(events) {
  const map = new Map();
  for (const e of events) if (e.gm) map.set(e.u, true);
  return map;
}

const byDesc = (get) => (a, b) => (get(b) ?? -Infinity) - (get(a) ?? -Infinity);

function ranked(rows) {
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

/* -------------------------------------------- */
/*  diceAverages                                */
/* -------------------------------------------- */

/** Per-die averages grouped by user or actor; GM side apart. */
function diceAverages(byActor) {
  return (events, ctx, p) => {
    const gm = gmUsers(events);
    const pcActors = new Set(events.filter((e) => e.pc && e.a).map((e) => e.a));
    const rows = aggregate(events, {
      ctx,
      groupBy: (e) => (byActor ? e.a : e.u),
      metrics: { dice: { metric: "dice", opts: { activeOnly: p.activeOnly } } },
    });
    const out = { players: [], gm: [] };
    for (const [key, r] of rows) {
      if (!Object.keys(r.dice).length) continue;
      const side = byActor ? (pcActors.has(key) ? "players" : "gm") : (gm.get(key) ? "gm" : "players");
      out[side].push({ key, dice: r.dice });
    }
    return out;
  };
}

registerReport({
  id: "diceUsers",
  label: "PF1_ROLL_STATISTICS.Report.DiceUsers",
  basic: true,
  params: { activeOnly: false },
  compute: diceAverages(false),
});

registerReport({
  id: "diceActors",
  label: "PF1_ROLL_STATISTICS.Report.DiceActors",
  params: { activeOnly: false },
  compute: diceAverages(true),
});

/* -------------------------------------------- */
/*  fortune  §6.3                               */
/* -------------------------------------------- */

registerReport({
  id: "fortune",
  label: "PF1_ROLL_STATISTICS.Report.Fortune",
  basic: true,
  compute(events, ctx) {
    const gm = gmUsers(events);
    const rows = aggregate(events, {
      ctx,
      groupBy: (e) => e.u,
      metrics: {
        d20: { metric: "dice", opts: { faces: 20 } },
        // Nat 20 / nat 1 count kept dice only; dropped dice still count toward the averages. §6.3
        kept: { metric: "dice", opts: { faces: 20, activeOnly: true } },
        luck: "luck",
      },
    });

    const build = (keys) => {
      const all = keys.map((u) => {
        const r = rows.get(u);
        return { user: u, d20: r.d20[20] ?? null, kept: r.kept[20] ?? null, luck: r.luck };
      });
      const withD20 = all.filter((r) => r.d20?.count);
      return {
        d20: ranked(withD20
          .map((r) => ({ user: r.user, mean: r.d20.mean, count: r.d20.count, dev: r.d20.dev, z: r.d20.z }))
          .sort(byDesc((r) => r.mean))),
        luck: ranked(all
          .filter((r) => r.luck.count)
          .map((r) => ({ user: r.user, mean: r.luck.mean, total: r.luck.total, count: r.luck.count, z: r.luck.z }))
          .sort(byDesc((r) => r.mean))),
        naturals: all
          .filter((r) => r.kept?.count)
          .map((r) => ({
            user: r.user,
            count: r.kept.count,
            n20: r.kept.max,
            n1: r.kept.min,
            n20Rate: r.kept.max / r.kept.count,
            n1Rate: r.kept.min / r.kept.count,
          }))
          .sort(byDesc((r) => r.n20)),
      };
    };

    const users = [...rows.keys()];
    return {
      players: build(users.filter((u) => !gm.get(u))),
      gm: build(users.filter((u) => gm.get(u))),
    };
  },
});

/* -------------------------------------------- */
/*  attacks                                     */
/* -------------------------------------------- */

const ATTACK_CATEGORIES = new Set(["attack", "critConfirm", "damage", "critDamage", "healing"]);
const is = (c) => (e) => e.c === c;

registerReport({
  id: "attacks",
  label: "PF1_ROLL_STATISTICS.Report.Attacks",
  needsActor: true,
  params: { actorId: null, critMode: "separate" },
  compute(events, ctx, p) {
    const actorId = p.actorId;
    const items = new Map();
    const rows = aggregate(events, {
      ctx,
      filter: (e) => e.a === actorId && ATTACK_CATEGORIES.has(e.c),
      groupBy: (e) => {
        const key = `${e.it?.n ?? ""}|${e.it?.an ?? ""}`;
        if (!items.has(key)) items.set(key, { name: e.it?.n ?? null, action: e.it?.an ?? null, actionType: e.it?.at ?? null });
        return key;
      },
      metrics: {
        attacks: { metric: "count", filter: is("attack") },
        natural: { metric: "natural", filter: is("attack") },
        total: { metric: "total", filter: is("attack") },
        hit: { metric: "outcome", filter: is("attack") },
        threats: "threats",
        confirm: { metric: "outcome", filter: is("critConfirm") },
        damage: { metric: "damage", opts: { critMode: p.critMode } },
        critDamage: { metric: "total", filter: is("critDamage") },
        healing: { metric: "total", filter: is("healing") },
      },
    });
    return {
      actorId,
      critMode: p.critMode,
      rows: [...rows].map(([key, r]) => ({ key, ...items.get(key), ...r })).sort(byDesc((r) => r.attacks)),
    };
  },
});

/* -------------------------------------------- */
/*  checks                                      */
/* -------------------------------------------- */

const CHECK_CATEGORIES = new Set(["skill", "save", "ability", "init", "cl", "concentration", "bab"]);

registerReport({
  id: "checks",
  label: "PF1_ROLL_STATISTICS.Report.Checks",
  needsActor: true,
  params: { actorId: null },
  compute(events, ctx, p) {
    const actorId = p.actorId;
    const rows = aggregate(events, {
      ctx,
      filter: (e) => e.a === actorId && CHECK_CATEGORIES.has(e.c),
      groupBy: (e) => `${e.c}:${e.k ?? ""}`,
      metrics: { rolls: "count", natural: "natural", total: "total", outcome: "outcome" },
    });
    return {
      actorId,
      rows: [...rows].map(([key, r]) => {
        const [category, sub] = key.split(":");
        return { key, category, sub: sub || null, ...r };
      }).sort(byDesc((r) => r.rolls)),
    };
  },
});
