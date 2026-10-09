/* Admin screens: route management (with GPX import + editor) and driver management. */
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc, collection, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { createSecondaryAuth } from "./firebase-init.js?v=16";
import { $, esc, toast, setView, friendlyError, toggleTheme, readServicePick, setServicePick, wireServicePick } from "./ui.js?v=16";
import { normServiceTypes, pickedServiceTypes, defaultRouteServiceType, serviceLabel, serviceIcon, SERVICE_KEYS } from "./services.js?v=16";
import { validateVehicle, cleanVehicle, vehicleDims } from "./vehicles.js?v=16";
import { parseGPX, fitTrack, decodePolyline, encodePolyline } from "./geo.js?v=16";
import { initRuns } from "./runs.js?v=16";
import { initAdminDefects } from "./defectlist.js?v=18";
import { buildBackup, parseBackup, planRestore, backupFileName, routeFileName, MAX_RESTORE_ROUTES, MAX_RESTORE_BYTES } from "./backup.js?v=16";
import { normOp, opEmpty, opEqual, validateOperator, routeIsCustom, planApply, OP_LIMITS } from "./operator.js?v=16";

let ctx = null;            // { db, auth, user, profile, companyId, company, openDriver, signOutAndReset }
let rawRoutes = {};        // id -> Firestore data (kept up to date by main.js)
let rawVehicles = {};      // id -> vehicle (kept up to date by main.js)
let unsubUsers = null;
let wired = false;

const routesCol = () => collection(ctx.db, "companies", ctx.companyId, "routes");

/* =============================================================== setup */
export function initAdmin(c) {
  ctx = c;
  $("adminCompany").textContent = c.company.name;
  $("adminWho").textContent = (c.profile.name || c.user.email) + " · Administrator";
  if (!wired) { wired = true; wire(); }
  subscribeUsers();
  initRuns(c);
  initAdminDefects(c);                     // v18: Vehicle defects tab
  fillOperatorForm(); renderApplyInfo(); fillServiceForm();
}

export function showAdmin() {
  setView("admin");
  renderRouteList();
}

export function onRoutesChanged(raw) {
  rawRoutes = raw;
  if (ctx) { renderRouteList(); renderApplyInfo(); }
}

/* the company doc changed (live listener in main.js) */
export function onVehiclesChanged(raw) {
  rawVehicles = raw || {};
  if (ctx) renderVehicleList();
}

export function onCompanyChanged(company) {
  if (!ctx) return;
  ctx.company = company;
  $("adminCompany").textContent = company.name;
  if (!opDirty) fillOperatorForm();
  if (!svcDirty) fillServiceForm();
  renderApplyInfo();
  renderRouteList();
}

const companyOp = () => normOp(ctx && ctx.company && ctx.company.operator);

function wire() {
  $("adminToDriver").addEventListener("click", () => ctx.openDriver());
  $("adminSignOut").addEventListener("click", () => ctx.signOutAndReset());
  $("adminTheme").addEventListener("click", toggleTheme);
  wireTabs();
  $("newRouteBtn").addEventListener("click", () => openEditor(null));
  $("driverForm").addEventListener("submit", addDriver);
  $("dvGen").addEventListener("click", () => { $("dvPass").value = randomPassword(); });
  $("edBack").addEventListener("click", closeEditor);
  $("edSave").addEventListener("click", saveDraft);
  wireOperator();
  wireVehicles();
  wireBackup();
}

/* =============================================================== tabs */
/* Routes / Operator details / Drivers / Runs: each is its own tab, exactly one panel is shown at a time,
   the active tab is highlighted, and the last tab is remembered across a refresh (localStorage 'rt_admin_tab'). */
const ADMIN_TABS = [["Routes", "admRoutes"], ["Operator", "admOperator"], ["Drivers", "admDrivers"], ["Vehicles", "admVehicles"], ["Runs", "admRuns"], ["Defects", "admDefects"]];
const TAB_KEY = "rt_admin_tab";
function showTab(name, save) {
  if (!ADMIN_TABS.some(([n]) => n === name)) name = "Routes";
  ADMIN_TABS.forEach(([n, sec]) => {
    const btn = $("admTab" + n), on = n === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
    $(sec).style.display = on ? "" : "none";
  });
  const act = $("admTab" + name);
  if (act.scrollIntoView) act.scrollIntoView({ block: "nearest", inline: "nearest" });
  moveBus(name, !!save || busReady);
  if (save) { try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* ignore */ } }
}
/* the little bus drives along the road under the tab bar to sit beneath whichever tab is open */
let busReady = false, busX = null, busTimer = 0;
function moveBus(name, animate) {
  const bus = $("tabBus"), road = $("tabRoad"), btn = $("admTab" + name);
  if (!bus || !road || !btn) return;
  const nav = btn.parentElement;
  if (!btn.offsetWidth) { busX = null; return; }   /* admin screen not visible yet: place it once it is */
  /* road = exactly as wide as the tabs (+ padding) or the bar, never based on scrollWidth: that would include the old road and never shrink */
  const lastBtn = nav.querySelector(".tab-btn:last-of-type") || btn, padR = parseFloat(getComputedStyle(nav).paddingRight) || 0;
  road.style.width = Math.max(lastBtn.offsetLeft + lastBtn.offsetWidth + padR, nav.clientWidth) + "px";
  const x = Math.round(btn.offsetLeft + btn.offsetWidth / 2 - 22);
  if (busX === null || !animate) {
    bus.style.transition = "none"; bus.style.transform = "translateX(" + x + "px)";
    void bus.getBoundingClientRect(); bus.style.transition = ""; busX = x; busReady = true; return;
  }
  if (x === busX) return;
  bus.classList.toggle("go-left", x < busX);
  bus.classList.add("driving");
  bus.style.transform = "translateX(" + x + "px)"; busX = x;
  clearTimeout(busTimer); busTimer = setTimeout(() => bus.classList.remove("driving"), 650);
}
window.addEventListener("resize", () => { const a = document.querySelector(".admin-tabs .tab-btn.active"); if (a) { busX = null; moveBus(a.id.replace("admTab", ""), false); } });

function wireTabs() {
  ADMIN_TABS.forEach(([n], i) => {
    const btn = $("admTab" + n);
    btn.addEventListener("click", () => showTab(n, true));
    btn.addEventListener("keydown", (ev) => {
      const k = ev.key, last = ADMIN_TABS.length - 1;
      const j = k === "ArrowRight" ? (i + 1) % ADMIN_TABS.length : k === "ArrowLeft" ? (i + last) % ADMIN_TABS.length : k === "Home" ? 0 : k === "End" ? last : -1;
      if (j < 0) return;
      ev.preventDefault(); showTab(ADMIN_TABS[j][0], true); $("admTab" + ADMIN_TABS[j][0]).focus();
    });
  });
  if (window.ResizeObserver) new ResizeObserver(() => { const a = document.querySelector(".admin-tabs .tab-btn.active"); if (a) { const was = busX; if (was === null || !busReady) moveBus(a.id.replace("admTab", ""), false); } }).observe($("admTabRoutes").parentElement);
  let saved = "Routes";
  try { saved = localStorage.getItem(TAB_KEY) || "Routes"; } catch (e) { /* ignore */ }
  showTab(saved, false);
}

/* =============================================================== route list */
function sessionLabel(s) { return s === "AM" ? "AM" : s === "PM" ? "PM" : s === "both" ? "AM+PM" : "—"; }

