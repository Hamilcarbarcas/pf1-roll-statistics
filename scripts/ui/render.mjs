import { getReport } from "../reports.mjs";

/**
 * Report data → HTML. Names are resolved here, on the viewing client. §6.1, §6.4
 */

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const L = (key, data) =>
  data ? game.i18n.format(`PF1_ROLL_STATISTICS.${key}`, data) : game.i18n.localize(`PF1_ROLL_STATISTICS.${key}`);

const STANDARD_DICE = [4, 6, 8, 10, 12, 20];
const DASH = "–";

/* -------------------------------------------- */
/*  Formatting                                  */
/* -------------------------------------------- */

function num(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : DASH;
}

function signed(v, digits = 2) {
  if (!Number.isFinite(v)) return DASH;
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s.replace("-", "−");
}

function pct(v, digits = 1) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : DASH;
}

const n = (count) => `<span class="prs-n">(${count})</span>`;

/** Green above expected, red below. §6.5 */
function luckClass(deviation) {
  if (!Number.isFinite(deviation) || deviation === 0) return "";
  return deviation > 0 ? "prs-good" : "prs-bad";
}

function meanCell(stat) {
  return stat?.count ? `${num(stat.mean)} ${n(stat.count)}` : DASH;
}

export function userName(id) {
  return game.users.get(id)?.name ?? L("UnknownUser");
}

export function actorName(id) {
  return game.actors.get(id)?.name ?? L("UnknownActor");
}

const CATEGORY_KEYS = {
  init: "Category.Init",
  bab: "Category.Bab",
  cl: "Category.Cl",
  concentration: "Category.Concentration",
};

function checkLabel(category, sub, actorId) {
  if (CATEGORY_KEYS[category]) return L(CATEGORY_KEYS[category]);
  const cfg = globalThis.pf1?.config ?? {};
  if (category === "save") return cfg.savingThrows?.[sub] ?? sub;
  if (category === "ability") return cfg.abilities?.[sub] ?? sub;
  if (category === "skill") {
    return game.actors.get(actorId)?.getSkillInfo?.(sub)?.fullName ?? cfg.skills?.[sub] ?? sub;
  }
  return sub ?? category;
}

function itemLabel(row) {
  const name = row.name ?? L("UnknownItem");
  return row.action && row.action !== name ? `${name} (${row.action})` : name;
}

/** Day key (YYYY-MM-DD) shown as MM-DD-YYYY. Keys stay year-first for sorting and file names. */
export function formatDay(key) {
  const [y, m, d] = String(key).split("-");
  return y && m && d ? `${m}-${d}-${y}` : String(key ?? "");
}

/** "11-26-2026", "Last 3 sessions", "Lifetime". */
export function scopeLabel(result) {
  const s = result.params.scope ?? { type: "day" };
  const days = result.days ?? [];
  if (s.type === "day") return days[0] ? formatDay(days[0]) : "";
  if (s.type === "last") return L("Scope.LastLabel", { n: days.length });
  if (s.type === "lifetime") return L("Scope.LifetimeLabel", { n: days.length });
  return days.map(formatDay).join(", ");
}

const empty = () => `<p class="prs-empty">${esc(L("Empty"))}</p>`;

/** Player rows, then GM rows in their own section, set off by a rule instead of a label row. */
function tableBodies(playerRows, gmRows, cols) {
  if (!playerRows.length && !gmRows.length) return `<tbody><tr><td colspan="${cols}">${DASH}</td></tr></tbody>`;
  const players = playerRows.length ? `<tbody>${playerRows.join("")}</tbody>` : "";
  const gm = gmRows.length ? `<tbody class="prs-gm">${gmRows.join("")}</tbody>` : "";
  return players + gm;
}

/* -------------------------------------------- */
/*  Dice averages                               */
/* -------------------------------------------- */

