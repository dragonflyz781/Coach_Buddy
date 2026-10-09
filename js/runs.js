/* Admin "Runs" tab: submitted runs (companies/{companyId}/runs), newest first, with filters,
   a totals summary, an expandable per-stop breakdown, delete and CSV download. */
import {
  collection, query, orderBy, limit, onSnapshot, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { $, esc, toast, friendlyError } from "./ui.js?v=16";

const MAX_RUNS = 2000;          // newest 2000 runs are loaded (keeps reads bounded)
let ctx = null, unsub = null, wired = false;
let runs = [];                  // normalised, newest first
const open = new Set();         // expanded run ids

export function initRuns(c) {
  ctx = c;
  if (!wired) { wired = true; wire(); }
  if (unsub) unsub();
  unsub = onSnapshot(
    query(collection(ctx.db, "companies", ctx.companyId, "runs"), orderBy("submittedAt", "desc"), limit(MAX_RUNS)),
    (snap) => {
      runs = snap.docs.map((d) => normalise(d.id, d.data({ serverTimestamps: "estimate" })));
      refreshFilterOptions();
      render();
    },
    (err) => { console.warn("runs listener:", err && err.code); toast("Could not load runs: " + friendlyError(err), true); }
  );
}

const ms = (t) => (t && t.toMillis ? t.toMillis() : typeof t === "number" ? t : 0);
function normalise(id, d) {
  return {
    id, routeId: d.routeId || "", routeName: d.routeName || "", session: d.session || "",
    driverUid: d.driverUid || "", driverName: d.driverName || "",
    startedAt: ms(d.startedAt), submittedAt: ms(d.submittedAt),
    // Only boardings are shown. Runs also carry totalAlighted / alighted fields (always 0 in new runs, real numbers in old ones);
    // they exist only for Firestore-rules compatibility and are deliberately NOT read or displayed.
    totalBoarded: d.totalBoarded | 0,
    unscheduledBoarded: d.unscheduledBoarded | 0,
    stops: Array.isArray(d.stops) ? d.stops.map((s) => ({ index: s.index | 0, name: String(s.name || ""), boarded: s.boarded | 0 })) : [],
    // v16: incidents flagged by the driver (optional)
    incidents: Array.isArray(d.incidents) ? d.incidents.slice(0, 20).map(normInc) : []
  };
}
export const INC_LABEL = { passenger: "Passenger issue", road: "Road user issue", other: "Other" };
function normInc(x) {
  x = x || {};
  const at = x.at && x.at.toMillis ? x.at.toMillis() : typeof x.at === "number" ? x.at : (x.at ? Date.parse(x.at) || 0 : 0);
  return {
    at, type: INC_LABEL[x.type] ? x.type : "other", note: String(x.note || ""), cctv: !!x.cctv,
    stopIndex: typeof x.stopIndex === "number" ? x.stopIndex : null, stopName: String(x.stopName || ""),
    lat: typeof x.lat === "number" ? x.lat : null, lng: typeof x.lng === "number" ? x.lng : null
  };
}
const cctvCount = (r) => r.incidents.filter((i) => i.cctv).length;

/* ---------- formatting ---------- */
const pad = (n) => (n < 10 ? "0" : "") + n;
function hhmm(t) {
  if (!t) return "—";
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t)); }
  catch (e) { const d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
}
const incStop = (i) => (i.stopIndex != null ? "Stop " + (i.stopIndex + 1) + (i.stopName ? " · " + i.stopName : "") : "");
function fmtDateTime(t) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function isoLocal(t) {
  if (!t) return "";
  const d = new Date(t);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
const sessionLabel = (s) => (s === "both" ? "AM+PM" : s || "—");

/* ---------- filters ---------- */
function refreshFilterOptions() {
  const fill = (selId, pairs, allLabel) => {
    const sel = $(selId), cur = sel.value;
    sel.innerHTML = '<option value="">' + allLabel + "</option>" +
      pairs.map(([v, l]) => '<option value="' + esc(v) + '">' + esc(l) + "</option>").join("");
    sel.value = pairs.some(([v]) => v === cur) ? cur : "";
  };
  const routes = new Map(), drivers = new Map();
  runs.forEach((r) => {                                   // newest first: first name seen = latest name
    if (!routes.has(r.routeId)) routes.set(r.routeId, r.routeName || r.routeId);
    if (!drivers.has(r.driverUid)) drivers.set(r.driverUid, r.driverName || r.driverUid);
  });
  const byLabel = (a, b) => a[1].localeCompare(b[1], undefined, { numeric: true });
  fill("runFltRoute", [...routes].sort(byLabel), "All routes");
  fill("runFltDriver", [...drivers].sort(byLabel), "All drivers");
}

function filtered() {
  const route = $("runFltRoute").value, driver = $("runFltDriver").value, inc = $("runFltInc") ? $("runFltInc").value : "";
  const from = $("runFltFrom").value ? new Date($("runFltFrom").value + "T00:00:00").getTime() : null;
  const to = $("runFltTo").value ? new Date($("runFltTo").value + "T23:59:59.999").getTime() : null;
  return runs.filter((r) =>
    (!route || r.routeId === route) && (!driver || r.driverUid === driver) &&
    (from == null || r.submittedAt >= from) && (to == null || r.submittedAt <= to) &&
    (!inc || (inc === "inc" ? r.incidents.length > 0 : cctvCount(r) > 0)));
}

/* ---------- rendering ---------- */
function stopsTable(r) {
  let h = '<table class="run-table"><thead><tr><th>Stop</th><th class="n">Boarded</th></tr></thead><tbody>';
  r.stops.forEach((s) => {
    h += "<tr><td>" + (s.index + 1) + ". " + esc(s.name) + '</td><td class="n">' + s.boarded + "</td></tr>";
  });
  h += '<tr class="unsched"><td>Unscheduled (not at a stop)</td><td class="n">' + r.unscheduledBoarded + "</td></tr>";
  h += '<tr class="tot"><td>Total</td><td class="n">' + r.totalBoarded + "</td></tr></tbody></table>";
  return h;
}

function incidentsHtml(r) {
  if (!r.incidents.length) return "";
  return '<div class="run-incs"><b>⚠️ Incidents (' + r.incidents.length + ")</b>" + r.incidents.map((i, n) =>
    '<div class="run-inc"><div class="ri-head">' + (n + 1) + ". " + esc(hhmm(i.at)) + " · " + esc(INC_LABEL[i.type]) +
      (incStop(i) ? " · " + esc(incStop(i)) : "") + "</div>" +
      (i.note ? '<div class="ri-note">' + esc(i.note) + "</div>" : '<div class="ri-note muted">No description</div>') +
      '<div class="ri-cctv' + (i.cctv ? " yes" : "") + '">CCTV check requested: ' + (i.cctv ? "Yes" : "No") + "</div></div>").join("") + "</div>";
}

function render() {
  const list = filtered();
  const tb = list.reduce((a, r) => a + r.totalBoarded, 0);
  $("runSummary").innerHTML = runs.length
    ? "<b>" + tb + "</b> passengers boarded · <b>" + list.length + "</b> run" + (list.length === 1 ? "" : "s") +
      (list.length !== runs.length ? ' <span class="muted">(filtered from ' + runs.length + ")</span>" : "")
    : "No runs yet.";
  $("runCsvBtn").disabled = !list.length;
  const wrap = $("runList");
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-note">' + (runs.length ? "No runs match these filters." :
      "No runs submitted yet.<br>Drivers send them with <b>Finish &amp; submit run</b> in the driver view.") + "</div>";
    return;
  }
  let h = '<div class="run-head hdr"><div>DATE / TIME</div><div>DRIVER</div><div>ROUTE</div><div>SESSION</div>' +
          '<div class="num">BOARDED</div></div>';
  list.forEach((r) => {
    const isOpen = open.has(r.id);
    const nInc = r.incidents.length, nCctv = cctvCount(r);
    const badges = (nInc ? '<span class="inc-badge inc" title="Incidents">⚠️ ' + nInc + "</span>" : "") +
                   (nCctv ? '<span class="inc-badge cctv" title="CCTV check requested">CCTV</span>' : "");
    h += '<div class="run-card' + (nInc ? " has-inc" : "") + '" data-run-id="' + esc(r.id) + '"><div class="run-head" data-act="toggle" role="button" tabindex="0" aria-expanded="' + isOpen + '">' +
      '<div class="when"><span class="lbl">DATE / TIME</span>' + esc(fmtDateTime(r.submittedAt)) + "</div>" +
      '<div class="drv"><span class="lbl">DRIVER</span>' + esc(r.driverName) + "</div>" +
      '<div class="rte"><span class="lbl">ROUTE</span>' + esc(r.routeName) + badges + "</div>" +
      '<div class="ses"><span class="lbl">SESSION</span>' + esc(sessionLabel(r.session)) + "</div>" +
      '<div class="num b"><span class="lbl">BOARDED</span>' + r.totalBoarded + "</div></div>" +
      (isOpen ? '<div class="run-detail">' + incidentsHtml(r) + stopsTable(r) +
        '<div class="muted">Started ' + esc(fmtDateTime(r.startedAt)) + " · submitted " + esc(fmtDateTime(r.submittedAt)) + "</div>" +
        '<div class="row"><button class="btn small danger" data-act="del">Delete run</button></div></div>' : "") +
      "</div>";
  });
  wrap.innerHTML = h;
}