/* "custom" (route-specific), "company" (follows / equals the company operator) or "none" */
function opState(r) {
  if (routeIsCustom(r, companyOp())) return "custom";
  return opEmpty(r.operator) && opEmpty(companyOp()) ? "none" : "company";
}

function renderRouteList() {
  const list = $("adminRouteList");
  const ids = Object.keys(rawRoutes).sort((a, b) =>
    String(rawRoutes[a].name || "").localeCompare(String(rawRoutes[b].name || ""), undefined, { numeric: true }));
  $("routesStatus").textContent = ids.length ? ids.length + " route" + (ids.length === 1 ? "" : "s") : "";
  if (!ids.length) {
    list.innerHTML = '<div class="empty-note">No routes yet.<br>Tap <b>＋ New route</b> to upload a GPX file, or <b>Restore from backup</b> to load routes from a backup file.</div>';
    return;
  }
  list.innerHTML = "";
  ids.forEach((id) => {
    const r = rawRoutes[id];
    const el = document.createElement("div");
    el.className = "arow";
    el.dataset.routeId = id;
    const initials = (r.name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
    el.innerHTML =
      '<div class="route-badge">' + esc(initials) + "</div>" +
      '<div class="route-meta"><div class="name">' + esc(r.name || "Untitled") + "</div>" +
      '<div class="sub"><span class="pill">' + esc(r.category || "other") + '</span><span class="pill">' + esc(sessionLabel(r.session)) + "</span>" +
      (r.serviceType ? '<span class="pill svc-pill" data-svc="' + esc(r.serviceType) + '">' + esc(serviceIcon(r.serviceType) + " " + serviceLabel(r.serviceType)) + "</span>" : "") +
      (r.stops ? r.stops.length : 0) + " stops · " + (r.trackPoints || 0) + " pts" +
      ' <span class="pill op-pill" data-op="' + opState(r) + '" title="Operator details shown to drivers on this route">Operator: ' + opState(r) + "</span></div></div>" +
      '<div class="arow-actions"><button class="btn small" data-act="edit">Edit</button>' +
      '<button class="btn small" data-act="dl" title="Download this route as a JSON file (can be restored later)">Download</button>' +
      '<button class="btn small danger" data-act="del">Delete</button></div>';
    el.querySelector('[data-act="edit"]').addEventListener("click", () => openEditor(id));
    el.querySelector('[data-act="dl"]').addEventListener("click", () => downloadRoute(id));
    el.querySelector('[data-act="del"]').addEventListener("click", () => deleteRoute(id));
    list.appendChild(el);
  });
}

async function deleteRoute(id) {
  const name = (rawRoutes[id] && rawRoutes[id].name) || "this route";
  if (!confirm('Delete "' + name + '"? Drivers will no longer see it. This cannot be undone.')) return;
  try { await deleteDoc(doc(routesCol(), id)); toast("Deleted “" + name + "”."); }
  catch (e) { toast("Could not delete: " + friendlyError(e), true); }
}

/* =============================================================== building a Firestore doc */
const clean = (o) => {
  const out = {};
  Object.keys(o).forEach((k) => {
    const v = o[k];
    if (v === undefined || v === null) return;
    if (typeof v === "string" && v.trim() === "") return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = typeof v === "string" ? v.trim() : v;
  });
  return out;
};

function buildDoc(d) {
  const source = d.track.length ? d.track : d.stops.map((s) => [s.lat, s.lng]);
  const fit = fitTrack(source);
  const data = clean({
    name: d.name, category: d.category, session: d.session, serviceType: SERVICE_KEYS.includes(d.serviceType) ? d.serviceType : "",
    note: d.note, capacity: d.capacity, specifiedRoute: d.specifiedRoute,
    addedAt: d.addedAt || new Date().toISOString()
  });
  const op = clean(d.operator || {});
  if (Object.keys(op).length) data.operator = op;
  data.operatorCustom = !!d.operatorCustom && Object.keys(op).length > 0;   // false = follows the company operator
  const contacts = (d.contacts || []).map((c) => clean(c)).filter((c) => c.label || c.tel);
  if (contacts.length) data.contacts = contacts;
  const tt = {};
  ["morning", "afternoon"].forEach((k) => {
    const rows = (d.timetable[k] || []).map((r) => ({ stop: String(r.stop || "").trim(), time: String(r.time || "").trim() }));
    if (rows.length) tt[k] = rows;
  });
  if ((d.timetable.morningNote || "").trim()) tt.morningNote = d.timetable.morningNote.trim();
  if ((d.timetable.afternoonNote || "").trim()) tt.afternoonNote = d.timetable.afternoonNote.trim();
  if (Object.keys(tt).length) data.timetable = tt;
  data.stops = d.stops.map((s, i) => ({
    lat: Math.round(s.lat * 1e5) / 1e5, lng: Math.round(s.lng * 1e5) / 1e5, name: (s.name || "").trim() || "Stop " + (i + 1)
  }));
  data.trackEnc = encodePolyline(fit.track);
  data.trackPoints = fit.track.length;
  // keep the record of an earlier simplification (done when the GPX was loaded)
  const meta = fit.simplified ? { original: fit.originalPoints, tol: fit.toleranceM } : d.trackMeta;
  data.trackOriginalPoints = meta ? meta.original : fit.originalPoints;
  if (meta) data.trackSimplifiedToleranceM = meta.tol;
  return { data, fit };
}


function checkSize(data) {
  const approx = JSON.stringify(data).length;     // UTF-8 bytes >= chars; ASCII-heavy so close enough
  if (approx > 900000) throw new Error("This route is too large to store (" + Math.round(approx / 1024) + " KB). Remove some stops/timetable rows.");
}

/* =============================================================== backup & restore */
function downloadJson(obj, fileName) {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function backupAll() {
  const n = Object.keys(rawRoutes).length;
  if (!n) { toast("There are no routes to back up yet.", true); return; }
  downloadJson(buildBackup(rawRoutes, ctx.company.name), backupFileName(ctx.company.name));
  toast("Backup of " + n + " route" + (n === 1 ? "" : "s") + " downloaded.");
}

function downloadRoute(id) {
  const r = rawRoutes[id];
  if (!r) return;
  downloadJson(buildBackup({ [id]: r }, ctx.company.name), routeFileName(r.name));
  toast("Downloaded “" + (r.name || "route") + "”.");
}

let pendingRestore = null;     // { routes, fileName, companyName, exportedAt }

function wireBackup() {
  $("backupBtn").addEventListener("click", backupAll);
  $("restoreBtn").addEventListener("click", () => { $("restoreFile").value = ""; $("restoreFile").click(); });
  $("restoreFile").addEventListener("change", onRestoreFile);
}

function closeRestorePanel() {
  pendingRestore = null;
  const p = $("restorePanel");
  p.style.display = "none"; p.innerHTML = "";
}

function showRestoreError(fileName, msg) {
  pendingRestore = null;
  const p = $("restorePanel");
  p.style.display = "";
  p.innerHTML = '<h2>Restore from backup</h2><div class="form-msg restore-error" id="restoreMsg" role="alert"></div>' +
    '<div class="toolbar"><button class="btn small" id="restoreCancel" type="button">Close</button></div>';
  $("restoreMsg").textContent = "Can't restore “" + fileName + "”: " + msg + " Nothing was changed.";
  $("restoreCancel").addEventListener("click", closeRestorePanel);
}

function onRestoreFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  closeRestorePanel();
  if (file.size > MAX_RESTORE_BYTES) { showRestoreError(file.name, "The file is too large (over " + Math.round(MAX_RESTORE_BYTES / 1048576) + " MB)."); return; }
  const reader = new FileReader();
  reader.onerror = () => showRestoreError(file.name, "The file could not be read.");
  reader.onload = () => {
    const res = parseBackup(String(reader.result));
    if (!res.ok) { toast("Not a valid routes backup.", true); showRestoreError(file.name, res.error); return; }
    pendingRestore = { routes: res.routes, fileName: file.name, companyName: res.companyName, exportedAt: res.exportedAt };
    renderRestorePanel();
  };
  reader.readAsText(file);
}

const restoreMode = () => (document.querySelector('input[name="restoreMode"]:checked') || {}).value || "add";

function renderRestorePanel() {
  const pr = pendingRestore, p = $("restorePanel");
  if (!pr) return;
  const mode = pr.mode || "add";
  const names = pr.routes.map((r) => r.name);
  const sameName = planRestore(pr.routes, rawRoutes, "replace").filter((x) => x.targetId).length;
  p.style.display = "";
  p.innerHTML =
    "<h2>Restore from backup</h2>" +
    '<p class="muted" id="restoreSummary"></p>' +
    '<ul class="restore-names" id="restoreNames"></ul>' +
    '<div class="op-modes">' +
      '<label class="op-mode"><input type="radio" name="restoreMode" value="add"' + (mode === "add" ? " checked" : "") + '><span><b>Add as new routes</b> (default – never overwrites or deletes anything you have)</span></label>' +
      '<label class="op-mode"><input type="radio" name="restoreMode" value="replace"' + (mode === "replace" ? " checked" : "") + '><span><b>Replace routes with the same name</b> (matching routes are overwritten with the backup; the others are added)</span></label>' +
    "</div>" +
    '<div class="muted" id="restoreInfo" role="status"></div>' +
    '<div class="toolbar" style="margin-top:10px"><button class="btn primary" id="restoreGo" type="button"></button><button class="btn" id="restoreCancel" type="button">Cancel</button></div>' +
    '<div class="form-msg" id="restoreMsg" role="status"></div>';
  $("restoreSummary").textContent = "“" + pr.fileName + "”: " + names.length + " route" + (names.length === 1 ? "" : "s") +
    (pr.companyName ? " from a backup of " + pr.companyName : "") + (pr.exportedAt ? " (made " + pr.exportedAt.slice(0, 10) + ")" : "") + ".";
  const ul = $("restoreNames");
  names.slice(0, 200).forEach((n) => { const li = document.createElement("li"); li.textContent = n; ul.appendChild(li); });
  if (names.length > 200) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "… and " + (names.length - 200) + " more"; ul.appendChild(li); }
  const info = mode === "replace"
    ? sameName + " existing route" + (sameName === 1 ? "" : "s") + " with the same name will be replaced; " + (names.length - sameName) + " will be added as new."
    : names.length + " route" + (names.length === 1 ? "" : "s") + " will be added as new" + (sameName ? " (" + sameName + " have the same name as a route you already have, so you will have duplicates)" : "") + ". Nothing existing is changed.";
  $("restoreInfo").textContent = info;
  $("restoreGo").textContent = (mode === "replace" ? "Restore (replace same names)" : "Restore as new routes") + " (" + names.length + ")";
  document.querySelectorAll('input[name="restoreMode"]').forEach((r) => r.addEventListener("change", () => { pr.mode = restoreMode(); renderRestorePanel(); }));
  $("restoreCancel").addEventListener("click", closeRestorePanel);
  $("restoreGo").addEventListener("click", doRestore);
}

