/* What a company operates (v8) - pure helpers, no Firebase / DOM. Unit-tested in tests/services.test.mjs.
   companies/{cid}.serviceTypes: ['schools'|'colleges'|'rail'|'other', ...]   (missing = all four)
   companies/{cid}/routes/{id}.serviceType: one of those, optional (missing = the route's category decides, see routeService) */
export const SERVICE_TYPES = [
  { key: "schools", label: "Schools", icon: "🏫" },
  { key: "colleges", label: "Colleges", icon: "🎓" },
  { key: "rail", label: "Rail", icon: "🚆" },
  { key: "other", label: "Other", icon: "🚌" }
];
export const SERVICE_KEYS = SERVICE_TYPES.map((t) => t.key);
export const serviceLabel = (k) => (SERVICE_TYPES.find((t) => t.key === k) || { label: "" }).label;
export const serviceIcon = (k) => (SERVICE_TYPES.find((t) => t.key === k) || { icon: "" }).icon;

/* known values only, no duplicates, canonical order; nothing valid (or no field at all) = all four */
export function normServiceTypes(v) {
  const arr = Array.isArray(v) ? v : [];
  const out = SERVICE_KEYS.filter((k) => arr.includes(k));
  return out.length ? out : SERVICE_KEYS.slice();
}
export const isAllServices = (v) => normServiceTypes(v).length === SERVICE_KEYS.length;

/* for the register / operator form: picked checkboxes -> value to store, or null if nothing picked */
export function pickedServiceTypes(picked) {
  const out = SERVICE_KEYS.filter((k) => (picked || []).includes(k));
  return out.length ? out : null;
}

/* default type for a new route in the editor: the route's category if the company runs it, else the first enabled type */
export function defaultRouteServiceType(companyTypes, category) {
  const t = normServiceTypes(companyTypes);
  const fromCat = { school: "schools", college: "colleges", other: "other" }[category];
  if (fromCat && t.includes(fromCat)) return fromCat;
  return t[0] || "other";
}

/* "Welcome, Keith": Auth displayName, else the profile name, else the part of the email before @ (capitalised) - first word only */
export function welcomeName(displayName, profileName, email) {
  const first = (s) => String(s || "").trim().split(/\s+/)[0] || "";
  let n = first(displayName) || first(profileName);
  if (!n) {
    const local = String(email || "").split("@")[0];
    n = local.split(/[._\-+0-9]+/).filter(Boolean)[0] || local;
  }
  n = n.slice(0, 40);
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
}

/* ================= v9: today's service + session (two-step welcome) =================
   A route's service = its serviceType, else its category (school -> schools, college -> colleges, anything else -> other).
   A route runs in the morning if it has morning timetable rows or session AM/both; afternoon likewise (same rule
   the driver drawer tabs use). A "both" route is listed under AM and under PM. */
export function routeService(r) {
  if (r && SERVICE_KEYS.includes(r.serviceType)) return r.serviceType;
  return ({ school: "schools", college: "colleges" })[r && r.category] || "other";
}
export function routeSessions(r) {
  const tt = (r && r.timetable) || {}, s = r && r.session;
  return {
    am: !!((tt.morning && tt.morning.length) || s === "AM" || s === "both"),
    pm: !!((tt.afternoon && tt.afternoon.length) || s === "PM" || s === "both")
  };
}
const SESS = ["AM", "PM", "none"];
export function pickLabel(type, sess) {
  if (!type) return "All routes";
  const t = serviceLabel(type);
  return sess === "AM" ? t + " AM" : sess === "PM" ? t + " PM" : sess === "none" ? t + " – no set time" : t;
}
/* filter = null (every route) or { type: key|null, sess: 'AM'|'PM'|'none'|null } */
export function routeMatchesPick(r, f) {
  if (!f) return true;
  if (f.type && routeService(r) !== f.type) return false;
  if (!f.sess) return true;
  const x = routeSessions(r);
  return f.sess === "AM" ? x.am : f.sess === "PM" ? x.pm : !x.am && !x.pm;
}
/* step 1: the company's enabled types, each with how many routes it has */
export function typeOptions(routeList, companyTypes) {
  return normServiceTypes(companyTypes).map((k) => ({ type: k, label: serviceLabel(k), icon: serviceIcon(k),
    count: (routeList || []).filter((r) => routeService(r) === k).length }));
}
/* step 2: the type x session combinations that really exist (type null = every type), canonical order */
export function sessionOptions(routeList, type) {
  const out = [];
  const types = type ? [type] : SERVICE_KEYS;
  types.forEach((t) => SESS.forEach((sess) => {
    const n = (routeList || []).filter((r) => routeMatchesPick(r, { type: t, sess })).length;
    if (n) out.push({ type: t, sess, label: pickLabel(t, sess), icon: serviceIcon(t), count: n });
  }));
  return out;
}
/* remembered pick <-> string ("schools|AM", "all|" = every route); null if unreadable */
export const encodePick = (f) => (f ? (f.type || "all") + "|" + (f.sess || "") : "all|");
export function decodePick(str) {
  if (typeof str !== "string" || !str.includes("|")) return null;
  const [t, s] = str.split("|");
  if (t === "all" && !s) return { all: true };
  if (!SERVICE_KEYS.includes(t) || !SESS.includes(s)) return null;
  return { type: t, sess: s };
}

