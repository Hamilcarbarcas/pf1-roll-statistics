import { ROLL_REQUESTS_ID } from "./constants.mjs";

/**
 * Message → event records. Pure reads, no writes. §2.2, §4.1
 */

const CORE_CATEGORIES = new Set(["init", "bab", "cl", "concentration"]);
const REQUEST_CATEGORIES = { skill: "skill", save: "save", ability: "ability" };

/**
 * Dice, natural d20, total and static flag of one evaluated roll.
 * @param {Roll} roll
 * @returns {{tot:number, nat:number|null, d:number[][], st:boolean}|null}
 */
export function rollFacts(roll) {
  if (!roll?._evaluated) return null;
  const Die = foundry.dice.terms.Die;
  const d = [];
  let nat = null;
  for (const term of roll.dice) {
    if (!(term instanceof Die)) continue;
    const manual = term.method === "manual" ? 1 : 0;
    for (const r of term.results) d.push([term.faces, r.result, r.active === false ? 0 : 1, manual]);
    // First d20 term is the check die; its total is the kept face for kh/kl.
    if (nat === null && term.faces === 20) nat = term.total;
  }
  return { tot: roll.total, nat, d, st: Number.isFinite(roll.options?.staticRoll) };
}

function toRoll(data) {
  if (!data) return null;
  if (data instanceof foundry.dice.Roll) return data;
  try {
    return foundry.dice.Roll.fromData(data);
  } catch (err) {
    console.error("pf1-roll-statistics | unreadable roll data", err, data);
    return null;
  }
}

/** Disposition of the rolling token, or of the actor's prototype token when the token is unknown. */
function disposition(sceneId, tokenId, actor) {
  let token = null;
  if (tokenId) {
    token = sceneId
      ? game.scenes.get(sceneId)?.tokens.get(tokenId)
      : game.scenes.find((s) => s.tokens.has(tokenId))?.tokens.get(tokenId);
  }
  const d = token?.disposition ?? actor?.prototypeToken?.disposition;
  return Number.isFinite(d) ? d : null;
}

/** Who and as whom, shared by every event from one source. */
function baseFields(messageId, timestamp, userId, actorId, tokenId, sceneId = null) {
  const user = game.users.get(userId);
  const actor = actorId ? game.actors.get(actorId) : null;
  const base = {
    m: messageId,
    t: timestamp,
    u: userId ?? null,
    gm: user?.isGM ?? false,
    a: actorId ?? null,
    tk: tokenId ?? null,
    pc: actor?.hasPlayerOwner ?? false,
  };
  const dp = disposition(sceneId, tokenId, actor);
  if (dp !== null) base.dp = dp;
  return base;
}

function makeEvent(base, id, c, facts, extra = {}) {
  const e = { id, ...base, c, tot: facts.tot, nat: facts.nat, d: facts.d, ...extra };
  if (facts.st) e.st = true;
  return e;
}

function checkCategory(msg) {
  if (msg.flags?.core?.initiativeRoll) return { c: "init" };
  const s = msg.system?.subject ?? {};
  if (s.skill) return { c: "skill", k: s.skill };
  if (s.save) return { c: "save", k: s.save };
  if (s.ability) return { c: "ability", k: s.ability };
  if (s.core) return CORE_CATEGORIES.has(s.core) ? { c: s.core } : { c: "other", k: s.core };
  return { c: "other" };
}

/** DC on the card, else the save DC of the card that prompted it. §5.1 */
function checkDC(msg) {
  const own = msg.system?.dc;
  if (Number.isFinite(own)) return own;
  const ref = msg.system?.reference;
  if (!ref) return null;
  const dc = fromUuidSync(ref)?.system?.save?.dc;
  return Number.isFinite(dc) ? dc : null;
}

function targetDefenses(uuids) {
  return (uuids ?? []).map((u) => {
    const token = fromUuidSync(u);
    const at = token?.actor?.system?.attributes;
    return {
      u,
      a: token?.actorId ?? null,
      ac: at?.ac?.normal?.total ?? null,
      t: at?.ac?.touch?.total ?? null,
      ff: at?.ac?.flatFooted?.total ?? null,
      cmd: at?.cmd?.total ?? null,
    };
  });
}

function itemInfo(msg) {
  const actor = ChatMessage.implementation.getSpeakerActor(msg.speaker);
  const itemId = msg.system?.item?.id ?? null;
  const item = itemId ? actor?.items.get(itemId) : null;
  const actionId = msg.system?.action?.id ?? null;
  const action = actionId ? item?.actions?.get(actionId) : null;
  return {
    id: itemId,
    n: item?.name ?? msg.system?.item?.name ?? null,
    ac: actionId,
    an: action?.name ?? msg.system?.action?.name ?? null,
    at: action?.actionType ?? null,
  };
}

/** Sum of several damage rolls as one fact set. */
function combinedFacts(rolls) {
  const facts = rolls.map(toRoll).map(rollFacts).filter(Boolean);
  if (!facts.length) return null;
  return {
    tot: facts.reduce((s, f) => s + f.tot, 0),
    nat: null,
    d: facts.flatMap((f) => f.d),
    st: false,
  };
}