function histogram(row, faces, name) {
  const stat = row?.dice?.[faces];
  if (!stat) return "";
  // Large dice are bucketed into tenths so the chart stays readable.
  const bucket = faces > 20 ? faces / 10 : 1;
  const bars = [];
  for (let lo = 1; lo <= faces; lo += bucket) {
    const hi = lo + bucket - 1;
    let count = 0;
    for (let f = lo; f <= hi; f++) count += stat.hist[f] ?? 0;
    bars.push({ label: bucket === 1 ? `${lo}` : `${lo}–${hi}`, count });
  }
  const expected = stat.count / bars.length;
  const top = Math.max(expected, ...bars.map((b) => b.count)) || 1;
  const html = bars
    .map((b) => {
      const h = (b.count / top) * 100;
      return `<div class="prs-bar-wrap" data-tooltip="${esc(`${b.label}: ${b.count}`)}">
        <div class="prs-bar" style="height:${h.toFixed(1)}%"></div><span class="prs-bar-label">${esc(b.label)}</span></div>`;
    })
    .join("");
  return `<div class="prs-histogram">
    <h3>${esc(L("Histogram.Title", { name, faces, count: stat.count }))}</h3>
    <div class="prs-bars">${html}<div class="prs-expected" style="bottom:calc(18px + (100% - 18px) * ${(expected / top).toFixed(3)})"
      data-tooltip="${esc(L("Histogram.Expected", { n: num(expected, 1) }))}"></div></div>
  </div>`;
}

function renderDice(result, { histogram: selected } = {}, byActor) {
  const { players, gm } = result.data;
  if (!players.length && !gm.length) return empty();
  const name = (key) => (byActor ? actorName(key) : userName(key));
  const present = new Set(STANDARD_DICE);
  for (const r of [...players, ...gm]) for (const f of Object.keys(r.dice)) present.add(Number(f));
  const faces = [...present].sort((a, b) => a - b);
  const cols = faces.length + 1;

  const row = (r) => {
    const cells = faces.map((f) => {
      const s = r.dice[f];
      if (!s) return `<td class="prs-num">${DASH}</td>`;
      const tip = L("Tooltip.Die", { expected: num(s.expected), dev: signed(s.dev) });
      const active = selected?.key === r.key && selected?.faces === f ? " prs-selected" : "";
      return `<td class="prs-num prs-click ${luckClass(s.dev)}${active}" data-action="histogram"
        data-key="${esc(r.key)}" data-faces="${f}" data-tooltip="${esc(tip)}">${num(s.mean)} ${n(s.count)}</td>`;
    });
    return `<tr><th scope="row">${esc(name(r.key))}</th>${cells.join("")}</tr>`;
  };
  const sortByName = (rows) => [...rows].sort((a, b) => name(a.key).localeCompare(name(b.key)));

  const head = `<tr><th class="prs-name">${esc(L(byActor ? "Col.Actor" : "Col.User"))}</th>${faces.map((f) => `<th class="prs-num">d${f}</th>`).join("")}</tr>`;
  const bodies = tableBodies(sortByName(players).map(row), sortByName(gm).map(row), cols);

  const sel = selected && [...players, ...gm].find((r) => r.key === selected.key);
  return `<table class="prs-table prs-fixed"><thead>${head}</thead>${bodies}</table>
    ${sel ? histogram(sel, selected.faces, name(sel.key)) : `<p class="prs-hint">${esc(L("Hint.Histogram"))}</p>`}`;
}

/* -------------------------------------------- */
/*  Fortune                                     */
/* -------------------------------------------- */

