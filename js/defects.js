/* v18: vehicle checks - the pure logic behind the two paper sheets (no Firebase / DOM here, unit-tested in tests/defects.test.mjs).
     white sheet  "Drivers 1st Use Pre Drive Away Check"   kind 'predrive'   before taking the vehicle out
     pink sheet   "Drivers Defect Report Form"              kind 'endofduty'  at the end of the duty
   Stored as companies/{cid}/defects/{id} (see firestore.rules). */

export const CHECK_ITEMS = [
  { key: "coolant_oil", label: "Engine Coolant & Oil Levels" },
  { key: "adblue", label: "AdBlue (if applicable)", na: true },
  { key: "mirrors_horn", label: "Mirrors & Horn" },
  { key: "o_licence", label: "“O” Licence Disc" },
  { key: "wipers", label: "Windscreen Wipers / Washers" },
  { key: "tyres", label: "Tyres, Wheelnuts & Fixings" },
  { key: "steering", label: "Steering System" },
  { key: "height_ind", label: "Vehicle Height Indicator" },
  { key: "emergency_exits", label: "Emergency Doors & Exits" },
  { key: "leaks", label: "Leaks Or Insecure Items" },
  { key: "engine_luggage", label: "Engine & Luggage Doors" },
  { key: "lights", label: "Side/Tail/Headlights/No. Plate" },
  { key: "indicators", label: "Indicators / Hazards / Brake Lights" },
  { key: "body", label: "Body Panels Glass & Trims" },
  { key: "service_doors", label: "Passenger Service Doors" },
  { key: "extinguisher", label: "Fire Extinguisher / 1st Aid Kit" },
  { key: "seats_belts", label: "Seats / Belts & Vehicle Interior" },
  { key: "tachograph", label: "Tachograph (if fitted)", na: true },
  { key: "braking", label: "Braking System" },
  { key: "exhaust", label: "No Excessive Exhaust Smoke" },
  { key: "warning_lamps", label: "Warning Lamps" }
];
export const ITEM_LABEL = Object.fromEntries(CHECK_ITEMS.map((i) => [i.key, i.label]));
export const NOTE_MAX = 200;              // what's wrong with an X item
export const DEFECT_LINES = 3;            // the pink sheet has 3 lines
export const DEFECT_LINE_MAX = 300;
export const DUTY_NO_MAX = 40;
export const SIG_TARGET = 50000;          // signature PNG data URL: aim for <= ~50 KB ...
export const SIG_MAX = 70000;             // ... the rules refuse anything bigger
export const MILES_MAX = 9999999;

/* "123,456" / " 123456 " -> 123456; anything else -> null */
export function parseMileage(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,\s]/g, "");
  if (!/^\d{1,7}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n <= MILES_MAX ? n : null;
}

