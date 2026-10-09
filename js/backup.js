/* Route backup / restore - pure helpers (no Firebase, no DOM), unit-tested in tests/backup.test.mjs.

   File format (JSON, one file):
   { format: "round-tracker-routes-backup", version: 1, exportedAt: ISO string, company: { name },
     routes: [ { id, name, category, session, serviceType?, note, capacity, specifiedRoute, addedAt,
                 operator{name,address,tel,email}, operatorCustom, contacts[{label,tel}],
                 timetable{morning[{stop,time}], afternoon[], morningNote, afternoonNote},
                 stops[{lat,lng,name}], track[[lat,lng],...]   <- the DECODED track
                 trackOriginalPoints?, trackSimplifiedToleranceM? } ] }
   Only the company's own route data goes in: no user ids, no company id, no run data. */
import { decodePolyline } from "./geo.js?v=16";
import { normOp, OP_LIMITS } from "./operator.js?v=16";
import { SERVICE_KEYS } from "./services.js?v=16";

export const BACKUP_FORMAT = "round-tracker-routes-backup";
export const BACKUP_VERSION = 1;
export const MAX_RESTORE_ROUTES = 500;
export const MAX_RESTORE_BYTES = 60 * 1024 * 1024;
const MAX_STOPS = 500, MAX_TRACK_POINTS = 400000, MAX_TT_ROWS = 500, MAX_CONTACTS = 50;
const CATEGORIES = ["school", "college", "other"], SESSIONS = ["", "AM", "PM", "both"];

const round5 = (n) => Math.round(n * 1e5) / 1e5;

/* ---------- export ---------- */
export function routeToBackup(id, d) {
  const r = { id, name: d.name || "" };
  ["category", "session", "serviceType", "note", "capacity", "specifiedRoute", "addedAt"].forEach((k) => { if (d[k] !== undefined && d[k] !== "") r[k] = d[k]; });
  const op = normOp(d.operator);
  if (Object.keys(op).length) r.operator = op;
  if (typeof d.operatorCustom === "boolean") r.operatorCustom = d.operatorCustom;
  if (Array.isArray(d.contacts) && d.contacts.length) r.contacts = d.contacts.map((c) => ({ label: c.label || "", tel: c.tel || "" }));
  if (d.timetable && typeof d.timetable === "object") r.timetable = JSON.parse(JSON.stringify(d.timetable));
  r.stops = (d.stops || []).map((s) => ({ lat: s.lat, lng: s.lng, name: s.name || "" }));
  r.track = d.trackEnc ? decodePolyline(d.trackEnc) : [];
  if (d.trackOriginalPoints) r.trackOriginalPoints = d.trackOriginalPoints;
  if (d.trackSimplifiedToleranceM) r.trackSimplifiedToleranceM = d.trackSimplifiedToleranceM;
  return r;
}

/* rawRoutes: { id: firestoreData } -> backup object (sorted by name) */
export function buildBackup(rawRoutes, companyName, now) {
  const ids = Object.keys(rawRoutes || {}).sort((a, b) =>
    String(rawRoutes[a].name || "").localeCompare(String(rawRoutes[b].name || ""), undefined, { numeric: true }));
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: (now || new Date()).toISOString(),
    company: { name: String(companyName || "") },
    routes: ids.map((id) => routeToBackup(id, rawRoutes[id]))
  };
}

const slug = (s, max) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
export function dateStamp(d) {
  const x = d || new Date(), p = (n) => String(n).padStart(2, "0");
  return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate());
}
export const backupFileName = (companyName, d) => "routes-backup-" + (slug(companyName, 40) || "company") + "-" + dateStamp(d) + ".json";
export const routeFileName = (routeName, d) => "route-" + (slug(routeName, 40) || "route") + "-" + dateStamp(d) + ".json";

/* ---------- import: validation ---------- */
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const cap = (v, n) => (isStr(v) ? v.trim().slice(0, n) : "");

function cleanPoint(p, where) {
  if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180)
    throw new Error(where + " has an invalid coordinate.");
  return [round5(p[0]), round5(p[1])];
}