async function doRestore() {
  const pr = pendingRestore, msg = $("restoreMsg");
  if (!pr) return;
  const mode = pr.mode || "add";
  msg.className = "form-msg"; msg.textContent = "";
  // build and size-check EVERYTHING before the first write
  let docs;
  try {
    if (pr.routes.length > MAX_RESTORE_ROUTES) throw new Error("Too many routes in one restore (limit " + MAX_RESTORE_ROUTES + ").");
    const plan = planRestore(pr.routes, rawRoutes, mode);
    docs = plan.map(({ index, targetId }) => {
      const r = pr.routes[index];
      const custom = r.operatorCustom === null ? routeIsCustom({ operator: r.operator }, companyOp()) : r.operatorCustom;
      const { data } = buildDoc({
        name: r.name, category: r.category, session: r.session, serviceType: r.serviceType, note: r.note, capacity: r.capacity, specifiedRoute: r.specifiedRoute,
        addedAt: r.addedAt, operator: r.operator, operatorCustom: custom, contacts: r.contacts, timetable: r.timetable,
        track: r.track, stops: r.stops, trackMeta: r.trackMeta
      });
      data.updatedAt = serverTimestamp(); data.updatedBy = ctx.user.uid;
      checkSize(data);
      return { id: targetId, data, name: r.name };
    });
  } catch (e) { msg.textContent = e.message + " Nothing was changed."; return; }
  const replaced = docs.filter((d) => d.id).length, added = docs.length - replaced;
  const what = mode === "replace"
    ? "Restore " + docs.length + " route(s): " + replaced + " existing route(s) with the same name will be REPLACED by the backup, " + added + " will be added."
    : "Add " + docs.length + " route(s) from the backup as NEW routes. Nothing you already have is changed or deleted.";
  if (!confirm(what + "\n\nContinue?")) return;
  $("restoreGo").disabled = true; $("restoreCancel").disabled = true;
  let done = 0;
  try {
    for (let i = 0; i < docs.length; i += 10) {
      const batch = writeBatch(ctx.db);
      docs.slice(i, i + 10).forEach((d) => { batch.set(d.id ? doc(routesCol(), d.id) : doc(routesCol()), d.data); });
      await batch.commit();
      done = Math.min(docs.length, i + 10);
      msg.textContent = "Restoring… " + done + " / " + docs.length;
    }
    closeRestorePanel();
    $("restorePanel").style.display = "";
    $("restorePanel").innerHTML = '<h2>Restore from backup</h2><div class="form-msg ok" id="restoreMsg" role="status"></div><div class="toolbar"><button class="btn small" id="restoreCancel" type="button">Close</button></div>';
    $("restoreMsg").textContent = "Restored " + docs.length + " route" + (docs.length === 1 ? "" : "s") + ": " + added + " added, " + replaced + " replaced.";
    $("restoreCancel").addEventListener("click", closeRestorePanel);
    toast("Restored " + docs.length + " route" + (docs.length === 1 ? "" : "s") + ".");
  } catch (e) {
    console.warn("Restore failed:", e && (e.code || e.message));
    msg.className = "form-msg";
    msg.textContent = "Restore stopped after " + done + " of " + docs.length + " routes: " + friendlyError(e) + " (the first " + done + " were written; nothing else was changed).";
    $("restoreGo").disabled = false; $("restoreCancel").disabled = false;
  }
}

/* =============================================================== route editor */
let draft = null, editingId = null, edMap = null, edTrack = null, edStops = null, addingStop = false, trackInfo = "";

function blankDraft() {
  return {
    name: "", category: "school", session: "both", serviceType: "", note: "", capacity: "", specifiedRoute: "", addedAt: null,
    operator: { name: "", address: "", tel: "", email: "" }, operatorCustom: false, contacts: [],
    timetable: { morning: [], afternoon: [], morningNote: "", afternoonNote: "" },
    track: [], stops: []
  };
}