/* 'YYYY-MM-DD' (duty day) -> 'DD/MM/YYYY' as on the paper form */
export function ukDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
}
/* today's calendar date in London as 'YYYY-MM-DD' (for "Defect rectified ... Date") */
export function londonIsoDate(ms) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms == null ? Date.now() : ms)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return p.year + "-" + p.month + "-" + p.day;
}
export function londonDateTime(ms) {
  if (!ms) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/* ------------------------------------------------------------------ white sheet */
/* items: { key: 'ok'|'x'|'na' }, notes: { key: text } -> what still needs doing */
export function checkPredrive(f) {
  const items = (f && f.items) || {}, notes = (f && f.notes) || {};
  const missing = [], needNote = [], errors = [];
  CHECK_ITEMS.forEach((it) => {
    const v = items[it.key];
    const okv = v === "ok" || v === "x" || (v === "na" && it.na);
    if (!okv) missing.push(it.key);
    else if (v === "x" && !String(notes[it.key] || "").trim()) needNote.push(it.key);
  });
  const mileage = parseMileage(f && f.mileage);
  if (mileage === null) errors.push("Enter the vehicle mileage.");
  if (missing.length) errors.push(missing.length === 1 ? "1 check still needs a tick or an X." : missing.length + " checks still need a tick or an X.");
  if (needNote.length) errors.push("Say what's wrong for every X.");
  if (String((f && f.dutyNo) || "").length > DUTY_NO_MAX) errors.push("Duty no. is too long.");
  return { ok: !errors.length, errors, missing, needNote, mileage };
}
/* "All OK": every unanswered item becomes OK; X / N/A answers are kept */
export function allOk(items) {
  const out = { ...(items || {}) };
  CHECK_ITEMS.forEach((it) => { if (!out[it.key]) out[it.key] = "ok"; });
  return out;
}
export function predriveDefects(items, notes) {
  return CHECK_ITEMS.filter((it) => (items || {})[it.key] === "x")
    .map((it) => it.label + (String((notes || {})[it.key] || "").trim() ? ": " + String(notes[it.key]).trim() : ""));
}
/* the Firestore document (createdAt is added by the caller as serverTimestamp()) */
export function buildPredrive(f) {
  const items = {}, notes = {};
  CHECK_ITEMS.forEach((it) => {
    const v = (f.items || {})[it.key];
    items[it.key] = v === "na" && !it.na ? "ok" : v;
    if (v === "x") notes[it.key] = String((f.notes || {})[it.key] || "").trim().slice(0, NOTE_MAX);
  });
  const hasDefect = Object.values(items).includes("x");
  const d = {
    kind: "predrive", vehicleReg: String(f.vehicleReg || "").slice(0, 20), driverUid: f.driverUid,
    driverName: String(f.driverName || "Driver").slice(0, 120), dutyDay: f.dutyDay,
    mileage: parseMileage(f.mileage), items, notes, nil: !hasDefect, hasDefect, status: hasDefect ? "open" : "nil"
  };
  if (f.vehicleId) d.vehicleId = String(f.vehicleId).slice(0, 128);
  const dn = String(f.dutyNo || "").trim().slice(0, DUTY_NO_MAX);
  if (dn) d.dutyNo = dn;
  return d;
}

/* ------------------------------------------------------------------ pink sheet */
export function cleanDefectLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((x) => String(x || "").trim().slice(0, DEFECT_LINE_MAX)).filter(Boolean).slice(0, DEFECT_LINES);
}
/* f: { nil, defects[], endMileage, startMileage?, signature?, signedName?, lowOk? } */
export function checkEndOfDuty(f) {
  const errors = [];
  const lines = cleanDefectLines(f && f.defects);
  if (f.nil !== true && f.nil !== false) errors.push("Choose “Nil defects” or report a defect.");
  else if (!f.nil && !lines.length) errors.push("Write the defect (or choose “Nil defects”).");
  const endMileage = parseMileage(f.endMileage);
  if (endMileage === null) errors.push("Enter the end mileage.");
  const sig = String(f.signature || ""), typed = String(f.signedName || "").trim();
  if (!sig && !typed) errors.push("Sign the form.");
  if (sig && sig.length > SIG_MAX) errors.push("The signature is too big – clear it and sign again.");
  const start = parseMileage(f.startMileage);
  const low = endMileage !== null && start !== null && endMileage < start;
  return { ok: !errors.length && (!low || !!f.lowOk), errors, low, lines, endMileage, start };
}
export function buildEndOfDuty(f) {
  const lines = f.nil ? [] : cleanDefectLines(f.defects);
  const hasDefect = lines.length > 0;
  const d = {
    kind: "endofduty", vehicleReg: String(f.vehicleReg || "").slice(0, 20), driverUid: f.driverUid,
    driverName: String(f.driverName || "Driver").slice(0, 120), dutyDay: f.dutyDay,
    endMileage: parseMileage(f.endMileage), defects: lines, nil: !hasDefect, hasDefect, status: hasDefect ? "open" : "nil"
  };
  if (f.vehicleId) d.vehicleId = String(f.vehicleId).slice(0, 128);
  const start = parseMileage(f.startMileage);
  if (start !== null) d.startMileage = start;
  if (f.signature) d.signature = String(f.signature);
  const typed = String(f.signedName || "").trim().slice(0, 120);
  if (typed) d.signedName = typed;
  return d;
}

