import { MODULE_ID, ROLL_REQUESTS_ID } from "./constants.mjs";
import { parseMessage, parseRollRequestCard, rollRequestEventId, rollRequestEntries } from "./parser.mjs";
import { dayKey } from "./settings.mjs";
import { store } from "./store.mjs";

/**
 * Live capture on the active GM. §3
 */

export function isRecorder() {
  return game.users.activeGM?.isSelf ?? false;
}

let wasRecorder = false;

/**
 * Track recorder hand-over. Gaining the role re-reads from disk (the previous recorder may have
 * written since); losing it writes what is pending.
 * @returns {Promise<boolean>} Whether this client records.
 */
async function claim() {
  const now = isRecorder();
  if (now !== wasRecorder) {
    wasRecorder = now;
    if (now) await store.reset();
    else await store.flush();
  }
  return now;
}

function run(fn) {
  fn().catch((err) => console.error(`${MODULE_ID} |`, err));
}

function safeParse(fn, msg) {
  try {
    return fn(msg);
  } catch (err) {
    console.error(`${MODULE_ID} | could not parse message ${msg.id}`, err);
    return [];
  }
}

/* -------------------------------------------- */
/*  Create                                      */
/* -------------------------------------------- */

function onCreate(msg) {
  if (!isRecorder()) return void run(claim);
  // Parsed now, so target defenses are read at roll time.
  const events = safeParse(parseMessage, msg);
  run(async () => {
    await claim();
    if (events.length) await store.add(events);
  });
}

/* -------------------------------------------- */
/*  Delete  §3.5                                */
/* -------------------------------------------- */

let pendingDeletes = null;

function onDelete(msg, options) {
  if (!isRecorder()) return;
  if (options?.deleteAll || options?.[MODULE_ID]?.keep) return;
  // One delete operation fires its hooks back to back, so a zero-delay batch holds exactly that
  // operation. More than one message means a purge, not a take-back.
  if (!pendingDeletes) {
    pendingDeletes = [];
    setTimeout(processDeletes, 0);
  }
  pendingDeletes.push({ id: msg.id, timestamp: msg.timestamp });
}

function processDeletes() {
  const batch = pendingDeletes;
  pendingDeletes = null;
  if (batch.length !== 1) return;
  const [{ id, timestamp }] = batch;
  const today = dayKey(Date.now());
  if (dayKey(timestamp) !== today) return;
  run(async () => {
    await claim();
    await store.remove(today, (e) => e.m === id);
  });
}

/* -------------------------------------------- */
/*  pf1-roll-requests  §2.3                     */
/* -------------------------------------------- */

/**
 * Add new or amended stamped results; optionally drop today's events whose entry is gone (repick, reset).
 * @param {ChatMessage} msg
 * @param {object} [options]
 * @param {boolean} [options.prune=false]
 */
async function reconcileRollRequests(msg, { prune = false } = {}) {
  const events = safeParse(parseRollRequestCard, msg);
  // replace: amendResult rewrites a stored entry's roll in place.
  if (events.length) await store.add(events, { replace: true });
  if (!prune) return;
  const live = new Set([...rollRequestEntries(msg).keys()].map((sid) => rollRequestEventId(msg.id, sid)));
  const prefix = rollRequestEventId(msg.id, "");
  await store.remove(dayKey(Date.now()), (e) => e.id.startsWith(prefix) && !live.has(e.id));
}

function onUpdate(msg, changes) {
  if (!isRecorder()) return;
  if (!changes.flags?.[ROLL_REQUESTS_ID]) return;
  run(async () => {
    await claim();
    await reconcileRollRequests(msg, { prune: true });
  });
}

/* -------------------------------------------- */
/*  Backfill  §3.4                              */
/* -------------------------------------------- */

/**
 * Record every eligible message in the chat log that isn't stored yet. Never removes anything.
 * @returns {Promise<number>} Events added.
 */
export async function rescan() {
  if (!isRecorder()) {
    console.error(`${MODULE_ID} | rescan skipped: only the active GM records.`);
    return 0;
  }
  await claim();
  const messages = game.messages.contents;
  const events = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    events.push(...safeParse(parseMessage, msg), ...safeParse(parseRollRequestCard, msg));
    if (i % 200 === 199) await new Promise((r) => setTimeout(r, 0));
  }
  const added = await store.add(events, { backfill: true });
  if (added) await store.flush();
  return added;
}

/* -------------------------------------------- */

export function startRecorder() {
  Hooks.on("createChatMessage", onCreate);
  Hooks.on("deleteChatMessage", onDelete);
  Hooks.on("updateChatMessage", onUpdate);
  Hooks.on("userConnected", () => run(claim));
  window.addEventListener("beforeunload", () => {
    if (wasRecorder) store.flush();
  });
  if (isRecorder()) run(rescan);
}
