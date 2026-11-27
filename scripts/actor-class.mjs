/**
 * Actor classes for multi-actor reports. §6.2
 *   pc         — a user's assigned character
 *   playerNpc  — any other player-owned actor
 *   npc        — friendly or neutral
 *   foe        — hostile or secret (and deleted actors with no recorded disposition)
 */

export const ACTOR_CLASSES = ["pc", "playerNpc", "npc", "foe"];

/**
 * Class for every actor in the events. Disposition comes from the token the actor last rolled with
 * (`dp`), falling back to the actor's prototype token for events recorded before `dp` existed.
 * @param {object[]} events
 * @returns {Map<string, string>}
 */
export function classifyActors(events) {
  const lastDisposition = new Map();
  const ids = new Set();
  for (const e of events) {
    if (!e.a) continue;
    ids.add(e.a);
    if (Number.isFinite(e.dp)) lastDisposition.set(e.a, e.dp);
  }
  const pcs = new Set(game.users.map((u) => u.character?.id).filter(Boolean));
  const D = CONST.TOKEN_DISPOSITIONS;
  const out = new Map();
  for (const id of ids) {
    if (pcs.has(id)) {
      out.set(id, "pc");
      continue;
    }
    const actor = game.actors.get(id);
    if (actor?.hasPlayerOwner) {
      out.set(id, "playerNpc");
      continue;
    }
    const d = lastDisposition.get(id) ?? actor?.prototypeToken?.disposition;
    out.set(id, d === D.FRIENDLY || d === D.NEUTRAL ? "npc" : "foe");
  }
  return out;
}
