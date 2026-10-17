/* v21: duty calendar - pure logic (no Firebase / DOM; unit-tested in tests/dutycore.test.mjs).
   A duty = Keith's paper "Driver Daily Worksheet": one per driver per day,
     companies/{cid}/duties/{driverUid}_{YYYY-MM-DD}
     { date, driverUid, driverName, dutyNo, vehicleId?, vehicleReg?, note?, rows: [{ time: 'HHMM'|'' , text, routeId?, session?: 'AM'|'PM' }], templateId?, edited?, updatedAt, updatedBy }
   v22: duty templates ("Duty list") companies/{cid}/dutyTemplates/{id} { dutyNo, vehicleId?, vehicleReg?, note?, rows, updatedAt, updatedBy };
   a day's duty made from one is a COPY carrying templateId (+ edited: true once changed for that day). */
import { routeSessions, destLabel, routeService, destKey, routeMatchesPick } from "./services.js?v=16";
export const DUTY_ROWS_MAX = 40, ROW_TEXT_MAX = 200, DUTY_NO_MAX = 20, NOTE_MAX = 500;
export const dutyId = (uid, date) => uid + "_" + date;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isIsoDate = (s) => { const m = ISO.exec(String(s || "")); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCDate() === +m[3] && d.getUTCMonth() === +m[2] - 1; };
const toUTC = (s) => { const m = ISO.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => fromUTC(toUTC(s) + n * 86400000);
export const weekday = (s) => (new Date(toUTC(s)).getUTCDay() + 6) % 7;          // 0 = Monday
export const weekStart = (s) => addDays(s, -weekday(s));
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const dayName = (s) => DAYS[weekday(s)];
export const ukDate = (s) => { const m = ISO.exec(String(s || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; };
export const monthTitle = (y, m) => MONTHS[m - 1] + " " + y;
/* Monday-first month grid: weeks x 7 of { date, inMonth } */
export function monthGrid(y, m) {
  const first = `${y}-${String(m).padStart(2, "0")}-01`, start = weekStart(first), weeks = [];
  let d = start;
  do {
    const w = [];
    for (let i = 0; i < 7; i++) { w.push({ date: d, inMonth: +d.slice(5, 7) === m }); d = addDays(d, 1); }
    weeks.push(w);
  } while (+d.slice(5, 7) === m);
  return weeks;
}
export const shiftMonth = (y, m, n) => { const t = y * 12 + (m - 1) + n; return [Math.floor(t / 12), (t % 12) + 1]; };

/* "705" / "07:05" / "7.05" -> "0705"; "" stays ""; anything else -> null */
export function normTime(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s) return "";
  const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(s);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? String(h).padStart(2, "0") + String(mi).padStart(2, "0") : null;
}
export function cleanRows(rows) {
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (!r) return;
    const time = normTime(r.time), text = String(r.text || "").trim().slice(0, ROW_TEXT_MAX), routeId = String(r.routeId || "").slice(0, 128);
    if (!text && !routeId && !time) return;
    const row = { time: time === null ? "" : time, text };
    if (routeId) { row.routeId = routeId; if (r.session === "AM" || r.session === "PM") row.session = r.session; }
    out.push(row);
  });
  return out.slice(0, DUTY_ROWS_MAX);
}
export function checkDuty(f) {
  const errors = [];
  if (!isIsoDate(f.date)) errors.push("Pick a date.");
  if (!f.driverUid) errors.push("Pick a driver.");
  if (!String(f.dutyNo || "").trim()) errors.push("Enter the duty number.");
  if (String(f.dutyNo || "").trim().length > DUTY_NO_MAX) errors.push("The duty number is too long.");
  const raw = Array.isArray(f.rows) ? f.rows : [];
  const badTime = raw.filter((r) => r && normTime(r.time) === null).length;
  if (badTime) errors.push("Times are 4 figures, e.g. 0705.");
  const rows = cleanRows(raw);
  if (!rows.length) errors.push("Add at least one row.");
  if (raw.filter((r) => r && (String(r.text || "").trim() || r.routeId || String(r.time || "").trim())).length > DUTY_ROWS_MAX) errors.push("At most " + DUTY_ROWS_MAX + " rows.");
  return { ok: !errors.length, errors, rows };
}
/* what is written (updatedAt / updatedBy are added by the caller) */
export function buildDuty(f) {
  const d = { date: f.date, driverUid: f.driverUid, driverName: String(f.driverName || "Driver").slice(0, 120),
    dutyNo: String(f.dutyNo || "").trim().slice(0, DUTY_NO_MAX), rows: cleanRows(f.rows) };
  if (f.vehicleId) { d.vehicleId = String(f.vehicleId).slice(0, 128); d.vehicleReg = String(f.vehicleReg || "").slice(0, 20); }
  const note = String(f.note || "").trim().slice(0, NOTE_MAX);
  if (note) d.note = note;
  if (f.templateId) { d.templateId = String(f.templateId).slice(0, 128); if (f.edited) d.edited = true; }
  return d;
}
/* the same duty for another driver / date */
export function copyDuty(src, to) {
  return buildDuty({ ...src, edited: src.edited, date: to.date || src.date, driverUid: to.driverUid || src.driverUid, driverName: to.driverName || src.driverName });
}
/* "copy last week": every duty of the week before weekStart(date) -> same weekday this week; existing targets are skipped */
export function lastWeekCopies(duties, anyDateThisWeek) {
  const ws = weekStart(anyDateThisWeek), prevStart = addDays(ws, -7), have = new Set(duties.map((d) => dutyId(d.driverUid, d.date)));
  return duties.filter((d) => d.date >= prevStart && d.date < ws).map((d) => ({ src: d, date: addDays(d.date, 7) }))
    .filter((c) => !have.has(dutyId(c.src.driverUid, c.date)))
    .sort((a, b) => (a.date + a.src.driverName).localeCompare(b.date + b.src.driverName));
}
export const timeLabel = (t) => (t && /^\d{4}$/.test(t) ? t : "");
const toMs = (t) => (!t ? 0 : typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : typeof t.seconds === "number" ? t.seconds * 1000 : 0);
export const dutyStamp = (d) => toMs(d && d.updatedAt);
/* new / changed since the driver last looked at it (seen: { dutyId: updatedAt ms }), today onwards only */
export function changedDuties(duties, seen, today) {
  return duties.filter((d) => d.date >= today && dutyStamp(d) > ((seen || {})[dutyId(d.driverUid, d.date)] || 0));
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* the worksheet, laid out like the paper form (admin print view + the driver's day view) */
export function worksheetHtml(d, o) {
  o = o || {};
  const routeName = (id) => (o.routes && o.routes[id] && o.routes[id].name) || "";
  const rows = (d.rows || []).map((r, i) => {
    const rn = r.routeId ? routeLabel(o.routes, r.routeId, r.session) : "";
    return '<tr class="ws-row' + (r.routeId ? " linked" : "") + '"><td class="ws-time">' + esc(timeLabel(r.time)) + '</td><td class="ws-desc">' + esc(r.text || rn) +
      (r.routeId ? '<div class="ws-route">🚌 ' + esc(rn || "Route") + (o.startButtons && rn ? ' <button type="button" class="btn small primary ws-start" data-route="' + esc(r.routeId) + '" data-session="' + esc(r.session || "") + '">▶ Start this run</button>' : "") + "</div>" : "") +
      "</td></tr>";
  }).join("");
  const pad = Math.max(0, (o.minRows || 0) - (d.rows || []).length);
  return '<div class="ws-paper" data-duty="' + esc(dutyId(d.driverUid, d.date)) + '">' +
    '<div class="ws-title"><span>DRIVER DAILY WORKSHEET</span>' + (o.company ? '<span class="ws-co">' + esc(o.company) + "</span>" : "") + "</div>" +
    '<table class="ws-head"><tr><th class="ws-dno">DUTY</th><th>DRIVER NAME</th><th>DAY &amp; DATE</th>' + (d.vehicleReg ? "<th>VEHICLE</th>" : "") + "</tr>" +
    '<tr><td class="ws-dno ws-big" id="wsDutyNo">' + esc(d.dutyNo) + '</td><td class="ws-big" id="wsDriver">' + esc(String(d.driverName || "").toUpperCase()) +
    '</td><td class="ws-big" id="wsDate">' + esc(dayName(d.date) + " " + ukDate(d.date)) + "</td>" + (d.vehicleReg ? '<td class="ws-big" id="wsVeh">' + esc(d.vehicleReg) + "</td>" : "") + "</tr></table>" +
    '<table class="ws-rows"><thead><tr><th class="ws-time">TIME</th><th>DESCRIPTION</th></tr></thead><tbody>' + rows +
    '<tr class="ws-pad"><td></td><td></td></tr>'.repeat(pad) + "</tbody></table>" +
    (d.note ? '<div class="ws-note">' + esc(d.note) + "</div>" : "") + "</div>";
}

/* ================= v22: routes once each + AM/PM =================
   Why the picker showed every route twice: each session of a route is its own route document ("741 & 742 (AM)" and
   "741 & 742 (PM)"), and the v21 picker listed every document. Group them the way the welcome picks already do
   (service + name without the session marker): one entry per route, with the sessions that exist -> the document to open. */
export function routeGroups(routes) {
  const g = new Map();
  Object.entries(routes || {}).forEach(([id, r]) => {
    if (!r) return;
    const x = routeSessions(r), sess = [x.am && "AM", x.pm && "PM"].filter(Boolean);
    let key = routeService(r) + "|" + destLabel(r).toLowerCase(), o = g.get(key);
    const want = sess.length ? sess : [""];
    if (o && want.some((s) => o.sessions[s])) { key += "#" + id; o = null; }       // a clash: keep both, never lose one
    if (!o) { o = { key, label: destLabel(r), sessions: {} }; g.set(key, o); }
    want.forEach((s) => { o.sessions[s] = id; });
  });
  return [...g.values()].map((o) => ({ ...o, list: ["AM", "PM", ""].filter((s) => o.sessions[s]) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-GB", { numeric: true }) || a.key.localeCompare(b.key));
}
/* which group / session a stored row points at (older rows: no session -> the session of that document, AM first) */
export function findGroup(groups, routeId, session) {
  const g = (groups || []).find((x) => Object.values(x.sessions).includes(routeId));
  if (!g) return null;
  const s = session && g.sessions[session] === routeId ? session : g.list.find((k) => g.sessions[k] === routeId);
  return { group: g, session: s || "" };
}
export function routeLabel(routes, id, session) {
  const r = routes && routes[id];
  if (!r) return "";
  return session ? destLabel(r) + " " + session : (r.name || "");
}
/* ================= v22: duty templates ================= */
export function checkTemplate(f) {
  const c = checkDuty({ ...f, date: "2000-01-01", driverUid: "x" });
  return { ok: c.ok, errors: c.errors.map((e) => (e === "Enter the duty number." ? "Enter the duty number / name." : e)), rows: c.rows };
}
export function buildTemplate(f) {
  const d = buildDuty({ ...f, date: "", driverUid: "", templateId: "" });
  delete d.date; delete d.driverUid; delete d.driverName;
  return d;
}
/* the day's copy of a template for a driver */
export function dutyFromTemplate(t, to) {
  return buildDuty({ ...t, date: to.date, driverUid: to.driverUid, driverName: to.driverName, templateId: t.id, edited: false });
}
const sig = (d) => JSON.stringify([String(d.dutyNo || ""), d.vehicleId || "", d.note || "", cleanRows(d.rows)]);
/* does this form differ from its template? (sets the 'edited for this day' marker) */
export const differsFromTemplate = (d, t) => !!t && sig(d) !== sig(t);
/* dates from..to (inclusive) on the chosen weekdays (0 = Monday; empty = every day); at most 92 */
export function assignDates(from, to, weekdays) {
  if (!isIsoDate(from)) return [];
  if (!isIsoDate(to) || to < from) to = from;
  const w = new Set(weekdays || []), out = [];
  for (let d = from; d <= to && out.length < 92; d = addDays(d, 1)) if (!w.size || w.has(weekday(d))) out.push(d);
  return out;
}
/* day board: one row per template, with the duty made from it on that date (if any) */
export function dayBoard(templates, duties, date) {
  const onDay = (duties || []).filter((d) => d.date === date && d.templateId);
  return (templates || []).slice().sort((a, b) => String(a.dutyNo).localeCompare(String(b.dutyNo), "en-GB", { numeric: true }))
    .map((t) => ({ t, duties: onDay.filter((d) => d.templateId === t.id) }));
}

/* ================= v24: duty change alerts (in the app, free: no push / Cloud Functions) =================
   "known" = what this phone last showed the driver for each upcoming duty: { id: { stamp, date, dutyNo, vehicleReg, rows } }
   (localStorage per company + driver). Comparing it with the live list finds new / changed / removed duties - also the
   ones changed while the app was closed. */
export const ALERT_DAYS = 14;
export const knownOf = (d) => ({ stamp: dutyStamp(d), date: d.date, dutyNo: String(d.dutyNo || ""), vehicleReg: String(d.vehicleReg || ""),
  rows: (d.rows || []).map((r) => ({ time: r.time || "", text: r.text || "", routeId: r.routeId || "", session: r.session || "" })) });
export function knownMap(duties, today, days) {
  const end = addDays(today, (days || ALERT_DAYS) - 1), out = {};
  (duties || []).forEach((d) => { if (d.date >= today && d.date <= end) out[d.id] = knownOf(d); });
  return out;
}
const rowLine = (r) => ((r.time ? r.time + " " : "") + (r.text || (r.routeId ? "route" : ""))).trim();
/* what changed between two versions, as short lines for the alert ("Duty no. 8 → 9", "0705 → 0710 Report for duty") */
export function dutyDiff(a, b) {
  const out = [];
  if (a.dutyNo !== b.dutyNo) out.push("Duty no. " + (a.dutyNo || "–") + " → " + (b.dutyNo || "–"));
  if (a.vehicleReg !== b.vehicleReg) out.push("Vehicle " + (a.vehicleReg || "none") + " → " + (b.vehicleReg || "none"));
  const ar = a.rows || [], br = b.rows || [];
  const key = (r) => r.text + "|" + r.routeId + "|" + r.session;
  const used = new Set();
  br.forEach((r, i) => {
    let j = ar.findIndex((x, k) => !used.has(k) && key(x) === key(r));
    if (j < 0 && ar[i] && !used.has(i) && ar[i].time === r.time && !br.some((y) => key(y) === key(ar[i]))) j = i;   // same place, text edited
    if (j < 0) { out.push("Added: " + rowLine(r)); return; }
    used.add(j);
    const o = ar[j];
    if (o.time !== r.time) out.push((o.time || "no time") + " → " + (r.time || "no time") + " " + (r.text || "")); 
    else if (key(o) !== key(r)) out.push("Changed: " + rowLine(o) + " → " + rowLine(r));
  });
  ar.forEach((r, k) => { if (!used.has(k)) out.push("Removed: " + rowLine(r)); });
  if (!out.length && ar.map(key).join() !== br.map(key).join()) out.push("Rows put in a different order");
  return out.map((x) => x.trim()).slice(0, 6);
}
/* -> [{ kind: 'new'|'changed'|'removed', id, date, lines[] }], date order.
   known = null (first time on this phone) -> nothing (the current state just becomes known).
   skip(d) -> true to ignore a duty (e.g. the signed-in admin made that change themselves). */
export function dutyAlerts(known, duties, today, o) {
  o = o || {};
  if (!known) return [];
  const now = knownMap(duties, today, o.days), out = [];
  Object.entries(now).forEach(([id, k]) => {
    const d = (duties || []).find((x) => x.id === id), was = known[id];
    if (o.skip && o.skip(d)) return;
    if (!was) out.push({ kind: "new", id, date: k.date, lines: [("Duty " + k.dutyNo + (k.vehicleReg ? " · " + k.vehicleReg : "")).trim(), ...(k.rows[0] ? [rowLine(k.rows.find((r) => r.time) || k.rows[0])] : [])] });
    else if (k.stamp !== was.stamp) { const lines = dutyDiff(was, k); if (lines.length) out.push({ kind: "changed", id, date: k.date, lines }); }
  });
  Object.entries(known).forEach(([id, was]) => {
    if (now[id] || was.date < today) return;
    if (o.skipRemoved && o.skipRemoved(id)) return;
    out.push({ kind: "removed", id, date: was.date, lines: ["Duty " + was.dutyNo + " is no longer on your worksheet"] });
  });
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.kind.localeCompare(y.kind));
}
export function alertTitle(al) {
  if (!al.length) return "";
  if (al.length > 1) return al.length + " changes to your duties";
  const a = al[0], when = dayName(a.date).slice(0, 3) + " " + ukDate(a.date);
  return a.kind === "new" ? "New duty for " + when : a.kind === "removed" ? "Duty removed – " + when : "Your duty for " + when + " has changed";
}

/* ================= v24: welcome page from today's duty =================
   The duty's linked rows (time order) -> today's selection for the day plan (same shape as the manual picker: kind + slots)
   and a rank so the runs open in the duty's order. */
const sessOf = (r, row) => (row.session === "AM" || row.session === "PM") ? row.session : (() => { const x = routeSessions(r); return x.am ? "AM" : x.pm ? "PM" : "none"; })();
export function dutyRuns(duty, routes) {
  const rows = ((duty && duty.rows) || []).map((r, i) => ({ r, i })).filter((x) => x.r.routeId && routes && routes[x.r.routeId]);
  rows.sort((a, b) => (a.r.time && b.r.time ? a.r.time.localeCompare(b.r.time) : 0) || a.i - b.i);
  return rows.map(({ r }) => { const rt = routes[r.routeId]; return { routeId: r.routeId, session: sessOf(rt, r), slot: routeService(rt) + "|" + sessOf(rt, r), key: destKey(rt), time: r.time || "", text: r.text || "" }; });
}
export function dutySel(duty, routes) {
  const runs = dutyRuns(duty, routes);
  if (!runs.length) return null;
  const slots = {};
  runs.forEach((x) => { (slots[x.slot] = slots[x.slot] || []); if (!slots[x.slot].includes(x.key)) slots[x.slot].push(x.key); });
  return { kind: "all", slots };
}
/* position of a route in the duty (null = not on it) */
export function dutyRank(duty, routes) {
  const runs = dutyRuns(duty, routes);
  return (r) => {
    if (!r) return null;
    const i = runs.findIndex((x) => { const [type, sess] = x.slot.split("|"); return destKey(r) === x.key && routeMatchesPick(r, { type, sess }); });
    return i < 0 ? null : i;
  };
}
/* the week strip: today + the next 6 days */
export function weekStrip(duties, today, changedIds) {
  const ch = new Set(changedIds || []);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const date = addDays(today, i), d = (duties || []).find((x) => x.date === date) || null;
    const first = d && (d.rows || []).find((r) => r.time);
    const sum = d ? ((d.rows || []).find((r) => r.routeId && r.text) || (d.rows || []).find((r) => r.text) || {}).text || "" : "";
    return { date, day: dayName(date).slice(0, 3), dm: ukDate(date).slice(0, 5), today: i === 0, duty: d, dutyNo: d ? d.dutyNo : "", report: first ? first.time : "", summary: sum, changed: !!(d && ch.has(d.id)) };
  });
}