/* validate + normalise ONE route; throws Error("...") with a readable message */
export function cleanRoute(r, n) {
  const label = "Route " + (n + 1);
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(label + " is not an object.");
  if (!isStr(r.name) || !r.name.trim()) throw new Error(label + " has no name.");
  if (r.name.length > 120) throw new Error(label + " (“" + r.name.slice(0, 30) + "…”) has a name longer than 120 characters.");
  const L = label + " (“" + r.name.trim() + "”)";
  const out = { name: r.name.trim() };
  out.category = CATEGORIES.includes(r.category) ? r.category : "other";
  if (r.session !== undefined && !SESSIONS.includes(r.session)) throw new Error(L + " has an unknown session (expected AM, PM or both).");
  out.session = r.session || "";
  out.serviceType = SERVICE_KEYS.includes(r.serviceType) ? r.serviceType : "";   // optional (v8); unknown values dropped
  out.note = cap(r.note, 1000); out.capacity = cap(r.capacity, 60); out.specifiedRoute = cap(r.specifiedRoute, 3000);
  out.addedAt = isStr(r.addedAt) && r.addedAt.length <= 40 ? r.addedAt : null;
  // operator
  if (r.operator !== undefined && (typeof r.operator !== "object" || r.operator === null || Array.isArray(r.operator))) throw new Error(L + " has an invalid operator.");
  const op = normOp(r.operator);
  Object.keys(OP_LIMITS).forEach((k) => { if (op[k] && op[k].length > OP_LIMITS[k]) throw new Error(L + ": operator " + k + " is longer than " + OP_LIMITS[k] + " characters."); });
  out.operator = op;
  out.operatorCustom = r.operatorCustom === true ? true : r.operatorCustom === false ? false : null;   // null = unknown (decide on restore)
  // contacts
  if (r.contacts !== undefined && !Array.isArray(r.contacts)) throw new Error(L + " has invalid contacts.");
  if ((r.contacts || []).length > MAX_CONTACTS) throw new Error(L + " has too many contacts.");
  out.contacts = (r.contacts || []).map((c) => {
    if (!c || typeof c !== "object") throw new Error(L + " has an invalid contact.");
    return { label: cap(c.label, 80), tel: cap(c.tel, 40) };
  }).filter((c) => c.label || c.tel);
  // timetable
  const tt = r.timetable === undefined ? {} : r.timetable;
  if (!tt || typeof tt !== "object" || Array.isArray(tt)) throw new Error(L + " has an invalid timetable.");
  out.timetable = { morning: [], afternoon: [], morningNote: cap(tt.morningNote, 300), afternoonNote: cap(tt.afternoonNote, 300) };
  ["morning", "afternoon"].forEach((k) => {
    const rows = tt[k] === undefined ? [] : tt[k];
    if (!Array.isArray(rows) || rows.length > MAX_TT_ROWS) throw new Error(L + " has an invalid " + k + " timetable.");
    out.timetable[k] = rows.map((row) => {
      if (!row || !isStr(row.stop) || !isStr(row.time) || !/^\d{2}:\d{2}$/.test(row.time.trim()))
        throw new Error(L + " has a " + k + " timetable row without a stop name or a valid HH:MM time.");
      return { stop: row.stop.trim().slice(0, 120), time: row.time.trim() };
    });
  });
  // stops + track
  if (!Array.isArray(r.stops)) throw new Error(L + " has no stops list.");
  if (r.stops.length > MAX_STOPS) throw new Error(L + " has more than " + MAX_STOPS + " stops.");
  out.stops = r.stops.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(L + " stop " + (i + 1) + " is invalid.");
    const [lat, lng] = cleanPoint([s.lat, s.lng], L + " stop " + (i + 1));
    return { lat, lng, name: cap(s.name, 120) };
  });
  if (r.track !== undefined && !Array.isArray(r.track)) throw new Error(L + " has an invalid track.");
  if ((r.track || []).length > MAX_TRACK_POINTS) throw new Error(L + " has more than " + MAX_TRACK_POINTS.toLocaleString("en-GB") + " track points.");
  out.track = (r.track || []).map((p) => cleanPoint(p, L + " track"));
  if (!out.track.length && !out.stops.length) throw new Error(L + " has neither a track nor stops.");
  out.trackMeta = isNum(r.trackOriginalPoints) && isNum(r.trackSimplifiedToleranceM)
    ? { original: Math.round(r.trackOriginalPoints), tol: r.trackSimplifiedToleranceM } : null;
  return out;
}

/* text -> { ok:true, routes:[clean...], companyName, exportedAt } or { ok:false, error } */
export function parseBackup(text) {
  try {
    if (!isStr(text) || !text.trim()) return { ok: false, error: "The file is empty." };
    if (text.length > MAX_RESTORE_BYTES) return { ok: false, error: "The file is too large to restore." };
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: "That file is not valid JSON, so it can't be a routes backup." }; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "That file doesn't look like a routes backup (expected a JSON object)." };
    if (data.format !== BACKUP_FORMAT) return { ok: false, error: "That file isn't a Round Tracker routes backup (wrong or missing “format”)." };
    if (data.version !== BACKUP_VERSION) return { ok: false, error: "This backup has an unsupported version (" + String(data.version) + ")." };
    if (!Array.isArray(data.routes)) return { ok: false, error: "The backup has no “routes” list." };
    if (!data.routes.length) return { ok: false, error: "The backup contains no routes." };
    if (data.routes.length > MAX_RESTORE_ROUTES) return { ok: false, error: "The backup has " + data.routes.length + " routes; the limit is " + MAX_RESTORE_ROUTES + " per restore." };
    const routes = data.routes.map((r, i) => cleanRoute(r, i));
    return {
      ok: true, routes,
      companyName: data.company && isStr(data.company.name) ? data.company.name.slice(0, 120) : "",
      exportedAt: isStr(data.exportedAt) ? data.exportedAt : ""
    };
  } catch (e) {
    return { ok: false, error: e.message || "The backup file is not valid." };
  }
}

/* Which backup routes would replace which existing routes in "replace" mode (match by name, case-insensitive).
   Returns [{ index, targetId|null }] - each existing route is used at most once; extra duplicates are added as new. */
export function planRestore(routes, existing, mode) {
  const key = (s) => String(s || "").trim().toLowerCase();
  const byName = {};
  Object.keys(existing || {}).sort().forEach((id) => { const k = key(existing[id].name); (byName[k] = byName[k] || []).push(id); });
  return routes.map((r, index) => {
    let targetId = null;
    if (mode === "replace") { const list = byName[key(r.name)]; if (list && list.length) targetId = list.shift(); }
    return { index, targetId };
  });
}
