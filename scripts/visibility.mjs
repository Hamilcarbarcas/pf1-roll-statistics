import { MODULE_ID, SETTINGS } from "./constants.mjs";

/**
 * Who may open a report. §6.4
 * Basic reports: everyone. Others: per-report setting, defaulting to the report's own `visibility`.
 */

export const VISIBILITY = ["gm", "all", "owners"];

export function getVisibility(def) {
  if (def.basic) return "all";
  return game.settings.get(MODULE_ID, SETTINGS.visibility)[def.id] ?? def.visibility;
}

export async function setVisibility(def, value) {
  if (!VISIBILITY.includes(value)) throw new Error(`${MODULE_ID} | bad visibility "${value}"`);
  const map = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.visibility));
  map[def.id] = value;
  await game.settings.set(MODULE_ID, SETTINGS.visibility, map);
}

export function canSee(def, user = game.user) {
  if (def.basic || user.isGM) return true;
  return getVisibility(def) !== "gm";
}

/** Actor filter for actor-scoped reports; "owners" limits players to actors they own. */
export function actorFilter(def, user = game.user) {
  if (user.isGM || getVisibility(def) !== "owners") return undefined;
  return (id) => game.actors.get(id)?.testUserPermission(user, "OWNER") ?? false;
}