function draftFromRaw(d) {
  const b = blankDraft();
  const tt = d.timetable || {};
  return Object.assign(b, {
    name: d.name || "", category: d.category || "school", session: d.session || "", serviceType: d.serviceType || "", note: d.note || "",
    capacity: d.capacity || "", specifiedRoute: d.specifiedRoute || "", addedAt: d.addedAt || null,
    operator: Object.assign(b.operator, d.operator || {}),
    contacts: (d.contacts || []).map((c) => ({ label: c.label || "", tel: c.tel || "" })),
    timetable: {
      morning: (tt.morning || []).map((r) => ({ stop: r.stop, time: r.time })),
      afternoon: (tt.afternoon || []).map((r) => ({ stop: r.stop, time: r.time })),
      morningNote: tt.morningNote || "", afternoonNote: tt.afternoonNote || ""
    },
    track: d.trackEnc ? decodePolyline(d.trackEnc) : [],
    trackMeta: d.trackSimplifiedToleranceM ? { original: d.trackOriginalPoints, tol: d.trackSimplifiedToleranceM } : null,
    stops: (d.stops || []).map((s) => ({ lat: s.lat, lng: s.lng, name: s.name || "" }))
  });
}

function openEditor(id) {
  editingId = id;
  draft = id ? draftFromRaw(rawRoutes[id]) : blankDraft();
  if (id) {
    // routes that follow the company show the company's CURRENT details; custom ones keep their own
    draft.operatorCustom = routeIsCustom(rawRoutes[id], companyOp());
    if (!draft.operatorCustom && !opEmpty(companyOp())) draft.operator = Object.assign({ name: "", address: "", tel: "", email: "" }, companyOp());
  } else {
    // new route: pre-filled from the company operator (editable per route)
    draft.operator = Object.assign({ name: "", address: "", tel: "", email: "" }, companyOp());
    draft.operatorCustom = false;
    draft.serviceType = defaultRouteServiceType(ctx.company && ctx.company.serviceTypes, draft.category);
  }
  addingStop = false;
  trackInfo = id && rawRoutes[id].trackOriginalPoints && rawRoutes[id].trackSimplifiedToleranceM
    ? "Stored track was simplified from " + rawRoutes[id].trackOriginalPoints.toLocaleString() + " to " + rawRoutes[id].trackPoints.toLocaleString() + " points." : "";
  $("edTitle").textContent = id ? "Edit route" : "New route";
  buildEditorDom();
  setView("editor");
  initEditorMap();
  $("edBody").scrollTop = 0;
}

function closeEditor() {
  if (edMap) { edMap.remove(); edMap = null; }
  draft = null;
  setView("admin");
  renderRouteList();
}

function buildEditorDom() {
  const d = draft;
  $("edBody").innerHTML =
    '<div class="ed-form">' +
    '<div class="ed-card"><h3>Route</h3>' +
      '<label>Route name<input type="text" id="ed_name" maxlength="120" placeholder="e.g. 360 (AM)"></label>' +
      '<div class="grid2"><label>Category<select id="ed_category"><option value="school">School</option><option value="college">College</option><option value="other">Other</option></select></label>' +
      '<label>Session<select id="ed_session"><option value="">Not set (use timetable)</option><option value="AM">AM (morning)</option><option value="PM">PM (afternoon)</option><option value="both">Both</option></select></label></div>' +
      '<label>Service type <span class="muted">(optional – which drivers\' “today” choice shows this route)</span><select id="ed_service">' + serviceOptions(d.serviceType) + "</select></label>" +
      '<label>Note shown at the top of the schedule <span class="muted">(optional)</span><textarea id="ed_note" maxlength="1000"></textarea></label>' +
    "</div>" +
    '<div class="ed-card"><h3>GPX file</h3>' +
      '<label class="file-btn"><span style="font-size:19px">⬆</span><span id="gpxLabel">Upload GPX file (track + waypoints / route points)</span>' +
      '<input type="file" id="ed_gpx" accept=".gpx,.xml,.txt"></label>' +
      '<div class="note-line" id="gpxInfo"></div>' +
    "</div>" +
    '<div class="ed-card"><h3>Stops (in order)</h3><div id="stopList"></div>' +
      '<div class="note-line">Rename, re-order (▲▼) or delete stops here. Drag a marker on the map to move it, or press <b>Add stop on map</b> and click the map.</div></div>' +
    '<div class="ed-card"><h3>Timetable – morning</h3><div id="ttMorning"></div>' +
      '<div class="row"><button class="btn small" id="ttAddMorning" type="button">＋ Add row</button><button class="btn small" id="ttFillMorning" type="button">Fill from stops</button></div>' +
      '<label style="margin-top:8px">Morning note <span class="muted">(optional)</span><input type="text" id="ed_morningNote" maxlength="300"></label></div>' +
    '<div class="ed-card"><h3>Timetable – afternoon</h3><div id="ttAfternoon"></div>' +
      '<div class="row"><button class="btn small" id="ttAddAfternoon" type="button">＋ Add row</button><button class="btn small" id="ttFillAfternoon" type="button">Fill from stops</button></div>' +
      '<label style="margin-top:8px">Afternoon note <span class="muted">(optional)</span><input type="text" id="ed_afternoonNote" maxlength="300"></label></div>' +
    '<div class="ed-card"><h3>Operator &amp; vehicle</h3>' +
      '<div class="op-status-row"><span class="op-status" id="ed_op_status" role="status"></span>' +
      '<button class="btn small" id="ed_op_reset" type="button" title="Replace this route\'s operator details with the company operator">Reset to company details</button></div>' +
      '<label>Operator name<input type="text" id="ed_op_name" maxlength="' + OP_LIMITS.name + '"></label>' +
      '<label>Address<input type="text" id="ed_op_address" maxlength="' + OP_LIMITS.address + '"></label>' +
      '<div class="grid2"><label>Telephone<input type="tel" id="ed_op_tel" maxlength="' + OP_LIMITS.tel + '"></label><label>Email<input type="email" id="ed_op_email" maxlength="' + OP_LIMITS.email + '"></label></div>' +
      '<label>Capacity <span class="muted">(e.g. 53 seats)</span><input type="text" id="ed_capacity" maxlength="60"></label>' +
      '<label>Specified route <span class="muted">(road names, optional)</span><textarea id="ed_specified" maxlength="3000"></textarea></label>' +
      '<div class="muted" style="margin:6px 0 4px;font-weight:600">Other contacts</div><div id="contactList"></div>' +
      '<button class="btn small" id="contactAdd" type="button">＋ Add contact</button>' +
    "</div></div>" +
    '<div class="ed-map-col"><div class="ed-card"><h3>Map preview</h3><div id="edMap"></div>' +
      '<div class="ed-map-tools"><button class="btn small" id="addStopBtn" type="button">📍 Add stop on map</button>' +
      '<span class="muted" id="mapCounts"></span></div></div></div>' +
    '<datalist id="stopNames"></datalist>';

  // simple fields
  const bind = (id, get, set) => { const el = $(id); el.value = get() || ""; el.addEventListener("input", () => set(el.value)); };
  bind("ed_name", () => d.name, (v) => (d.name = v));
  bind("ed_category", () => d.category, (v) => (d.category = v));
  bind("ed_session", () => d.session, (v) => (d.session = v));
  bind("ed_service", () => d.serviceType, (v) => (d.serviceType = v));
  bind("ed_note", () => d.note, (v) => (d.note = v));
  bind("ed_morningNote", () => d.timetable.morningNote, (v) => (d.timetable.morningNote = v));
  bind("ed_afternoonNote", () => d.timetable.afternoonNote, (v) => (d.timetable.afternoonNote = v));
  bind("ed_op_name", () => d.operator.name, (v) => { d.operator.name = v; editorOpChanged(); });
  bind("ed_op_address", () => d.operator.address, (v) => { d.operator.address = v; editorOpChanged(); });
  bind("ed_op_tel", () => d.operator.tel, (v) => { d.operator.tel = v; editorOpChanged(); });
  bind("ed_op_email", () => d.operator.email, (v) => { d.operator.email = v; editorOpChanged(); });
  $("ed_op_reset").addEventListener("click", resetEditorOp);
  bind("ed_capacity", () => d.capacity, (v) => (d.capacity = v));
  bind("ed_specified", () => d.specifiedRoute, (v) => (d.specifiedRoute = v));

  $("ed_gpx").addEventListener("change", onGpxChosen);
  $("addStopBtn").addEventListener("click", () => setAddingStop(!addingStop));
  $("ttAddMorning").addEventListener("click", () => { d.timetable.morning.push({ stop: "", time: "" }); renderTimetable("morning"); });
  $("ttAddAfternoon").addEventListener("click", () => { d.timetable.afternoon.push({ stop: "", time: "" }); renderTimetable("afternoon"); });
  $("ttFillMorning").addEventListener("click", () => fillFromStops("morning"));
  $("ttFillAfternoon").addEventListener("click", () => fillFromStops("afternoon"));
  $("contactAdd").addEventListener("click", () => { d.contacts.push({ label: "", tel: "" }); renderContacts(); });

  renderStopList(); renderTimetable("morning"); renderTimetable("afternoon"); renderContacts(); updateGpxInfo(); renderEditorOpStatus();
}

