import { MODULE_ID } from "../constants.mjs";
import { listDays, loadScope } from "../loader.mjs";
import { getReport, listReports, runReport } from "../reports.mjs";
import { dayKey } from "../settings.mjs";
import { actorFilter, canSee, getVisibility, setVisibility, VISIBILITY } from "../visibility.mjs";
import { ACTOR_CLASSES } from "../actor-class.mjs";
import { formatDay, renderReport, scopeLabel, userName } from "./render.mjs";

/**
 * Roll Statistics window. §6.4
 * Live mode: report list + controls, computed on this client.
 * Snapshot mode (options.snapshot): a report a GM shared, shown as sent.
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const L = (key, data) =>
  data ? game.i18n.format(`PF1_ROLL_STATISTICS.${key}`, data) : game.i18n.localize(`PF1_ROLL_STATISTICS.${key}`);

const SOCKET = `module.${MODULE_ID}`;
const WINDOW_ID = "pf1-roll-statistics";

/** "PCs, Foes" — or "None" when nothing is ticked. */
function classSummary(classes) {
  const picked = ACTOR_CLASSES.filter((c) => classes.includes(c));
  if (!picked.length) return L("ActorClass.none");
  if (picked.length === ACTOR_CLASSES.length) return L("ActorClass.all");
  return picked.map((c) => L(`ActorClass.${c}`)).join(", ");
}

/** Report list entries; grouped reports get one heading (not clickable) with their items indented below. */
function navEntries(reports, activeId) {
  const out = [];
  const seen = new Set();
  for (const r of reports) {
    const group = r.nav?.group;
    if (group && !seen.has(group)) {
      seen.add(group);
      out.push({ heading: true, label: game.i18n.localize(group) });
    }
    out.push({
      id: r.id,
      label: game.i18n.localize(r.nav?.label ?? r.label),
      active: r.id === activeId,
      indent: !!group,
    });
  }
  return out;
}

function option(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
}

