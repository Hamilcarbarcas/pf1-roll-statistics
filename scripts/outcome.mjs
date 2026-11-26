/**
 * Success / fail from recorded inputs, evaluated at report time. §5
 * Returns true (success), false (fail) or null (unknown — never counted as a failure).
 */

const MANEUVERS = new Set(["mcman", "rcman"]);
const DC_CHECKS = new Set(["skill", "ability", "cl", "concentration"]);

/** Defense an attack is measured against, or null when it can't be resolved. §5.2 */
export function attackDefense(event) {
  if (event.tg?.length !== 1) return null;
  const target = event.tg[0];
  const value = MANEUVERS.has(event.it?.at) ? target.cmd : target.ac;
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {object} event
 * @returns {boolean|null}
 */
export function outcome(event) {
  const { c, nat, tot, dc } = event;
  if (c === "attack" || c === "critConfirm") {
    const def = attackDefense(event);
    if (def === null) return null;
    if (nat === 20) return true;
    if (nat === 1) return false;
    return tot >= def;
  }
  if (!Number.isFinite(dc)) return null;
  if (c === "save") {
    if (nat === 20) return true;
    if (nat === 1) return false;
    return tot >= dc;
  }
  if (DC_CHECKS.has(c)) return tot >= dc;
  return null;
}