/* ---- operator indicator in the editor ---- */
function editorOpChanged() {
  // typing details that differ from the company's makes the route "custom"; matching them again goes back to company
  draft.operatorCustom = !opEqual(draft.operator, companyOp());
  renderEditorOpStatus();
}
function renderEditorOpStatus() {
  const el = $("ed_op_status"), btn = $("ed_op_reset");
  if (!el) return;
  const none = opEmpty(companyOp());
  el.dataset.state = draft.operatorCustom ? "custom" : "company";
  el.className = "op-status " + (draft.operatorCustom ? "custom" : "company");
  el.textContent = draft.operatorCustom ? "Custom for this route"
    : "Using company operator details" + (none ? " (none set yet – add them on the Operator tab)" : "");
  btn.disabled = !draft.operatorCustom;
  btn.style.visibility = draft.operatorCustom ? "visible" : "hidden";
}
function resetEditorOp() {
  const co = companyOp();
  if (opEmpty(co) && !confirm("The company has no operator details yet, so this will empty the route's operator fields. Continue?")) return;
  draft.operator = Object.assign({ name: "", address: "", tel: "", email: "" }, co);
  ["name", "address", "tel", "email"].forEach((k) => { $("ed_op_" + k).value = draft.operator[k] || ""; });
  draft.operatorCustom = false;
  renderEditorOpStatus();
}

function updateGpxInfo() {
  const parts = [];
  if (draft.track.length) parts.push("Track: " + draft.track.length.toLocaleString() + " points");
  if (trackInfo) parts.push(trackInfo);
  $("gpxInfo").textContent = parts.join(" · ");
  $("mapCounts").textContent = draft.stops.length + " stops · " + draft.track.length.toLocaleString() + " track pts";
}

/* ---- GPX ---- */
function onGpxChosen(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast("Could not read that file.", true);
  reader.onload = () => {
    try {
      const parsed = parseGPX(String(reader.result), file.name.replace(/\.[^.]+$/, ""));
      if ((draft.stops.length || draft.track.length) &&
          !confirm("Replace this route's current track and stops with the ones in “" + file.name + "”?")) { ev.target.value = ""; return; }
      const fit = fitTrack(parsed.track);
      draft.track = fit.track;
      draft.trackMeta = fit.simplified ? { original: fit.originalPoints, tol: fit.toleranceM } : null;
      draft.stops = parsed.stops;
      if (!draft.name.trim()) { draft.name = parsed.name; $("ed_name").value = parsed.name; }
      trackInfo = fit.simplified
        ? "Simplified from " + fit.originalPoints.toLocaleString() + " to " + fit.track.length.toLocaleString() + " points (tolerance " + fit.toleranceM + " m) so it fits comfortably in the database."
        : "";
      $("gpxLabel").textContent = "Loaded: " + file.name;
      renderStopList(); drawMap(true); updateGpxInfo();
      toast("GPX loaded: " + fit.track.length.toLocaleString() + " track points, " + parsed.stops.length + " stops.");
    } catch (e) { toast(e.message, true); }
    ev.target.value = "";
  };
  reader.readAsText(file);
}

/* ---- stops ---- */
function renderStopList() {
  const wrap = $("stopList");
  wrap.innerHTML = "";
  if (!draft.stops.length) wrap.innerHTML = '<div class="muted">No stops yet.</div>';
  draft.stops.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "rowitem";
    row.dataset.stopIndex = i;
    row.innerHTML = '<div class="idx">' + (i + 1) + '</div><input type="text" class="stop-name" maxlength="120" aria-label="Stop ' + (i + 1) + ' name">' +
      '<button class="mini" type="button" data-a="up" aria-label="Move up"' + (i === 0 ? " disabled" : "") + ">▲</button>" +
      '<button class="mini" type="button" data-a="down" aria-label="Move down"' + (i === draft.stops.length - 1 ? " disabled" : "") + ">▼</button>" +
      '<button class="mini del" type="button" data-a="del" aria-label="Delete stop">✕</button>';
    const inp = row.querySelector("input");
    inp.value = s.name || "";
    inp.addEventListener("input", () => { s.name = inp.value; refreshDatalist(); });
    row.querySelector('[data-a="up"]').addEventListener("click", () => moveStop(i, -1));
    row.querySelector('[data-a="down"]').addEventListener("click", () => moveStop(i, 1));
    row.querySelector('[data-a="del"]').addEventListener("click", () => { draft.stops.splice(i, 1); stopsChanged(); });
    wrap.appendChild(row);
  });
  refreshDatalist();
}
function moveStop(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= draft.stops.length) return;
  const t = draft.stops[i]; draft.stops[i] = draft.stops[j]; draft.stops[j] = t;
  stopsChanged();
}
function stopsChanged() { renderStopList(); drawMap(false); updateGpxInfo(); }
function refreshDatalist() {
  $("stopNames").innerHTML = draft.stops.filter((s) => (s.name || "").trim()).map((s) => '<option value="' + esc(s.name) + '">').join("");
}

