import { MODULE_ID } from "./constants.mjs";
import { aggregate, buildContext } from "./engine.mjs";
import { listDays, loadScope } from "./loader.mjs";
import { registerMetric } from "./metrics.mjs";
import { parseMessage, parseRollRequestCard } from "./parser.mjs";
import { isRecorder, rescan, startRecorder } from "./recorder.mjs";
import { listReports, registerReport, runReport } from "./reports.mjs";
import { dayKey, registerSettings } from "./settings.mjs";
import { store } from "./store.mjs";
import { openWindow, registerSocket, shareReport } from "./ui/window.mjs";

/** Public API. §8 */
const api = {
  /** Open the Roll Statistics window, optionally on a report. */
  open: (reportId) => openWindow(reportId),
  /** GM: share a computed report: share(await report("attacks", {...})). */
  share: shareReport,
  /** Write pending changes now (call before purging chat). */
  flush: () => store.flush(),
  /** Backfill from the chat log; resolves to the number of events added. */
  rescan,
  isRecorder,
  dayKey,
  /** Every day (session) with recorded events, ascending. */
  days: listDays,
  /** Compute a report's data: report("fortune", { scope: { type: "last", n: 3 } }). §6.1 */
  report: runReport,
  reports: { register: registerReport, list: listReports },
  metrics: { register: registerMetric },
  /** Ad-hoc query: scope + aggregate spec (see engine.mjs). Resolves to a Map of group → results. */
  async query({ scope, ...spec }) {
    const { events } = await loadScope(scope);
    return aggregate(events, { ...spec, ctx: buildContext(events) });
  },
  debug: {
    /** Events a message would produce, without recording them. Accepts a message or its id. */
    parse(msgOrId) {
      const msg = typeof msgOrId === "string" ? game.messages.get(msgOrId) : msgOrId;
      if (!msg) return [];
      return [...parseMessage(msg), ...parseRollRequestCard(msg)];
    },
    /** Stored events for a day (default: today). */
    async events(key = dayKey(Date.now())) {
      const day = await store.day(key);
      return [...day.events.values()];
    },
    store,
  },
};

Hooks.once("init", () => {
  registerSettings();
  game.pf1RollStatistics = api;
  game.modules.get(MODULE_ID).api = api;
});

Hooks.once("ready", () => {
  registerSocket();
  startRecorder();
});

// Button in the Journal Notes scene controls. §6.4
Hooks.on("getSceneControlButtons", (controls) => {
  const notes = controls.notes;
  if (!notes?.tools) return;
  notes.tools.pf1RollStatistics = {
    name: "pf1RollStatistics",
    title: "PF1_ROLL_STATISTICS.Control.Open",
    icon: "fa-solid fa-chart-simple",
    order: Object.keys(notes.tools).length,
    button: true,
    visible: true,
    onChange: () => openWindow(),
  };
});
