import { MODULE_ID, SETTINGS } from "./constants.mjs";

let rolloverHour = 4;

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.rolloverHour, {
    name: "PF1_ROLL_STATISTICS.Setting.RolloverHour.Name",
    hint: "PF1_ROLL_STATISTICS.Setting.RolloverHour.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 23, step: 1 },
    default: 4,
    onChange: (value) => { rolloverHour = value; },
  });
  rolloverHour = game.settings.get(MODULE_ID, SETTINGS.rolloverHour);

  // Per-report visibility overrides for non-basic reports: { [reportId]: "all" | "gm" | "owners" }.
  game.settings.register(MODULE_ID, SETTINGS.visibility, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
}

/**
 * Session key for a timestamp: the local date, with the day starting at the rollover hour. §7
 * @param {number} timestamp
 * @returns {string} YYYY-MM-DD
 */
export function dayKey(timestamp) {
  const d = new Date(timestamp - rolloverHour * 3_600_000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