/* ---- timetable ---- */
function renderTimetable(which) {
  const wrap = $(which === "morning" ? "ttMorning" : "ttAfternoon");
  const rows = draft.timetable[which];
  wrap.innerHTML = rows.length ? "" : '<div class="muted" style="margin-bottom:6px">No rows – drivers see “No drop times saved” for this part of the day.</div>';
  rows.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = '<input type="text" class="tt-stop" list="stopNames" maxlength="120" placeholder="Stop name" aria-label="Timetable stop">' +
      '<input type="time" class="t tt-time" aria-label="Time">' +
      '<button class="mini del" type="button" aria-label="Delete row">✕</button>';
    const [si, ti] = el.querySelectorAll("input");
    si.value = r.stop || ""; ti.value = r.time || "";
    si.addEventListener("input", () => (r.stop = si.value));
    ti.addEventListener("input", () => (r.time = ti.value));
    el.querySelector("button").addEventListener("click", () => { draft.timetable[which].splice(i, 1); renderTimetable(which); });
    wrap.appendChild(el);
  });
}
function fillFromStops(which) {
  if (!draft.stops.length) { toast("Add some stops first.", true); return; }
  const rows = draft.timetable[which];
  if (rows.length && !confirm("Replace the current " + which + " rows with one row per stop (times left blank for you to fill in)?")) return;
  draft.timetable[which] = draft.stops.map((s, i) => ({ stop: (s.name || "").trim() || "Stop " + (i + 1), time: "" }));
  renderTimetable(which);
}

/* ---- contacts ---- */
function renderContacts() {
  const wrap = $("contactList");
  wrap.innerHTML = "";
  draft.contacts.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = '<input type="text" placeholder="Label (e.g. Depot)" maxlength="80"><input type="tel" placeholder="Telephone" maxlength="40">' +
      '<button class="mini del" type="button" aria-label="Delete contact">✕</button>';
    const [a, b] = el.querySelectorAll("input");
    a.value = c.label; b.value = c.tel;
    a.addEventListener("input", () => (c.label = a.value));
    b.addEventListener("input", () => (c.tel = b.value));
    el.querySelector("button").addEventListener("click", () => { draft.contacts.splice(i, 1); renderContacts(); });
    wrap.appendChild(el);
  });
}