/* ------------------------------------------------------------------ lists (admin tab / maintenance view) */
export function toMs(t) {
  if (!t) return 0;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  const p = Date.parse(t); return isNaN(p) ? 0 : p;
}
export function normDefect(id, d) {
  d = d || {};
  return {
    id, kind: d.kind === "endofduty" ? "endofduty" : "predrive", vehicleId: d.vehicleId || "", vehicleReg: String(d.vehicleReg || ""),
    driverUid: d.driverUid || "", driverName: String(d.driverName || ""), dutyDay: String(d.dutyDay || ""), dutyNo: String(d.dutyNo || ""),
    mileage: typeof d.mileage === "number" ? d.mileage : null, startMileage: typeof d.startMileage === "number" ? d.startMileage : null,
    endMileage: typeof d.endMileage === "number" ? d.endMileage : null,
    items: d.items && typeof d.items === "object" ? d.items : {}, notes: d.notes && typeof d.notes === "object" ? d.notes : {},
    defects: Array.isArray(d.defects) ? d.defects.map(String) : [], nil: !!d.nil, hasDefect: !!d.hasDefect,
    signature: typeof d.signature === "string" && /^data:image\/(png|jpeg);base64,/.test(d.signature) ? d.signature : "",
    signedName: String(d.signedName || ""), createdAt: toMs(d.createdAt),
    status: ["open", "rectified", "nil"].includes(d.status) ? d.status : (d.hasDefect ? "open" : "nil"),
    rectifiedBy: String(d.rectifiedBy || ""), rectifiedOn: String(d.rectifiedOn || ""), rectifiedNote: String(d.rectifiedNote || ""),
    rectifiedAt: toMs(d.rectifiedAt)
  };
}
export const KIND_LABEL = { predrive: "Pre-drive check", endofduty: "End of duty" };
export const STATUS_LABEL = { open: "Defect – open", rectified: "Rectified", nil: "Nil defects" };
/* what's wrong, as lines (white sheet: the X items with their notes; pink sheet: the defect lines) */
export function defectLines(r) {
  return r.kind === "predrive" ? predriveDefects(r.items, r.notes) : r.defects.slice();
}
/* show: '' (all) | 'defects' | 'open' | 'rectified' | 'nil';  vehicle: '' | vehicleReg */
export function filterDefects(list, show, vehicle) {
  return list.filter((r) => (!vehicle || r.vehicleReg === vehicle) &&
    (!show || (show === "defects" ? r.hasDefect : r.status === show)));
}
export const byNewest = (a, b) => (b.createdAt || Infinity) - (a.createdAt || Infinity);
/* maintenance: open first, then newest */
export function sortForMaintenance(list) {
  return list.slice().sort((a, b) => ((a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1)) || byNewest(a, b));
}
const csvCell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function buildDefectCsv(list) {
  const rows = [["Duty day", "Submitted", "Sheet", "Vehicle", "Driver", "Duty no", "Start mileage", "End mileage", "Result", "Defects",
    "Status", "Rectified by", "Rectified on", "Rectified note"]];
  list.forEach((r) => rows.push([r.dutyDay, r.createdAt ? new Date(r.createdAt).toISOString() : "", KIND_LABEL[r.kind], r.vehicleReg, r.driverName,
    r.dutyNo, r.kind === "predrive" ? r.mileage : r.startMileage, r.endMileage, r.hasDefect ? "Defect" : "Nil", defectLines(r).join(" | "),
    STATUS_LABEL[r.status], r.rectifiedBy, r.rectifiedOn, r.rectifiedNote]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