function renderFortune(result) {
  const { players, gm } = result.data;
  const hasAny = (side) => side.d20.length || side.luck.length || side.naturals.length;
  if (!hasAny(players) && !hasAny(gm)) return empty();

  // Header cells: { label (HTML), cls?, span? }. A span of 2 sits over a count/percent sub-cell pair.
  const table = (title, head, side, rowFn) => {
    const cols = head.reduce((sum, h) => sum + (h.span ?? 1), 0);
    const bodies = tableBodies(side(players).map((x) => rowFn(x, true)), side(gm).map((x) => rowFn(x, false)), cols);
    const ths = head
      .map((h) => `<th${h.cls ? ` class="${h.cls}"` : ""}${h.span ? ` colspan="${h.span}"` : ""}>${h.label}</th>`)
      .join("");
    return `<section class="prs-fortune-part"><h3>${esc(L(title))}</h3>
      <table class="prs-table prs-fixed"><thead><tr>${ths}</tr></thead>
      ${bodies}</table></section>`;
  };

  const rank = { label: "#", cls: "prs-rank" };
  const user = { label: esc(L("Col.User")), cls: "prs-name" };
  const lead = (x, ranked) => `<td>${ranked ? x.rank : ""}</td><th scope="row">${esc(userName(x.user))}</th>`;
  const luckRow = (x, ranked) => `<tr>${lead(x, ranked)}
      <td class="prs-num ${luckClass(x.luck)}">${signed(x.luck * 100, 1)}%</td>
      <td class="prs-num">${signed(x.total, 1)}</td><td class="prs-num">${x.count}</td></tr>`;
  const luckTip = (key) => `<span data-tooltip="${esc(L(key))}">${esc(L("Col.Luck"))}</span>`;

  const d20 = table(
    "Fortune.D20",
    [rank, user, { label: luckTip("Tooltip.D20Luck") }, { label: esc(L("Col.Total")) }, { label: esc(L("Col.Dice")) }],
    (s) => s.d20,
    luckRow,
  );
  const luck = table(
    "Fortune.Luck",
    [rank, user, { label: luckTip("Tooltip.Luck") }, { label: esc(L("Col.Total")) }, { label: esc(L("Col.Dice")) }],
    (s) => s.luck,
    luckRow,
  );
  const signedInt = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
  const crit = table(
    "Fortune.Naturals",
    [
      rank,
      user,
      { label: luckTip("Tooltip.CritLuck"), span: 2 },
      { label: esc(L("Col.Nat20")), span: 2 },
      { label: esc(L("Col.Nat1")), span: 2 },
      { label: esc(L("Col.Dice")) },
    ],
    (s) => s.naturals,
    (x, ranked) => `<tr>${lead(x, ranked)}
      <td class="prs-num ${luckClass(x.luck)}">${signedInt(x.luck)}</td>
      <td class="prs-num prs-sub ${luckClass(x.luckRate)}">${signed(x.luckRate * 100, 0)}%</td>
      <td class="prs-num">${x.n20}</td><td class="prs-num prs-sub">${pct(x.n20Rate, 0)}</td>
      <td class="prs-num">${x.n1}</td><td class="prs-num prs-sub">${pct(x.n1Rate, 0)}</td>
      <td class="prs-num">${x.count}</td></tr>`,
  );
  return `<div class="prs-fortune">${d20}${luck}${crit}</div>`;
}

/* -------------------------------------------- */
/*  Attacks                                     */
/* -------------------------------------------- */

/**
 * One table for all actors: a single header row (sticky while scrolling), a heading row per actor
 * class (actors arrive sorted by class), then per actor a name row and its rows.
 */
function actorTable(actors, labels, row) {
  const cols = labels.length;
  let lastClass = null;
  const bodies = actors
    .map((a) => {
      let classHead = "";
      if (a.class !== lastClass) {
        lastClass = a.class;
        classHead = `<tbody class="prs-class"><tr class="prs-class-row"><th colspan="${cols}">${esc(L(`ActorClass.${a.class}`))}</th></tr></tbody>`;
      }
      return `${classHead}<tbody class="prs-actor">
    <tr class="prs-actor-row"><th colspan="${cols}">${esc(actorName(a.actorId))}</th></tr>
    ${a.rows.map((r) => row(r, a)).join("")}</tbody>`;
    })
    .join("");
  return `<table class="prs-table prs-fixed prs-sections">${headerRow(labels)}${bodies}</table>`;
}

