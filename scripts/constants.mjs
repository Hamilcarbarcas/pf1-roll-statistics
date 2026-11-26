export const MODULE_ID = "pf1-roll-statistics";
export const ROLL_REQUESTS_ID = "pf1-roll-requests";

/** Day-file format version. */
export const STORAGE_VERSION = 1;

/** Longest a recorded change waits in memory before it is written. §3.2 */
export const FLUSH_DELAY_MS = 60_000;

export const SETTINGS = {
  rolloverHour: "rolloverHour",
  visibility: "visibility",
};
