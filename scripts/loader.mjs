import { isRecorder } from "./recorder.mjs";
import { dayKey } from "./settings.mjs";
import { store } from "./store.mjs";

/**
 * Events for a report scope. §6.1
 */

/** Every day with events, ascending. */
export async function listDays() {
  const recorder = isRecorder();
  const index = recorder ? await store.index() : await store.readIndexFresh();
  const keys = new Set(Object.keys(index.days ?? {}));
  // Unflushed days exist only in the recorder's memory.
  if (recorder) for (const k of store.cachedKeys()) keys.add(k);
  return [...keys].sort();
}

/**
 * Day keys a scope covers.
 * @param {{type: "day", day?: string}|{type: "last", n: number}|{type: "lifetime"}|{type: "days", days: string[]}} scope
 */
export async function scopeDays(scope = { type: "day" }) {
  switch (scope.type) {
    case "day":
      return [scope.day ?? dayKey(Date.now())];
    case "days":
      return [...scope.days];
    case "last":
      return (await listDays()).slice(-Math.max(1, scope.n ?? 1));
    case "lifetime":
      return listDays();
    default:
      throw new Error(`pf1-roll-statistics | unknown scope type "${scope.type}"`);
  }
}

async function readDay(key) {
  if (isRecorder()) {
    const cached = store.peek(key);
    if (cached) return [...(await cached).events.values()];
  }
  return store.readFresh(key);
}

/** @returns {Promise<{days: string[], events: object[]}>} */
export async function loadScope(scope) {
  const days = await scopeDays(scope);
  const events = (await Promise.all(days.map(readDay))).flat();
  return { days, events };
}
