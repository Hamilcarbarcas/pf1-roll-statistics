import { aggregate, buildContext } from "./engine.mjs";
import { ACTOR_CLASSES, classifyActors } from "./actor-class.mjs";
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
 * @param {boolean} [def.multiActor=false]  Covers the actors in params.actorClasses (§6.2); the actor filter applies to its events.
 * @param {"all"|"gm"|"owners"} [def.visibility="gm"]  Default for non-basic reports.
 * @param {object} [def.params]        Default parameters.
 * @param {{group: string, label: string}} [def.nav]  Show under a non-clickable group heading in the window's list.
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
 * @param {(actorId: string) => boolean} [options.actorFilter]  Limits which actors a multi-actor report covers.
 * @returns {Promise<{id: string, params: object, days: string[], data: object}>}
 */
export async function runReport(id, params = {}, { loaded, actorFilter } = {}) {
  const def = getReport(id);
  const p = { ...COMMON_PARAMS, ...def.params, ...params };
  let { days, events } = loaded ?? (await loadScope(p.scope));
  if (p.includeBackfill === false) events = events.filter((e) => !e.bf);

  if (def.multiActor && actorFilter) events = events.filter((e) => e.a && actorFilter(e.a));
  return { id, params: p, days, data: def.compute(events, buildContext(events), p) };
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
  id: "diceActors",
  label: "PF1_ROLL_STATISTICS.Report.DiceActors",
  nav: { group: "PF1_ROLL_STATISTICS.Nav.Dice", label: "PF1_ROLL_STATISTICS.Nav.Actors" },
  params: { activeOnly: false },
  compute: diceAverages(true),
});

registerReport({
  id: "diceUsers",
  label: "PF1_ROLL_STATISTICS.Report.DiceUsers",
  nav: { group: "PF1_ROLL_STATISTICS.Nav.Dice", label: "PF1_ROLL_STATISTICS.Nav.Users" },
  basic: true,
  params: { activeOnly: false },
  compute: diceAverages(false),
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
      // Fortune counts kept dice only; the dropped die of a roll-twice is ignored throughout. §6.3
      metrics: {
        kept: { metric: "dice", opts: { faces: 20, activeOnly: true } },
        luck: { metric: "luck", opts: { activeOnly: true } },
      },
    });

    const build = (keys) => {
      const all = keys.map((u) => {
        const r = rows.get(u);
        return { user: u, kept: r.kept[20] ?? null, luck: r.luck };
      });
      return {
        // d20 luck: each d20 scaled −1 (a 1) … +1 (a 20), like all-dice luck. §6.3
        d20: ranked(all
          .filter((r) => r.kept?.count)
          .map((r) => {
            const luck = (r.kept.mean - 10.5) / 9.5;
            return { user: r.user, luck, total: luck * r.kept.count, count: r.kept.count, mean: r.kept.mean };
          })
          .sort(byDesc((r) => r.luck))),
        luck: ranked(all
          .filter((r) => r.luck.count)
          .map((r) => ({ user: r.user, luck: r.luck.mean, total: r.luck.total, count: r.luck.count }))
          .sort(byDesc((r) => r.luck))),
        // Critical luck: kept d20s only; ranked by nat 20s − nat 1s, then by the rate difference.
        naturals: ranked(all
          .filter((r) => r.kept?.count)
          .map((r) => {
            const n20Rate = r.kept.max / r.kept.count;
            const n1Rate = r.kept.min / r.kept.count;
            return {
              user: r.user,
              count: r.kept.count,
              n20: r.kept.max,
              n1: r.kept.min,
              n20Rate,
              n1Rate,
              luck: r.kept.max - r.kept.min,
              luckRate: n20Rate - n1Rate,
            };
          })
          .sort((a, b) => b.luck - a.luck || b.luckRate - a.luckRate)),
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

/**
 * Split aggregate rows keyed "<actorId>|..." into per-actor sections, in actor-class order.
 * @param {Map<string, object>} rows
 * @param {Map<string, object>} info   row key → descriptive fields
 * @param {Map<string, string>} classes
 * @param {(a: object, b: object) => number} rowSort
 */
function sectionsByActor(rows, info, classes, rowSort) {
  const byActor = new Map();
  for (const [key, r] of rows) {
    const actorId = key.split("|")[0];
    let section = byActor.get(actorId);
    if (!section) byActor.set(actorId, (section = { actorId, class: classes.get(actorId), rows: [] }));
    section.rows.push({ key, ...info.get(key), ...r });
  }
  const sections = [...byActor.values()];
  for (const sec of sections) sec.rows.sort(rowSort);
  sections.sort((a, b) => ACTOR_CLASSES.indexOf(a.class) - ACTOR_CLASSES.indexOf(b.class));
  return sections;
}

registerReport({
  id: "attacks",
  label: "PF1_ROLL_STATISTICS.Report.Attacks",
  multiActor: true,
  // byAction false merges an item's actions into one row.
  params: { actorClasses: ["pc"], byAction: true },
  compute(events, ctx, p) {
    const wanted = new Set(p.actorClasses ?? []);
    const classes = classifyActors(events);
    const items = new Map();
    const rows = aggregate(events, {
      ctx,
      filter: (e) => e.a && ATTACK_CATEGORIES.has(e.c) && wanted.has(classes.get(e.a)),
      groupBy: (e) => {
        const action = p.byAction === false ? null : (e.it?.an ?? null);
        const key = `${e.a}|${e.it?.n ?? ""}|${action ?? ""}`;
        if (!items.has(key)) items.set(key, { name: e.it?.n ?? null, action, actionType: action ? (e.it?.at ?? null) : null });
        return key;
      },
      metrics: {
        attacks: { metric: "count", filter: is("attack") },
        natural: { metric: "natural", filter: is("attack") },
        total: { metric: "total", filter: is("attack") },
        hit: { metric: "outcome", filter: is("attack") },
        threats: "threats",
        confirm: { metric: "outcome", filter: is("critConfirm") },
        // Crit damage is always folded into its attack's damage.
        damage: { metric: "damage", opts: { critMode: "combined" } },
        healing: { metric: "total", filter: is("healing") },
      },
    });
    return { actorClasses: [...wanted], byAction: p.byAction !== false, actors: sectionsByActor(rows, items, classes, byDesc((r) => r.attacks)) };
  },
});

/* -------------------------------------------- */
/*  checks                                      */
/* -------------------------------------------- */

const CHECK_CATEGORIES = new Set(["skill", "save", "ability", "init", "cl", "concentration", "bab"]);

registerReport({
  id: "checks",
  label: "PF1_ROLL_STATISTICS.Report.Checks",
  multiActor: true,
  params: { actorClasses: ["pc"] },
  compute(events, ctx, p) {
    const wanted = new Set(p.actorClasses ?? []);
    const classes = classifyActors(events);
    const info = new Map();
    const rows = aggregate(events, {
      ctx,
      filter: (e) => e.a && CHECK_CATEGORIES.has(e.c) && wanted.has(classes.get(e.a)),
      groupBy: (e) => {
        const key = `${e.a}|${e.c}|${e.k ?? ""}`;
        if (!info.has(key)) info.set(key, { category: e.c, sub: e.k ?? null });
        return key;
      },
      metrics: { rolls: "count", natural: "natural", total: "total", outcome: "outcome" },
    });
    return { actorClasses: [...wanted], actors: sectionsByActor(rows, info, classes, byDesc((r) => r.rolls)) };
  },
});