/* ---- map preview ---- */
function initEditorMap() {
  if (edMap) { edMap.remove(); edMap = null; }
  edMap = L.map("edMap", { zoomControl: true, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([52.5, -2], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors", crossOrigin: true
  }).addTo(edMap);
  edTrack = null; edStops = L.layerGroup().addTo(edMap);
  edMap.on("click", (ev) => {
    if (!addingStop) return;
    draft.stops.push({ lat: Math.round(ev.latlng.lat * 1e5) / 1e5, lng: Math.round(ev.latlng.lng * 1e5) / 1e5, name: "Stop " + (draft.stops.length + 1) });
    stopsChanged();
  });
  const mine = edMap;
  setTimeout(() => { if (edMap !== mine) return; edMap.invalidateSize(); drawMap(true); }, 60);
}

function setAddingStop(on) {
  addingStop = on;
  $("addStopBtn").classList.toggle("on", on);
  $("addStopBtn").textContent = on ? "✔ Click the map to place a stop (tap to stop)" : "📍 Add stop on map";
  if (edMap) edMap.getContainer().style.cursor = on ? "crosshair" : "";
}

function drawMap(fit) {
  if (!edMap) return;
  if (edTrack) { edMap.removeLayer(edTrack); edTrack = null; }
  edStops.clearLayers();
  const style = getComputedStyle(document.documentElement);
  const routeCol = style.getPropertyValue("--route").trim() || "#0e8f7d";
  if (draft.track.length > 1) edTrack = L.polyline(draft.track, { color: routeCol, weight: 4, opacity: 0.9 }).addTo(edMap);
  else if (draft.stops.length > 1) edTrack = L.polyline(draft.stops.map((s) => [s.lat, s.lng]), { color: routeCol, weight: 3, dashArray: "6,8" }).addTo(edMap);
  draft.stops.forEach((s, i) => {
    const m = L.marker([s.lat, s.lng], {
      draggable: true,
      icon: L.divIcon({ className: "", html: '<div class="stop-marker"><span>' + (i + 1) + "</span></div>", iconSize: [24, 24], iconAnchor: [12, 12] })
    }).addTo(edStops);
    m.on("dragend", () => {
      const p = m.getLatLng();
      s.lat = Math.round(p.lat * 1e5) / 1e5; s.lng = Math.round(p.lng * 1e5) / 1e5;
    });
  });
  if (fit) {
    const pts = draft.track.length ? draft.track : draft.stops.map((s) => [s.lat, s.lng]);
    if (pts.length) edMap.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
  }
}

/* ---- save ---- */
async function saveDraft() {
  const d = draft;
  if (!d) return;
  try {
    if (!d.name.trim()) throw new Error("Please give the route a name.");
    if (!d.track.length && !d.stops.length) throw new Error("Upload a GPX file or add at least one stop on the map.");
    const toSave = { morning: [], afternoon: [] };
    for (const k of ["morning", "afternoon"]) {
      toSave[k] = d.timetable[k].filter((r) => (r.stop || "").trim() || (r.time || "").trim());
      for (const r of toSave[k]) {
        if (!(r.stop || "").trim()) throw new Error("Every " + k + " timetable row needs a stop name.");
        if (!/^\d{2}:\d{2}$/.test((r.time || "").trim())) throw new Error("Every " + k + " timetable row needs a time (HH:MM). Check “" + r.stop + "”.");
      }
    }
    const opEmail = String((d.operator && d.operator.email) || "").trim();
    if (opEmail && validateOperator({ name: "x", email: opEmail })) throw new Error("The operator email address doesn't look right.");
    $("edSave").disabled = true;
    const { data, fit } = buildDoc(Object.assign({}, d, { operatorCustom: d.operatorCustom && !opEmpty(d.operator), timetable: Object.assign({}, d.timetable, toSave) }));
    data.updatedAt = serverTimestamp();
    data.updatedBy = ctx.user.uid;
    checkSize(data);
    const ref = editingId ? doc(routesCol(), editingId) : doc(routesCol());
    await setDoc(ref, data);
    toast(fit.simplified ? "Saved (track simplified to " + fit.track.length.toLocaleString() + " points)." : "Route saved.");
    closeEditor();
  } catch (e) {
    console.warn("Save failed:", e && e.message);
    toast(friendlyError(e), true);
  }
  $("edSave").disabled = false;
}

/* service type options for the route editor: the company's enabled types (+ the route's own if no longer enabled) */
function serviceOptions(cur) {
  const enabled = normServiceTypes(ctx.company && ctx.company.serviceTypes);
  const keys = enabled.slice();
  if (cur && !keys.includes(cur) && SERVICE_KEYS.includes(cur)) keys.push(cur);
  return '<option value="">Not set – show for every service</option>' +
    keys.map((k) => '<option value="' + k + '">' + esc(serviceLabel(k)) + (enabled.includes(k) ? "" : " (not enabled for your company)") + "</option>").join("");
}

/* =============================================================== what the company operates (v8) */
let svcDirty = false;
function fillServiceForm() {
  setServicePick("opSvc", normServiceTypes(ctx && ctx.company && ctx.company.serviceTypes));   // no field yet = all four
  svcDirty = false;
}
async function saveServiceTypes() {
  const msg = $("opSvcMsg");
  msg.className = "form-msg"; msg.textContent = "";
  const types = pickedServiceTypes(readServicePick("opSvc"));
  if (!types) { msg.textContent = "Pick at least one (or All)."; return; }
  $("opSvcSave").disabled = true;
  try {
    await updateDoc(doc(ctx.db, "companies", ctx.companyId), { serviceTypes: types });
    ctx.company = Object.assign({}, ctx.company, { serviceTypes: types });
    svcDirty = false;
    msg.className = "form-msg ok";
    msg.textContent = "Saved: " + types.map(serviceLabel).join(", ") + ".";
  } catch (e) {
    console.warn("Save service types failed:", e && (e.code || e.message));
    msg.textContent = e && e.code === "permission-denied"
      ? "Not allowed by the live security rules yet – the updated firestore.rules (v8) need to be published in the Firebase console (see README)."
      : friendlyError(e);
  }
  $("opSvcSave").disabled = false;
}

/* =============================================================== company operator tab */
let opDirty = false;
const OP_FIELDS = [["name", "opName"], ["address", "opAddress"], ["tel", "opTel"], ["email", "opEmail"]];

function wireOperator() {
  OP_FIELDS.forEach(([, id]) => $(id).addEventListener("input", () => { opDirty = true; $("opMsg").textContent = ""; }));
  $("opForm").addEventListener("submit", saveCompanyOperator);
  wireServicePick("opSvc", () => { svcDirty = true; $("opSvcMsg").textContent = ""; });
  $("opSvcSave").addEventListener("click", saveServiceTypes);
  $("opApplyBtn").addEventListener("click", applyToAllRoutes);
  document.querySelectorAll('input[name="opApplyMode"]').forEach((r) => r.addEventListener("change", renderApplyInfo));
}

function fillOperatorForm() {
  const co = companyOp();
  OP_FIELDS.forEach(([k, id]) => { $(id).value = co[k] || ""; });
  opDirty = false;
}

function readOperatorForm() {
  const o = {};
  OP_FIELDS.forEach(([k, id]) => { o[k] = $(id).value; });
  return o;
}

async function saveCompanyOperator(ev) {
  ev.preventDefault();
  const msg = $("opMsg");
  msg.className = "form-msg"; msg.textContent = "";
  const raw = readOperatorForm();
  const err = validateOperator(raw);
  if (err) { msg.textContent = err; return; }
  const op = normOp(raw);
  $("opSave").disabled = true;
  try {
    await updateDoc(doc(ctx.db, "companies", ctx.companyId), { operator: op });
    ctx.company = Object.assign({}, ctx.company, { operator: op });
    opDirty = false;
    renderApplyInfo(true);
    msg.className = "form-msg ok";
    msg.textContent = "Operator details saved. New routes will use them from now on.";
  } catch (e) {
    console.warn("Save operator failed:", e && (e.code || e.message));
    msg.textContent = friendlyError(e);
  }
  $("opSave").disabled = false;
}

const applyMode = () => (document.querySelector('input[name="opApplyMode"]:checked') || {}).value || "fill";

/* explains what "Apply to all routes" would do right now (saved company details only) */
function renderApplyInfo(justSaved) {
  const info = $("opApplyInfo"), btn = $("opApplyBtn");
  if (!info) return;
  const co = companyOp();
  if (opEmpty(co)) {
    info.textContent = "Save the operator details above first; then you can apply them to the routes you already have.";
    btn.disabled = true; btn.textContent = "Apply to all routes"; return;
  }
  const mode = applyMode();
  const plan = planApply(rawRoutes, co, mode);
  const n = plan.targets.length;
  const parts = [];
  parts.push(plan.total + " route" + (plan.total === 1 ? "" : "s") + " in total");
  parts.push(n + " would be updated");
  if (mode !== "all" && plan.keptCustom) parts.push(plan.keptCustom + " custom kept as they are");
  if (plan.alreadyCurrent) parts.push(plan.alreadyCurrent + " already use the company details");
  info.textContent = (justSaved && n ? "Saved. " + n + " existing route" + (n === 1 ? " doesn't" : "s don't") + " use these details yet – apply them below if you want. " : "") + parts.join(" · ") + ".";
  btn.disabled = n === 0;
  btn.textContent = "Apply to all routes" + (n ? " (" + n + ")" : "");
}

async function applyToAllRoutes() {
  const msg = $("opApplyMsg");
  msg.className = "form-msg"; msg.textContent = "";
  if (opDirty) { msg.textContent = "You have unsaved changes above – save them first, then apply."; return; }
  const co = companyOp();
  if (opEmpty(co)) return;
  const mode = applyMode();
  const plan = planApply(rawRoutes, co, mode);
  if (!plan.targets.length) { msg.className = "form-msg ok"; msg.textContent = "Nothing to update – every route already uses the company details."; return; }
  const what = mode === "all"
    ? "OVERWRITE the operator details of " + plan.targets.length + " route(s) with the company operator details – including routes with their own custom details."
    : "Set the company operator details on " + plan.targets.length + " route(s) that have none or already use the company details. " + plan.keptCustom + " custom route(s) are left alone.";
  if (!confirm(what + "\n\nCompany operator: " + co.name + (co.tel ? " · " + co.tel : "") + "\n\nContinue?")) return;
  $("opApplyBtn").disabled = true;
  try {
    for (let i = 0; i < plan.targets.length; i += 400) {
      const batch = writeBatch(ctx.db);
      plan.targets.slice(i, i + 400).forEach((id) => {
        batch.update(doc(routesCol(), id), { operator: co, operatorCustom: false, updatedAt: serverTimestamp(), updatedBy: ctx.user.uid });
      });
      await batch.commit();
    }
    msg.className = "form-msg ok";
    msg.textContent = "Updated " + plan.targets.length + " route" + (plan.targets.length === 1 ? "" : "s") + ".";
    toast("Operator details applied to " + plan.targets.length + " route" + (plan.targets.length === 1 ? "" : "s") + ".");
  } catch (e) {
    console.warn("Apply operator failed:", e && (e.code || e.message));
    msg.textContent = "Could not update all routes: " + friendlyError(e) + " (some may already have been changed – check the route list.)";
  }
  renderApplyInfo();
}

/* =============================================================== drivers */
function subscribeUsers() {
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(
    query(collection(ctx.db, "users"), where("companyId", "==", ctx.companyId)),
    (snap) => renderUsers(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    (err) => toast("Could not load team: " + friendlyError(err), true)
  );
}

function renderUsers(users) {
  const wrap = $("driverList");
  const rank = (r) => (r === "admin" ? 0 : r === "maintenance" ? 2 : 1);
  users.sort((a, b) => (rank(a.role) - rank(b.role)) || String(a.name).localeCompare(String(b.name)));
  wrap.innerHTML = "";
  users.forEach((u) => {
    const el = document.createElement("div");
    el.className = "arow";
    el.dataset.uid = u.uid;
    const isMe = u.uid === ctx.user.uid;
    el.innerHTML = '<div class="route-meta"><div class="name">' + esc(u.name || u.email) + (isMe ? " (you)" : "") + "</div>" +
      '<div class="sub"><span class="pill ' + (u.role === "admin" ? "admin" : u.role === "maintenance" ? "maint" : "") + '">' + esc(u.role) + "</span>" + esc(u.email || "") + "</div></div>" +
      '<div class="arow-actions"></div>';
    const act = el.querySelector(".arow-actions");
    const reset = document.createElement("button");
    reset.className = "btn small"; reset.textContent = "Send password reset";
    reset.addEventListener("click", async () => {
      try { await sendPasswordResetEmail(ctx.auth, u.email); toast("Password-reset email sent to " + u.email + "."); }
      catch (e) { toast(friendlyError(e), true); }
    });
    act.appendChild(reset);
    if (!isMe && u.role !== "admin") {
      const rm = document.createElement("button");
      rm.className = "btn small danger"; rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        if (!confirm("Remove " + (u.name || u.email) + "?\n\nThey lose access to your company's routes straight away.")) return;
        try { await deleteDoc(doc(ctx.db, "users", u.uid)); toast("Removed " + (u.name || u.email) + "."); }
        catch (e) { toast(friendlyError(e), true); }
      });
      act.appendChild(rm);
    }
    wrap.appendChild(el);
  });
}

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ234679";
  const a = new Uint32Array(10); crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join("");
}