export class StatsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: WINDOW_ID,
    classes: ["pf1-roll-statistics"],
    window: { title: "PF1_ROLL_STATISTICS.Title", icon: "fa-solid fa-chart-simple", resizable: true },
    position: { width: 1300, height: 850 },
    actions: {
      selectReport: StatsWindow.#onSelectReport,
      refresh: StatsWindow.#onRefresh,
      share: StatsWindow.#onShare,
      histogram: StatsWindow.#onHistogram,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/window.hbs`, scrollable: [".prs-body"] },
  };

  #reportId = "diceUsers";
  /** reportId → params */
  #params = {};
  /** JSON(scope) → Promise<{days, events}> */
  #cache = new Map();
  #histogram = null;
  #last = null;
  /** Whether the actor-class dropdown is open, kept across re-renders. */
  #classesOpen = false;

  get snapshot() {
    return this.options.snapshot ?? null;
  }

  /** Switch to a report (live mode). */
  show(reportId) {
    if (reportId && listReports().some((r) => r.id === reportId)) {
      this.#reportId = reportId;
      this.#histogram = null;
    }
    return this.render({ force: true });
  }

  #load(scope) {
    const key = JSON.stringify(scope);
    let p = this.#cache.get(key);
    if (!p) {
      p = loadScope(scope);
      p.catch(() => this.#cache.delete(key));
      this.#cache.set(key, p);
    }
    return p;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (this.snapshot) return { ...context, ...this.#snapshotContext() };

    const reports = listReports().filter((r) => canSee(r));
    if (!reports.some((r) => r.id === this.#reportId)) this.#reportId = reports[0]?.id;
    if (!this.#reportId) return { ...context, reports: [], controls: "", body: "" };

    const def = getReport(this.#reportId);
    const params = (this.#params[def.id] ??= {});
    params.scope ??= { type: "day" };
    // A session scope without a day shows the most recent day that has rolls.
    if (params.scope.type === "day" && !params.scope.day) {
      params.scope = { type: "day", day: (await listDays()).at(-1) ?? dayKey(Date.now()) };
    }
    let body;
    let result = null;
    try {
      const loaded = await this.#load(params.scope);
      result = await runReport(def.id, params, { loaded, actorFilter: actorFilter(def) });
      body = renderReport(result, { histogram: this.#histogram });
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      body = `<p class="prs-empty">${esc(L("LoadError"))}</p>`;
    }
    this.#last = result;

    return {
      ...context,
      reports: navEntries(reports, def.id),
      controls: await this.#controls(def, params, result),
      body,
    };
  }

  #snapshotContext() {
    const r = this.snapshot;
    const def = getReport(r.id);
    const parts = [game.i18n.localize(def.label), scopeLabel(r)];
    if (r.params.actorClasses) parts.push(classSummary(r.params.actorClasses));
    return {
      reports: [],
      controls: `<div class="prs-shared">${esc(L("Shared.Header", { user: userName(r.from) }))}:
        <strong>${esc(parts.join(" — "))}</strong></div>`,
      body: renderReport(r, { histogram: this.#histogram }),
    };
  }

  async #controls(def, params, result) {
    const scope = params.scope;
    const out = [];

    out.push(`<label>${esc(L("Scope.Label"))}<select name="scopeType">
      ${option("day", L("Scope.Day"), scope.type === "day")}
      ${option("last", L("Scope.Last"), scope.type === "last")}
      ${option("lifetime", L("Scope.Lifetime"), scope.type === "lifetime")}</select></label>`);

    if (scope.type === "day") {
      const days = (await listDays()).reverse();
      if (days.length) {
        out.push(`<select name="day">${days.map((d) => option(d, formatDay(d), d === scope.day)).join("")}</select>`);
      }
    } else if (scope.type === "last") {
      out.push(`<input type="number" name="lastN" min="1" step="1" value="${scope.n ?? 3}">`);
    }

    if (def.id === "attacks") {
      out.push(`<label class="prs-check"><input type="checkbox" name="byAction"${params.byAction === false ? "" : " checked"}>
        ${esc(L("Control.ShowActions"))}</label>`);
    }

    if (def.multiActor) {
      const chosen = new Set(params.actorClasses ?? def.params.actorClasses ?? []);
      const boxes = ACTOR_CLASSES.map((c) => `<label class="prs-check">
        <input type="checkbox" name="actorClass" value="${c}"${chosen.has(c) ? " checked" : ""}>
        ${esc(L(`ActorClass.${c}`))}</label>`).join("");
      out.push(`<details class="prs-multi"${this.#classesOpen ? " open" : ""}>
        <summary>${esc(classSummary([...chosen]))}</summary><div class="prs-multi-list">${boxes}</div></details>`);
    }

    out.push(`<span class="prs-spacer"></span>`);

    if (game.user.isGM && !def.basic) {
      const v = getVisibility(def);
      out.push(`<label>${esc(L("Control.Visibility"))}<select name="visibility">
        ${VISIBILITY.map((k) => option(k, L(`Visibility.${k}`), k === v)).join("")}</select></label>`);
    }
    if (game.user.isGM) {
      out.push(`<button type="button" class="prs-btn" data-action="share" data-tooltip="${esc(L("Tooltip.Share"))}">
        <i class="fa-solid fa-share-from-square"></i> ${esc(L("Control.Share"))}</button>`);
    }
    out.push(`<button type="button" class="prs-btn prs-icon-btn" data-action="refresh" data-tooltip="${esc(L("Tooltip.Refresh"))}">
      <i class="fa-solid fa-rotate"></i></button>`);

    return out.join("");
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector(".prs-controls")?.addEventListener("change", (ev) => this.#onControlChange(ev));
    this.element.querySelector(".prs-multi")?.addEventListener("toggle", (ev) => { this.#classesOpen = ev.target.open; });
  }

  async #onControlChange(event) {
    if (this.snapshot) return;
    const el = event.target;
    const def = getReport(this.#reportId);
    const params = (this.#params[def.id] ??= {});
    switch (el.name) {
      case "scopeType":
        if (el.value === "day") params.scope = { type: "day" };
        else if (el.value === "last") params.scope = { type: "last", n: params.lastN ?? 3 };
        else params.scope = { type: "lifetime" };
        this.#histogram = null;
        break;
      case "day":
        params.scope = { type: "day", day: el.value };
        this.#histogram = null;
        break;
      case "lastN":
        params.lastN = Math.max(1, Math.floor(Number(el.value) || 1));
        params.scope = { type: "last", n: params.lastN };
        this.#histogram = null;
        break;
      case "byAction":
        params.byAction = el.checked;
        break;
      case "actorClass":
        params.actorClasses = [...this.element.querySelectorAll('input[name="actorClass"]:checked')].map((i) => i.value);
        break;
      case "visibility":
        await setVisibility(def, el.value);
        break;
      default:
        return;
    }
    this.render();
  }

  static #onSelectReport(event, target) {
    this.#reportId = target.dataset.report;
    this.#histogram = null;
    this.render();
  }

  static #onRefresh() {
    this.#cache.clear();
    this.render();
  }

  static #onHistogram(event, target) {
    const key = target.dataset.key;
    const faces = Number(target.dataset.faces);
    const same = this.#histogram?.key === key && this.#histogram?.faces === faces;
    this.#histogram = same ? null : { key, faces };
    this.render();
  }

  static async #onShare() {
    if (this.#last) await shareReport(this.#last);
  }
}

/* -------------------------------------------- */
/*  Opening                                     */
/* -------------------------------------------- */

export function openWindow(reportId) {
  const app = foundry.applications.instances.get(WINDOW_ID) ?? new StatsWindow();
  return app.show(reportId);
}

/* -------------------------------------------- */
/*  Sharing  §6.4                               */
/* -------------------------------------------- */

/** GM: push a computed report to chosen players, who see it in a snapshot window. */
export async function shareReport(result) {
  if (!game.user.isGM) return;
  const players = game.users.filter((u) => u.active && !u.isGM);
  if (!players.length) {
    ui.notifications.warn(L("Shared.NoPlayers"));
    return;
  }
  const content = `<div class="pf1-roll-statistics-share">${players
    .map((u) => `<label class="checkbox"><input type="checkbox" name="user" value="${u.id}" checked> ${esc(u.name)}</label>`)
    .join("")}</div>`;
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: L("Shared.DialogTitle"), icon: "fa-solid fa-share-from-square" },
    content,
    buttons: [
      {
        action: "share",
        label: L("Control.Share"),
        icon: "fa-solid fa-share-from-square",
        default: true,
        callback: (event, button) =>
          [...button.form.querySelectorAll('input[name="user"]:checked')].map((i) => i.value),
      },
      { action: "cancel", label: L("Shared.Cancel") },
    ],
    rejectClose: false,
  });
  if (!Array.isArray(picked) || !picked.length) return;
  game.socket.emit(SOCKET, { type: "share", users: picked, from: game.user.id, report: result });
  ui.notifications.info(L("Shared.Sent", { n: picked.length }));
}

function openSnapshot(report, from) {
  const app = new StatsWindow({
    id: `${WINDOW_ID}-shared-${foundry.utils.randomID()}`,
    snapshot: { ...report, from },
  });
  app.render({ force: true });
}

export function registerSocket() {
  game.socket.on(SOCKET, (msg) => {
    if (msg?.type !== "share" || !msg.users?.includes(game.user.id)) return;
    try {
      openSnapshot(msg.report, msg.from);
    } catch (err) {
      console.error(`${MODULE_ID} | could not show shared report`, err);
    }
  });
}
