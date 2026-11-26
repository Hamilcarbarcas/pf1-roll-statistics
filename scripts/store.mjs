import { FLUSH_DELAY_MS, MODULE_ID, STORAGE_VERSION } from "./constants.mjs";
import { dayKey } from "./settings.mjs";

/**
 * Day files in module persistent storage. §3.3
 *
 *   storage/<worldId>/index.json
 *   storage/<worldId>/days/<YYYY-MM-DD>.json
 */

function filePicker() {
  return foundry.applications.apps.FilePicker.implementation;
}

const storageRoot = () => `modules/${MODULE_ID}/storage`;
const worldDir = () => game.world.id;

/** Fetch a JSON file under this world's storage folder. Null if absent; throws on other failures. */
async function readJSON(rel) {
  const url = foundry.utils.getRoute(`${storageRoot()}/${worldDir()}/${rel}`);
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${MODULE_ID} | reading ${rel} failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Upload a JSON file into this world's storage folder.
 * uploadPersistent reports failure by returning something without a path, not by throwing.
 */
async function writeJSON(subdir, name, data) {
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  const dir = subdir ? `${worldDir()}/${subdir}` : worldDir();
  const result = await filePicker().uploadPersistent(MODULE_ID, dir, file, {}, { notify: false });
  if (!result?.path) throw new Error(`${MODULE_ID} | writing ${dir}/${name} failed`);
}

let dirsReady = null;

/** Create storage/<world>/days one level at a time; browse first so existing folders raise nothing. */
function ensureDirs() {
  dirsReady ??= (async () => {
    const days = `${storageRoot()}/${worldDir()}/days`;
    try {
      const listing = await filePicker().browse("data", days);
      if (listing && !listing.error) return;
    } catch {
      /* missing: create below */
    }
    for (const dir of [storageRoot(), `${storageRoot()}/${worldDir()}`, days]) {
      try {
        await filePicker().createDirectory("data", dir, { notify: false });
      } catch (err) {
        if (!/exist/i.test(err.message)) throw err;
      }
    }
  })().catch((err) => {
    dirsReady = null;
    throw err;
  });
  return dirsReady;
}

class Day {
  constructor(key, data) {
    this.key = key;
    this.events = new Map((data?.events ?? []).map((e) => [e.id, e]));
    this.dirty = false;
  }

  toJSON() {
    return { version: STORAGE_VERSION, world: game.world.id, day: this.key, events: [...this.events.values()] };
  }

  summary() {
    let first = Infinity;
    let last = -Infinity;
    for (const e of this.events.values()) {
      if (e.t < first) first = e.t;
      if (e.t > last) last = e.t;
    }
    return { n: this.events.size, first, last };
  }
}

export class Store {
  /** @type {Map<string, Promise<Day>>} */
  #days = new Map();
  /** @type {Promise<object>|null} */
  #index = null;
  #timer = null;
  #chain = Promise.resolve();

  /**
   * A day file, loaded once and cached. A failed read is not cached and never becomes an
   * empty day, so a flush can't overwrite a file that merely failed to load.
   * @param {string} key
   * @returns {Promise<Day>}
   */
  day(key) {
    let p = this.#days.get(key);
    if (!p) {
      p = readJSON(`days/${key}.json`).then((data) => new Day(key, data));
      p.catch(() => this.#days.delete(key));
      this.#days.set(key, p);
    }
    return p;
  }

  /** Keys of days held in memory (may include days not yet in index.json). */
  cachedKeys() {
    return [...this.#days.keys()];
  }

  /** A day already in memory, or null. Never loads. */
  peek(key) {
    return this.#days.get(key) ?? null;
  }

  /** A day's events read straight from disk, bypassing and not filling the cache. */
  async readFresh(key) {
    const data = await readJSON(`days/${key}.json`);
    return data?.events ?? [];
  }

  /** index.json read straight from disk. */
  async readIndexFresh() {
    return (await readJSON("index.json")) ?? { version: STORAGE_VERSION, days: {} };
  }

  index() {
    if (!this.#index) {
      this.#index = readJSON("index.json").then((data) => data ?? { version: STORAGE_VERSION, days: {} });
      this.#index.catch(() => { this.#index = null; });
    }
    return this.#index;
  }

  /**
   * Add events not already stored. Existing ids are left untouched.
   * @param {object[]} events
   * @param {object} [options]
   * @param {boolean} [options.backfill=false]  Mark newly added events as backfilled. §3.4
   * @param {boolean} [options.replace=false]   Overwrite a stored event whose content changed.
   * @returns {Promise<number>} Number added or replaced.
   */
  async add(events, { backfill = false, replace = false } = {}) {
    const byDay = new Map();
    for (const e of events) {
      const key = dayKey(e.t);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    let added = 0;
    for (const [key, list] of byDay) {
      const day = await this.day(key);
      for (const e of list) {
        const old = day.events.get(e.id);
        if (old) {
          if (!replace) continue;
          if (old.bf) e.bf = true;
          if (JSON.stringify(old) === JSON.stringify(e)) continue;
        } else if (backfill) e.bf = true;
        day.events.set(e.id, e);
        day.dirty = true;
        added++;
      }
    }
    if (added) this.#schedule();
    return added;
  }

  /**
   * Remove events from one day.
   * @param {string} key
   * @param {(event: object) => boolean} predicate
   * @returns {Promise<number>} Number removed.
   */
  async remove(key, predicate) {
    const day = await this.day(key);
    let removed = 0;
    for (const [id, e] of day.events) {
      if (!predicate(e)) continue;
      day.events.delete(id);
      removed++;
    }
    if (removed) {
      day.dirty = true;
      this.#schedule();
    }
    return removed;
  }

  /** Write every changed day now. Calls are serialised. */
  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#chain = this.#chain
      .then(() => this.#write())
      .catch((err) => {
        console.error(err);
        this.#schedule();
      });
    return this.#chain;
  }

  /** Flush, then drop every cached day so the next read comes from disk. */
  async reset() {
    await this.flush();
    this.#days.clear();
    this.#index = null;
  }

  /** At most FLUSH_DELAY_MS after the first unsaved change; a steady stream of rolls can't postpone it. §3.2 */
  #schedule() {
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  async #write() {
    const dirty = [];
    for (const p of this.#days.values()) {
      const day = await p.catch(() => null);
      if (day?.dirty) dirty.push(day);
    }
    if (!dirty.length) return;

    await ensureDirs();
    const index = await this.index();
    for (const day of dirty) {
      const data = day.toJSON();
      day.dirty = false;
      try {
        await writeJSON("days", `${day.key}.json`, data);
      } catch (err) {
        day.dirty = true;
        throw err;
      }
      if (day.events.size) index.days[day.key] = day.summary();
      else delete index.days[day.key];
    }
    await writeJSON("", "index.json", index);
  }
}

export const store = new Store();