/* ---------- CSV ---------- */
// One row per stop per run (plus one "Unscheduled" row per run). Text cells that start with = + - @ get a
// leading apostrophe so a spreadsheet can never treat them as a formula.
function csvCell(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function buildCsv(list) {
  // v16: plus one "Incident" row per incident (its stop in Stop number / Stop name, details in the Incident columns)
  const rows = [["Run ID", "Submitted", "Started", "Driver", "Route", "Session", "Stop number", "Stop name", "Boarded",
                 "Incident time", "Incident type", "Incident description", "CCTV check requested"]];
  list.forEach((r) => {
    const head = [r.id, isoLocal(r.submittedAt), isoLocal(r.startedAt), r.driverName, r.routeName, r.session];
    r.stops.forEach((s) => rows.push([...head, s.index + 1, s.name, s.boarded, "", "", "", ""]));
    rows.push([...head, "", "Unscheduled", r.unscheduledBoarded, "", "", "", ""]);
    r.incidents.forEach((i) => rows.push([...head, i.stopIndex != null ? i.stopIndex + 1 : "", "Incident" + (i.stopName ? " – " + i.stopName : ""), "",
      isoLocal(i.at), INC_LABEL[i.type], i.note, i.cctv ? "Yes" : "No"]));
  });
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
function downloadCsv() {
  const list = filtered();
  if (!list.length) return;
  const blob = new Blob([buildCsv(list)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const t = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = "runs-" + t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Downloaded " + list.length + " run" + (list.length === 1 ? "" : "s") + " as CSV.");
}

/* ---------- events ---------- */
async function deleteRun(id) {
  const r = runs.find((x) => x.id === id);
  if (!r) return;
  if (!confirm("Delete this run (" + r.routeName + ", " + r.driverName + ", " + fmtDateTime(r.submittedAt) + ")? This cannot be undone.")) return;
  try { await deleteDoc(doc(ctx.db, "companies", ctx.companyId, "runs", id)); open.delete(id); toast("Run deleted."); }
  catch (e) { toast("Could not delete: " + friendlyError(e), true); }
}

function wire() {
  ["runFltRoute", "runFltDriver", "runFltFrom", "runFltTo", "runFltInc"].forEach((id) => {
    if (!$(id)) return;
    $(id).addEventListener("input", render); $(id).addEventListener("change", render);
  });
  $("runFltClear").addEventListener("click", () => {
    ["runFltRoute", "runFltDriver", "runFltFrom", "runFltTo", "runFltInc"].forEach((id) => { if ($(id)) $(id).value = ""; });
    render();
  });
  $("runCsvBtn").addEventListener("click", downloadCsv);
  const toggle = (card) => {
    const id = card.dataset.runId;
    if (open.has(id)) open.delete(id); else open.add(id);
    render();
  };
  $("runList").addEventListener("click", (ev) => {
    const card = ev.target.closest(".run-card");
    if (!card) return;
    if (ev.target.closest('[data-act="del"]')) { deleteRun(card.dataset.runId); return; }
    if (ev.target.closest('[data-act="toggle"]')) toggle(card);
  });
  $("runList").addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches('[data-act="toggle"]')) { ev.preventDefault(); toggle(ev.target.closest(".run-card")); }
  });
}