function headerRow(labels) {
  return `<thead><tr>${labels.map((h, i) => `<th${i === 0 ? ' class="prs-name"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>`;
}

/** Percentage only; the known-outcome count goes in the tooltip. */
function rateCell(outcome) {
  if (!outcome?.known) return `<td class="prs-num">${DASH}</td>`;
  return `<td class="prs-num" data-tooltip="${esc(L("OfKnown", { n: outcome.known }))}">${pct(outcome.rate)}</td>`;
}

function renderAttacks(result) {
  const { actors } = result.data;
  if (!actors.length) return empty();
  // Same columns for every actor so the stacked tables line up.
  const anyHealing = actors.some((a) => a.rows.some((r) => r.healing?.count));
  const head = [
    L(result.data.byAction === false ? "Col.ItemOnly" : "Col.Item"), L("Col.Attacks"), L("Col.AvgRoll"), L("Col.AvgHit"), L("Col.Hit"), L("Col.Damage"),
    ...(anyHealing ? [L("Col.Healing")] : []),
    L("Col.Threats"), L("Col.Confirmed"),
  ];

  const row = (r) => {
    const atk = r.attacks > 0;
    const confirmed = atk && r.confirm.known
      ? `<td class="prs-num" data-tooltip="${esc(L("OfKnown", { n: r.confirm.known }))}">${r.confirm.success}</td>`
      : `<td class="prs-num">${DASH}</td>`;
    const cells = [
      `<th scope="row">${esc(itemLabel(r))}</th>`,
      `<td class="prs-num">${atk ? r.attacks : DASH}</td>`,
      `<td class="prs-num">${atk ? num(r.natural.mean) : DASH}</td>`,
      `<td class="prs-num">${atk ? num(r.total.mean) : DASH}</td>`,
      atk ? rateCell(r.hit) : `<td class="prs-num">${DASH}</td>`,
      `<td class="prs-num">${meanCell(r.damage)}</td>`,
      ...(anyHealing ? [`<td class="prs-num">${meanCell(r.healing)}</td>`] : []),
      `<td class="prs-num">${atk ? `${r.threats.threats} <span class="prs-n">${pct(r.threats.rate, 0)}</span>` : DASH}</td>`,
      confirmed,
    ];
    return `<tr>${cells.join("")}</tr>`;
  };

  return `${actorTable(actors, head, row)}<p class="prs-hint">${esc(L("Hint.Attacks"))}</p>`;
}

/* -------------------------------------------- */
/*  Checks                                      */
/* -------------------------------------------- */

const CHECK_ORDER = ["save", "init", "skill", "ability", "cl", "concentration", "bab"];

function renderChecks(result) {
  const { actors } = result.data;
  if (!actors.length) return empty();
  const order = (r) => CHECK_ORDER.indexOf(r.category);
  const labels = [L("Col.Check"), L("Col.Rolls"), L("Col.AvgRoll"), L("Col.AvgTotal"), L("Col.Success")];
  const row = (r, a) => `<tr><th scope="row">${esc(checkLabel(r.category, r.sub, a.actorId))}</th>
      <td class="prs-num">${r.rolls}</td><td class="prs-num">${num(r.natural.mean)}</td>
      <td class="prs-num">${num(r.total.mean)}</td>${rateCell(r.outcome)}</tr>`;
  const sorted = actors.map((a) => ({ ...a, rows: [...a.rows].sort((x, y) => order(x) - order(y) || y.rolls - x.rolls) }));
  return actorTable(sorted, labels, row);
}

/* -------------------------------------------- */

const RENDERERS = {
  diceUsers: (r, o) => renderDice(r, o, false),
  diceActors: (r, o) => renderDice(r, o, true),
  fortune: renderFortune,
  attacks: renderAttacks,
  checks: renderChecks,
};

/**
 * @param {object} result   runReport() result (or a shared snapshot of one).
 * @param {object} [options]
 * @returns {string} HTML
 */
export function renderReport(result, options = {}) {
  const def = getReport(result.id);
  const fn = def.render ?? RENDERERS[result.id];
  if (!fn) return `<pre>${esc(JSON.stringify(result.data, null, 2))}</pre>`;
  return fn(result, options);
}