function parseActionCard(msg, base) {
  const attacks = msg.system?.rolls?.attacks ?? [];
  if (!attacks.length) return [];
  const it = itemInfo(msg);
  const tg = targetDefenses(msg.system?.targets);
  const healing = it.at === "heal";
  const events = [];

  attacks.forEach((atk, i) => {
    const g = `${msg.id}:a${i}`;
    const atkFacts = rollFacts(toRoll(atk.attack));
    if (atkFacts) events.push(makeEvent(base, `${g}`, "attack", atkFacts, { g, it, tg }));

    const confirm = rollFacts(toRoll(atk.critConfirm));
    if (confirm) events.push(makeEvent(base, `${g}c`, "critConfirm", confirm, { g, it, tg }));

    const dmg = combinedFacts(atk.damage ?? []);
    if (dmg) events.push(makeEvent(base, `${g}d`, healing ? "healing" : "damage", dmg, { g, it }));

    const critDmg = combinedFacts(atk.critDamage ?? []);
    if (critDmg) events.push(makeEvent(base, `${g}cd`, "critDamage", critDmg, { g, it }));
  });
  return events;
}

function parsePlainRolls(msg, base) {
  const events = [];
  const first = msg.type === "check" ? checkCategory(msg) : null;
  const initiative = !!msg.flags?.core?.initiativeRoll;
  msg.rolls.forEach((roll, i) => {
    const facts = rollFacts(roll);
    if (!facts) return;
    let cat = i === 0 && first ? first : { c: initiative ? "init" : "other" };
    // Plain rolls with no dice (e.g. "/r 5") carry no information.
    if (cat.c === "other" && !facts.d.length) return;
    const extra = {};
    if (cat.k) extra.k = cat.k;
    if (i === 0 && msg.type === "check") {
      const dc = checkDC(msg);
      if (dc !== null) extra.dc = dc;
    }
    events.push(makeEvent(base, `${msg.id}:r${i}`, cat.c, facts, extra));
  });
  return events;
}

/**
 * Events for a chat message's own rolls. Roll-request results are separate: see parseRollRequestCard.
 * @param {ChatMessage} msg
 * @returns {object[]}
 */
export function parseMessage(msg) {
  const userId = msg.author?.id;
  if (!userId) return [];
  const base = baseFields(msg.id, msg.timestamp, userId, msg.speaker?.actor, msg.speaker?.token, msg.speaker?.scene);
  if (msg.type === "action") return parseActionCard(msg, base);
  if (msg.rolls?.length) return parsePlainRolls(msg, base);
  return [];
}

/* -------------------------------------------- */
/*  pf1-roll-requests  §2.3                     */
/* -------------------------------------------- */

/** Short stable hash of a string (djb2), for ids built from content. */
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** First non-GM user whose character this is, else a non-GM owner, else a GM. */
function likelyRoller(actorId) {
  const actor = game.actors.get(actorId);
  const players = game.users.filter((u) => !u.isGM);
  const user = players.find((u) => u.character?.id === actorId)
    ?? players.find((u) => actor?.testUserPermission(u, "OWNER"))
    ?? game.users.find((u) => u.isGM);
  return user?.id ?? null;
}

/**
 * Result entries anywhere in a request card's flags, keyed by identity. Walks the whole tree so
 * embedded requests are found without knowing the layout.
 *
 * Stamped entries (`stats`) are keyed by their stamp id. Unstamped ones — rolled before the stamp
 * existed, or by an older pf1-roll-requests — are keyed by their place in the flags (a repick
 * overwrites the same place), with check, DC and roller worked out from the enclosing request.
 * Results pulled in from another card (`applied`) were counted on that card and are skipped. §2.3
 * @param {ChatMessage} msg
 * @returns {Map<string, {entry: object, stats: object}>}
 */
export function rollRequestEntries(msg) {
  const found = new Map();
  const walk = (node, path, scope, aid) => {
    if (!node || typeof node !== "object") return;
    if (node.request && typeof node.request === "object") scope = node;
    if (node.rollData && (node.actorId || node.tokenId)) {
      if (node.stats?.id) found.set(node.stats.id, { entry: node, stats: node.stats });
      else if (!node.applied) found.set(`l-${hash(path)}`, { entry: node, stats: legacyStats(node, scope, aid) });
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, scope, aid || k === "aidResults" || k === "actorAidResults");
  };
  walk(msg.flags?.[ROLL_REQUESTS_ID], "", null, false);
  return found;
}

function legacyStats(entry, scope, aid) {
  const override = scope?.targetedActors?.find?.((t) => t.id === entry.resultKey)?.check;
  const request = override ?? scope?.request ?? {};
  const dc = aid ? 10 : scope?.dc;
  return {
    userId: likelyRoller(entry.actorId),
    time: null,
    type: request.type ?? null,
    key: request.key ?? null,
    dc: Number.isFinite(dc) ? dc : null,
    legacy: true,
  };
}

/** Event id for a roll-request entry. */
export function rollRequestEventId(messageId, stampId) {
  return `${messageId}:rr:${stampId}`;
}

function parseRollRequestEntry(msg, id, entry, s) {
  const facts = rollFacts(toRoll(entry.rollData));
  if (!facts || !s.userId) return null;
  const base = baseFields(msg.id, s.time ?? msg.timestamp, s.userId, entry.actorId, entry.tokenId);
  let cat;
  if (REQUEST_CATEGORIES[s.type]) cat = { c: REQUEST_CATEGORIES[s.type], k: s.key };
  else if (s.type === "spellcasting") cat = { c: s.key === "cl" ? "cl" : "concentration" };
  else cat = { c: "other" };
  const extra = {};
  if (cat.k) extra.k = cat.k;
  if (Number.isFinite(s.dc)) extra.dc = s.dc;
  return makeEvent(base, rollRequestEventId(msg.id, id), cat.c, facts, extra);
}

/**
 * Events for every roll-request result on a card.
 * @param {ChatMessage} msg
 * @returns {object[]}
 */
export function parseRollRequestCard(msg) {
  const events = [];
  for (const [id, { entry, stats }] of rollRequestEntries(msg)) {
    const e = parseRollRequestEntry(msg, id, entry, stats);
    if (e) events.push(e);
  }
  return events;
}