/* ================= v11: multi-choice welcome =================
   A driver may do Schools AM + Schools PM + Colleges AM + Colleges PM in one day, so today's choice is a SET of
   type x session picks. picks = null (every route) or a non-empty array of { type, sess }.
   A route is shown if it matches ANY picked combination (union). */
export const pickKey = (p) => p.type + "|" + p.sess;
/* every type x session chip worth offering: combos that have >= 1 route, limited to the company's enabled
   types when it has routes of those types (routes of other types stay reachable through "All routes") */
export function comboOptions(routeList, companyTypes) {
  const all = sessionOptions(routeList, null);
  const en = companyTypes ? normServiceTypes(companyTypes) : SERVICE_KEYS;
  const mine = all.filter((o) => en.includes(o.type));
  return mine.length ? mine : all;
}
export function routeMatchesAny(r, picks) {
  if (!picks) return true;
  return picks.some((p) => routeMatchesPick(r, p));
}
export function picksLabel(picks) {
  if (!picks || !picks.length) return "All routes";
  return picks.map((p) => pickLabel(p.type, p.sess)).join(" + ");
}
/* remembered set <-> string: "schools|AM,colleges|PM" ; "all" = every route.
   decodePicks -> array of picks, { all: true }, or null (never chosen / unreadable).
   Older single values ("schools|AM", "all|") are still understood. */
export const encodePicks = (picks) => (picks && picks.length ? picks.map(pickKey).join(",") : "all");
export function decodePicks(str) {
  if (typeof str !== "string" || !str) return null;
  if (str === "all" || str === "all|") return { all: true };
  const seen = new Set(), out = [];
  for (const part of str.split(",")) {
    const p = decodePick(part.trim());
    if (!p || p.all) return null;                     // anything odd -> treat the whole value as unreadable
    if (!seen.has(pickKey(p))) { seen.add(pickKey(p)); out.push(p); }
  }
  return out.length ? out : null;
}

/* ================= v11 (part 2): which schools / colleges today =================
   After the type x session chips the driver ticks the actual destinations they are doing. A route's destination is
   its optional `destination` label if one is ever set, otherwise its NAME with the session marker stripped
   ("Penyrheol (AM)" and "Penyrheol (PM)" are one destination, "Penyrheol"). Destinations are grouped by service
   type (Schools, Colleges, Rail, Other) and keyed "type|lower-case label".
   Today's full selection: sel = null (every route) or { picks: [ {type, sess} ], dests: [keys] | null (= all of them) } */