/* Create a driver login WITHOUT signing the admin out: Firebase's
   createUserWithEmailAndPassword always signs in the new user on whichever Auth
   instance it is called on, so we call it on a second, separate app instance. */
async function addDriver(ev) {
  ev.preventDefault();
  const msg = $("driverMsg");
  const name = $("dvName").value.trim(), email = $("dvEmail").value.trim(), pass = $("dvPass").value;
  const role = $("dvRole") && $("dvRole").value === "maintenance" ? "maintenance" : "driver";    // v18: maintenance login (vehicle defects only)
  msg.className = "form-msg"; msg.textContent = "";
  $("dvBtn").disabled = true;
  let sAuth = null, createdNow = false, cred = null;
  try {
    sAuth = await createSecondaryAuth();
    try {
      cred = await createUserWithEmailAndPassword(sAuth, email, pass);
      createdNow = true;
    } catch (e) {
      if (e.code !== "auth/email-already-in-use") throw e;
      // The login may already exist (e.g. a driver removed earlier and re-added): reuse it if the password matches.
      try { cred = await signInWithEmailAndPassword(sAuth, email, pass); }
      catch (e2) { throw new Error("That email already has a login. If this is someone you removed earlier, enter their existing password, or ask them to use “Forgot password?” – or use a different email."); }
    }
    try {
      await setDoc(doc(ctx.db, "users", cred.user.uid), {
        companyId: ctx.companyId, role, name, email, createdAt: serverTimestamp()
      });
    } catch (e) {
      if (createdNow) { try { await cred.user.delete(); } catch (e3) { /* ignore */ } }
      if (e.code === "permission-denied") throw new Error(role === "maintenance"
        ? "That login can't be added. If it is new, publish the updated Firestore rules first (they allow maintenance logins) – otherwise it already belongs to a team."
        : "That login can't be added – it already belongs to a team (maybe yours, maybe another company).");
      throw e;
    }
    msg.className = "form-msg ok";
    msg.innerHTML = (role === "maintenance" ? "Maintenance login created – they will only see vehicle defects. Give them these details:" : "Driver created. Give them these details:") +
      '<div class="cred-box">Email: <b>' + esc(email) + "</b><br>Password: <b>" + esc(pass) + "</b></div>";
    $("driverForm").reset();
  } catch (e) {
    console.warn("Add driver failed:", e && (e.code || e.message));
    msg.className = "form-msg"; msg.textContent = friendlyError(e);
  } finally {
    if (sAuth) { try { await signOut(sAuth); } catch (e) { /* ignore */ } }
    $("dvBtn").disabled = false;
  }
}

/* =============================================================== Vehicles tab (v9) */
function wireVehicles() {
  $("vehForm").addEventListener("submit", saveVehicle);
  $("vehCancel").addEventListener("click", resetVehForm);
  $("vehReg").addEventListener("input", () => { $("vehMsg").textContent = ""; });
}
function resetVehForm() {
  $("vehEditId").value = ""; $("vehFormTitle").textContent = "Add a vehicle";
  ["vehReg", "vehHeight", "vehLength", "vehWidth", "vehWeight"].forEach((id) => { $(id).value = ""; });
  $("vehCancel").style.display = "none"; $("vehMsg").textContent = ""; $("vehSave").textContent = "Save vehicle";
}
function fillVehForm(id) {
  const v = rawVehicles[id]; if (!v) return;
  $("vehEditId").value = id; $("vehFormTitle").textContent = "Edit vehicle";
  $("vehReg").value = v.reg || "";
  $("vehHeight").value = v.height != null ? v.height : "";
  $("vehLength").value = v.length != null ? v.length : "";
  $("vehWidth").value = v.width != null ? v.width : "";
  $("vehWeight").value = v.weight != null ? v.weight : "";
  $("vehCancel").style.display = ""; $("vehSave").textContent = "Save changes"; $("vehMsg").textContent = "";
  $("vehReg").focus();
}
function renderVehicleList() {
  const list = $("vehicleList"); if (!list) return;
  const ids = Object.keys(rawVehicles).sort((a, b) => String(rawVehicles[a].reg || "").localeCompare(String(rawVehicles[b].reg || "")));
  if (!ids.length) {
    list.innerHTML = '<div class="empty-note">No vehicles yet.<br>Add the registration (and height / length / width / weight) above – drivers will pick one on the welcome screen.</div>';
    return;
  }
  list.innerHTML = "";
  ids.forEach((id) => {
    const v = rawVehicles[id], el = document.createElement("div");
    el.className = "arow"; el.dataset.vehId = id;
    const dims = vehicleDims(v);
    el.innerHTML =
      '<div class="route-badge">🚌</div>' +
      '<div class="route-meta"><div class="name">' + esc(v.reg || "—") + "</div>" +
      '<div class="sub">' + (dims ? '<span class="veh-dims">' + esc(dims) + "</span>" : '<span class="muted">No dimensions set</span>') + "</div></div>" +
      '<div class="arow-actions"><button class="btn small" data-act="edit">Edit</button>' +
      '<button class="btn small danger" data-act="del">Delete</button></div>';
    el.querySelector('[data-act="edit"]').addEventListener("click", () => fillVehForm(id));
    el.querySelector('[data-act="del"]').addEventListener("click", () => deleteVehicle(id, v.reg));
    list.appendChild(el);
  });
}
async function saveVehicle(ev) {
  ev.preventDefault();
  const msg = $("vehMsg"); msg.className = "form-msg"; msg.textContent = "";
  const raw = { reg: $("vehReg").value, height: $("vehHeight").value, length: $("vehLength").value, width: $("vehWidth").value, weight: $("vehWeight").value };
  const err = validateVehicle(raw);
  if (err) { msg.textContent = err; return; }
  const data = cleanVehicle(raw);
  const editId = $("vehEditId").value;
  $("vehSave").disabled = true;
  try {
    if (editId) {
      data.updatedAt = serverTimestamp(); data.updatedBy = ctx.user.uid;
      await updateDoc(doc(ctx.db, "companies", ctx.companyId, "vehicles", editId), data);
      msg.className = "form-msg ok"; msg.textContent = "Vehicle “" + data.reg + "” updated.";
    } else {
      data.createdAt = serverTimestamp(); data.updatedAt = serverTimestamp(); data.updatedBy = ctx.user.uid;
      await setDoc(doc(collection(ctx.db, "companies", ctx.companyId, "vehicles")), data);
      msg.className = "form-msg ok"; msg.textContent = "Vehicle “" + data.reg + "” added.";
    }
    resetVehForm();
  } catch (e) {
    console.warn("Save vehicle failed:", e && (e.code || e.message));
    msg.textContent = e && e.code === "permission-denied"
      ? "Not allowed by the live security rules yet – publish the v9 firestore.rules (vehicles collection) in the Firebase console."
      : friendlyError(e);
  }
  $("vehSave").disabled = false;
}
async function deleteVehicle(id, reg) {
  if (!confirm("Delete vehicle “" + (reg || id) + "”? Drivers will no longer be able to pick it.")) return;
  try {
    await deleteDoc(doc(ctx.db, "companies", ctx.companyId, "vehicles", id));
    if ($("vehEditId").value === id) resetVehForm();
    toast("Vehicle deleted.");
  } catch (e) { toast(friendlyError(e), true); }
}