const SESS_MARK = /\s*[([]?\s*(am|pm|a\.m\.|p\.m\.|morning|afternoon|both|am\s*[/&+]\s*pm)\s*[)\]]?\s*$/i;
export function destLabel(r) {
  const own = r && typeof r.destination === "string" ? r.destination.trim() : "";
  if (own) return own;
  const name = String((r && r.name) || "").trim();
  let s = name, prev;
  do { prev = s; s = s.replace(SESS_MARK, "").replace(/[\s\-–—:,]+$/, ""); } while (s !== prev && s);
  return s || name || "Unnamed route";
}
export const destKey = (r) => routeService(r) + "|" + destLabel(r).toLowerCase();
/* the destinations among the routes of the picked combinations, grouped by type (canonical order, names A-Z) */
export function destOptions(routeList, picks) {
  const map = new Map();
  (routeList || []).filter((r) => routeMatchesAny(r, picks)).forEach((r) => {
    const k = destKey(r);
    if (!map.has(k)) map.set(k, { key: k, type: routeService(r), label: destLabel(r), count: 0, am: false, pm: false });
    const o = map.get(k), x = routeSessions(r);
    o.count++;
    // only the sessions that were picked for this type count here
    (picks || [{ type: o.type, sess: "AM" }, { type: o.type, sess: "PM" }]).forEach((p) => {
      if (p.type !== o.type) return;
      if (p.sess === "AM" && x.am) o.am = true;
      if (p.sess === "PM" && x.pm) o.pm = true;
    });
  });
  const list = [...map.values()].map((o) => ({ ...o, sessions: [o.am && "AM", o.pm && "PM"].filter(Boolean).join(" + ") }));
  list.sort((a, b) => SERVICE_KEYS.indexOf(a.type) - SERVICE_KEYS.indexOf(b.type) || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  return list;
}
export function selMatches(r, sel) {
  if (!sel || sel.all) return true;
  // v12: kind + slots (each slot = type|sess -> chosen dest keys; empty = not doing that session)
  if (sel.slots) {
    const entries = Object.entries(sel.slots).filter(([, keys]) => keys && keys.length);
    if (!entries.length) return true; // nothing chosen yet treated as open (welcome won't continue)
    return entries.some(([slot, keys]) => {
      const [type, sess] = slot.split("|");
      return routeMatchesPick(r, { type, sess }) && keys.includes(destKey(r));
    });
  }
  // v11: picks + optional dests
  return routeMatchesAny(r, sel.picks) && (!sel.dests || sel.dests.includes(destKey(r)));
}
/* label for the drawer "Today:" chip */
export function selLabel(sel, routeList) {
  if (!sel || sel.all) return "All routes";
  if (sel.slots) {
    const bits = [];
    for (const slot of SLOT_ORDER) {
      const keys = sel.slots[slot];
      if (!keys || !keys.length) continue;
      const [type, sess] = slot.split("|");
      const names = keys.map((k) => {
        const r = (routeList || []).find((x) => destKey(x) === k);
        return r ? destLabel(r) : k.slice(k.indexOf("|") + 1);
      });
      const who = names.length <= 2 ? names.join(", ") : names.length + " places";
      bits.push(pickLabel(type, sess) + " · " + who);
    }
    return bits.length ? bits.join(" + ") : (KIND_LABEL[sel.kind] || "Today");
  }
  const base = picksLabel(sel.picks);
  if (!sel.dests) return base;
  const names = sel.dests.map((k) => {
    const r = (routeList || []).find((x) => destKey(x) === k);
    return r ? destLabel(r) : k.slice(k.indexOf("|") + 1);
  });
  return base + " · " + (names.length <= 3 ? names.join(", ") : names.length + " schools/colleges");
}

/* ================= v12: kind → session dropdowns =================
   Step A: Schools and Colleges | Rail | All
   Step B: one multi-select control per slot (School AM, College AM, School PM, College PM, and/or Rail).
   Stored as JSON { kind, slots: { "schools|AM": ["schools|penyrheol"], ... } }. Older v9/v11 values still read. */
export const KIND_KEYS = ["schools_colleges", "rail", "all"];
export const KIND_LABEL = { schools_colleges: "Schools and Colleges", rail: "Rail", all: "All" };
export const SLOT_ORDER = ["schools|AM", "colleges|AM", "schools|PM", "colleges|PM", "rail|AM", "rail|PM", "rail|none"];
export const SLOT_LABEL = {
  "schools|AM": "School AM", "colleges|AM": "College AM", "schools|PM": "School PM", "colleges|PM": "College PM",
  "rail|AM": "Rail AM", "rail|PM": "Rail PM", "rail|none": "Rail"
};
export function slotsForKind(kind) {
  if (kind === "rail") return SLOT_ORDER.filter((s) => s.startsWith("rail|"));
  if (kind === "schools_colleges") return ["schools|AM", "colleges|AM", "schools|PM", "colleges|PM"];
  return SLOT_ORDER.slice(); // all
}
/* destinations available for one type×session slot (only those with ≥1 matching route) */
export function slotDestOptions(routeList, slot) {
  const [type, sess] = slot.split("|");
  const pick = { type, sess };
  return destOptions(routeList, [pick]).filter((o) => o.type === type);
}
/* which slots actually have destinations among the company's routes (skip empty dropdowns? keep them with None) */
export function availableSlots(routeList, kind) {
  return slotsForKind(kind).filter((slot) => slotDestOptions(routeList, slot).length > 0);
}
export function selFromSlots(kind, slots) {
  const clean = {};
  Object.keys(slots || {}).forEach((k) => {
    const arr = (slots[k] || []).filter(Boolean);
    if (arr.length) clean[k] = [...new Set(arr)];
  });
  if (!Object.keys(clean).length) return null;
  return { kind: kind || "all", slots: clean };
}
export function picksFromSel(sel) {
  if (!sel || sel.all) return null;
  if (sel.slots) {
    return Object.keys(sel.slots).filter((k) => sel.slots[k] && sel.slots[k].length)
      .map((k) => { const [type, sess] = k.split("|"); return { type, sess }; });
  }
  return sel.picks || null;
}
export function encodeSel(sel) {
  if (!sel || sel.all) return "all";
  if (sel.slots) return JSON.stringify({ kind: sel.kind || "all", slots: sel.slots });
  // v11 write path (still used by older tests / migration)
  if (!sel.dests) return encodePicks(sel.picks);
  return JSON.stringify({ picks: encodePicks(sel.picks), dests: sel.dests });
}
/* -> null (never chosen / unreadable), { all: true }, or { kind, slots } (v12) / { picks, dests } (v11, normalised to slots when practical) */
export function decodeSel(str) {
  if (typeof str !== "string" || !str) return null;
  if (str === "all" || str === "all|") return { all: true };
  if (str.charAt(0) === "{") {
    let o; try { o = JSON.parse(str); } catch (e) { return null; }
    if (o && o.slots && typeof o.slots === "object") {
      const slots = {};
      Object.keys(o.slots).forEach((k) => {
        if (!SLOT_ORDER.includes(k) && !/^(schools|colleges|rail|other)\|(AM|PM|none)$/.test(k)) return;
        const arr = Array.isArray(o.slots[k]) ? o.slots[k].filter((x) => typeof x === "string" && x.includes("|")) : [];
        if (arr.length) slots[k] = [...new Set(arr)];
      });
      if (!Object.keys(slots).length) return null;
      const kind = KIND_KEYS.includes(o.kind) ? o.kind : "all";
      return { kind, slots };
    }
    // v11 JSON
    const p = decodePicks(o && o.picks);
    if (!p || p.all) return null;
    const d = Array.isArray(o.dests) ? [...new Set(o.dests.filter((k) => typeof k === "string" && k.includes("|")))] : null;
    return migrateV11ToSlots({ picks: p, dests: d && d.length ? d : null });
  }
  const p = decodePicks(str);
  if (!p) return null;
  return p.all ? { all: true } : migrateV11ToSlots({ picks: p, dests: null });
}
function migrateV11ToSlots(sel) {
  const slots = {};
  (sel.picks || []).forEach((p) => {
    const k = p.type + "|" + p.sess;
    // dests null = every destination for that pick — leave a sentinel '*' expanded by welcome when routes load
    slots[k] = sel.dests ? sel.dests.filter((d) => d.startsWith(p.type + "|")) : ["*"];
  });
  const kinds = new Set((sel.picks || []).map((p) => p.type === "rail" ? "rail" : (p.type === "schools" || p.type === "colleges" ? "schools_colleges" : "other")));
  let kind = "all";
  if (kinds.size === 1 && kinds.has("rail")) kind = "rail";
  else if (kinds.size === 1 && kinds.has("schools_colleges")) kind = "schools_colleges";
  return { kind, slots, _legacyAllDests: !sel.dests };
}

/* ================= v13: the day's running order =================
   School AM → College AM → School PM → College PM → Rail AM → Rail PM → Rail (no set time) → anything else.
   routeRank(r, sel) = a sortable number for a route that is part of today's selection (null otherwise):
   slot position * 1000 + position of its destination in that slot's picked order (ties: route name, done by caller).
   A route that fits several picked slots (e.g. a "both" route) ranks by its earliest one. */
export const DAY_ORDER = ["schools|AM", "colleges|AM", "schools|PM", "colleges|PM", "rail|AM", "rail|PM", "rail|none",
  "schools|none", "colleges|none", "other|AM", "other|PM", "other|none"];
export function routeRank(r, sel) {
  for (let i = 0; i < DAY_ORDER.length; i++) {
    const slot = DAY_ORDER[i];
    const [type, sess] = slot.split("|");
    if (!routeMatchesPick(r, { type, sess })) continue;
    if (!sel || sel.all) return i * 1000;
    if (sel.slots) {
      const keys = sel.slots[slot];
      if (!keys || !keys.length) continue;
      let at = keys.indexOf(destKey(r));
      if (at < 0 && keys.includes("*")) at = 0;   // legacy pick = every destination in the slot
      if (at < 0) continue;
      return i * 1000 + at;
    }
    // v11 picks + dests
    if (!(sel.picks || []).some((p) => p.type === type && p.sess === sess)) continue;
    if (sel.dests && !sel.dests.includes(destKey(r))) continue;
    return i * 1000 + (sel.dests ? sel.dests.indexOf(destKey(r)) : 0);
  }
  return null;
}

/* v14: the session label of a route's place in today's order, e.g. "College AM" (used in "Next: College AM – …") */
const DAY_LABEL = { "schools|AM": "School AM", "colleges|AM": "College AM", "schools|PM": "School PM", "colleges|PM": "College PM",
  "rail|AM": "Rail AM", "rail|PM": "Rail PM", "rail|none": "Rail", "schools|none": "School", "colleges|none": "College",
  "other|AM": "AM", "other|PM": "PM", "other|none": "" };
export function routeSlotLabel(r, sel) {
  const k = routeRank(r, sel);
  if (k == null) return "";
  return DAY_LABEL[DAY_ORDER[Math.floor(k / 1000)]] || "";
}

/* ================= v15: the driver's working ("duty") day =================
   A duty day runs 05:00 → 05:00 Europe/London (BST or GMT), not midnight: at 04:59 it is still the previous
   day, at 05:00 the new one starts. dutyDay() is THE one helper every day-keyed thing uses (today's plan,
   submitted runs, the in-progress-run check). Returned as "YYYY-MM-DD" (the calendar date the shift started on).
   nowMs(): Date.now(), plus a test-only offset (globalThis.__rtNowOffset, never set by the app itself). */
export const DUTY_DAY_START_HOUR = 5;
export function nowMs() { return Date.now() + (Number(globalThis.__rtNowOffset) || 0); }
let _ldnFmt = null;
function londonParts(ms) {
  if (!_ldnFmt) {
    _ldnFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  }
  const o = {};
  _ldnFmt.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24 };
}
const isoDay = (utcMs) => new Date(utcMs).toISOString().slice(0, 10);
export function dutyDay(at) {
  const ms = at == null ? nowMs() : (at instanceof Date ? at.getTime() : Number(at));
  const p = londonParts(ms);
  let day = Date.UTC(p.y, p.m - 1, p.d);
  if (p.h < DUTY_DAY_START_HOUR) day -= 86400000;      // before 05:00 London = still yesterday's shift
  return isoDay(day);
}
export function prevDutyDay(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return isoDay(Date.UTC(y, m - 1, d) - 86400000);
}
