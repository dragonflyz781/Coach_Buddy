/* v21: duty calendar, modelled on the paper "Driver Daily Worksheet".
     companies/{cid}/duties/{driverUid}_{YYYY-MM-DD} - see dutycore.js
   admin  - "Duties" tab: a week planner (drivers x days), the duty editor (duty no., vehicle, rows of time + description, each optionally
            linked to a route), copy to other dates / drivers, "copy last week", delete, print (worksheet layout).
   driver - "My duties": month calendar with dots, today's duty first, the worksheet for a day, "Start this run" on linked routes,
            badge for new / changed duties. */
import { doc, collection, setDoc, deleteDoc, onSnapshot, query, where, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { $, esc, toast, friendlyError } from "./ui.js?v=16";
import { dutyDay } from "./services.js?v=16";
import { dutyId, addDays, weekStart, dayName, ukDate, monthGrid, monthTitle, shiftMonth, checkDuty, buildDuty, copyDuty, lastWeekCopies,
  changedDuties, dutyStamp, worksheetHtml, isIsoDate } from "./dutycore.js?v=21";

const RULES_MSG = "Duties can’t be loaded yet – publish the updated Firestore rules (firestore-rules-paste-into-firebase.txt) in the Firebase console.";
const col = (c) => collection(c.db, "companies", c.companyId, "duties");
const TEMPLATE = [{ time: "", text: "Report for duty and carry out First Use Checks" }, { time: "", text: "Depart depot" },
  { time: "", text: "" }, { time: "", text: "Return to depot and carry out end of use Vehicle Defect Checks" }];
const short = (d) => dayName(d).slice(0, 3) + " " + ukDate(d).slice(0, 5);
const errMsg = (e) => (e && e.code === "permission-denied" ? RULES_MSG : friendlyError(e));

/* ================================================================ admin */
const A = { c: null, unsub: null, all: {}, team: [], week: null, ed: null, wired: false, err: "", getRoutes: () => ({}), getVehicles: () => ({}) };
export function initAdminDuties(c, getRoutes, getVehicles) {
  stopAdminDuties();
  A.c = c; A.getRoutes = getRoutes; A.getVehicles = getVehicles; A.all = {}; A.err = "";
  if (!A.week) A.week = weekStart(dutyDay());
  if (!A.wired) wireAdmin();
  // the planner shows a week at a time; keep about 3 months back (for "copy last week") and everything ahead
  A.unsub = onSnapshot(query(col(c), where("date", ">=", addDays(dutyDay(), -98))), (snap) => {
    A.err = ""; A.all = {}; snap.docs.forEach((d) => { A.all[d.id] = { id: d.id, ...d.data() }; }); renderWeek();
  }, (err) => { console.warn("Duties not readable:", err && err.code); A.err = errMsg(err); renderWeek(); });
  renderWeek();
}
export function stopAdminDuties() { if (A.unsub) A.unsub(); A.unsub = null; }
export function setDutyTeam(users) {
  A.team = (users || []).filter((u) => u.role === "driver" || u.role === "admin").map((u) => ({ uid: u.uid, name: u.name || u.email, role: u.role }))
    .sort((a, b) => ((a.role === "admin") - (b.role === "admin")) || String(a.name).localeCompare(String(b.name)));
  renderWeek(); if (A.ed) fillDriverSelect();
}
export function refreshDutyLists() { if (A.c) { renderWeek(); if (A.ed) { fillVehicleSelect(); refreshRouteSelects(); } } }
const routesList = () => Object.entries(A.getRoutes() || {}).map(([id, r]) => ({ id, name: (r && r.name) || id })).sort((a, b) => a.name.localeCompare(b.name));
const vehiclesList = () => Object.values(A.getVehicles() || {}).filter((v) => v && v.reg).sort((a, b) => String(a.reg).localeCompare(String(b.reg)));
const teamName = (uid) => (A.team.find((u) => u.uid === uid) || {}).name || "";

function wireAdmin() {
  A.wired = true;
  $("admDutiesBody").innerHTML =
    '<div class="card wide duty-week-card"><h2>Duties</h2><p class="muted">Each driver’s daily worksheet: duty number, vehicle and the times of the day. Tap a square to add or change a duty. Drivers see their own duties in the app (“My duties”).</p>' +
    '<div class="duty-weekbar"><button class="btn small" type="button" id="dwPrev" aria-label="Previous week">◀</button><input type="date" id="dwDate" aria-label="Week of"><button class="btn small" type="button" id="dwNext" aria-label="Next week">▶</button>' +
    '<span class="duty-wtitle" id="dwTitle"></span><button class="btn small" type="button" id="dwToday">This week</button><button class="btn small" type="button" id="dwCopyLast">⧉ Copy last week</button></div>' +
    '<div class="form-msg" id="dwMsg" role="status"></div><div class="duty-grid-wrap"><table class="duty-grid" id="dwGrid"></table></div></div>' +
    '<div class="card wide duty-editor" id="dutyEditor" style="display:none"></div>' +
    '<div id="dutyPrint" class="duty-print" aria-hidden="true"></div>';
  $("dwPrev").addEventListener("click", () => { A.week = addDays(A.week, -7); renderWeek(); });
  $("dwNext").addEventListener("click", () => { A.week = addDays(A.week, 7); renderWeek(); });
  $("dwToday").addEventListener("click", () => { A.week = weekStart(dutyDay()); renderWeek(); });
  $("dwDate").addEventListener("change", (e) => { if (isIsoDate(e.target.value)) { A.week = weekStart(e.target.value); renderWeek(); } });
  $("dwCopyLast").addEventListener("click", copyLastWeek);
  $("dwGrid").addEventListener("click", (e) => { const b = e.target.closest("[data-cell]"); if (b) { const [uid, date] = b.dataset.cell.split("|"); openEditor(uid, date); } });
}
function renderWeek() {
  if (!A.c || !A.wired) return;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(A.week, i)), today = dutyDay();
  $("dwDate").value = A.week;
  $("dwTitle").textContent = "Week of " + ukDate(A.week);
  if (A.err) { $("dwMsg").textContent = A.err; }
  const g = $("dwGrid");
  if (!A.team.length) { g.innerHTML = '<tr><td class="muted">Add drivers on the Drivers tab first.</td></tr>'; return; }
  g.innerHTML = "<thead><tr><th>Driver</th>" + days.map((d) => '<th class="' + (d === today ? "today" : "") + '">' + esc(short(d)) + "</th>").join("") + "</tr></thead><tbody>" +
    A.team.map((u) => "<tr><th>" + esc(u.name) + "</th>" + days.map((d) => {
      const x = A.all[dutyId(u.uid, d)];
      return '<td><button type="button" class="duty-cell' + (x ? " has" : "") + (d === today ? " today" : "") + '" data-cell="' + esc(u.uid + "|" + d) + '" aria-label="' +
        esc(u.name + ", " + dayName(d) + " " + ukDate(d) + (x ? ", duty " + x.dutyNo : ", no duty")) + '">' + (x ? '<b>' + esc(x.dutyNo) + "</b>" + (x.vehicleReg ? "<small>" + esc(x.vehicleReg) + "</small>" : "") : "+") + "</button></td>";
    }).join("") + "</tr>").join("") + "</tbody>";
}
async function copyLastWeek() {
  const list = Object.values(A.all), copies = lastWeekCopies(list, A.week), m = $("dwMsg");
  const prevHas = list.some((d) => d.date >= addDays(A.week, -7) && d.date < A.week);
  if (!copies.length) { m.textContent = prevHas ? "Every duty of last week is already in this week – nothing to copy." : "There are no duties in the week of " + ukDate(addDays(A.week, -7)) + " to copy."; return; }
  if (!confirm("Copy " + copies.length + " dut" + (copies.length === 1 ? "y" : "ies") + " from the week of " + ukDate(addDays(A.week, -7)) + " into this week? Days that already have a duty are left alone.")) return;
  m.textContent = "Copying…";
  const res = await Promise.allSettled(copies.map((cp) => write(copyDuty(cp.src, { date: cp.date }))));
  const bad = res.filter((r) => r.status === "rejected");
  m.textContent = (copies.length - bad.length) + " copied" + (bad.length ? ", " + bad.length + " failed: " + errMsg(bad[0].reason) : " ✔");
}
const write = (d) => setDoc(doc(col(A.c), dutyId(d.driverUid, d.date)), { ...d, updatedAt: serverTimestamp(), updatedBy: A.c.user.uid });

function openEditor(uid, date) {
  const ex = A.all[dutyId(uid, date)];
  A.ed = { uid, date, existing: !!ex };
  const e = $("dutyEditor");
  e.style.display = "";
  e.innerHTML = '<div class="duty-ed-head"><h2 id="deTitle"></h2><button class="icon-btn" type="button" id="deClose" aria-label="Close">✕</button></div>' +
    '<div class="duty-ed-top"><label>Date<input type="date" id="deDate"></label><label>Driver<select id="deDriver"></select></label>' +
    '<label>Duty no.<input id="deNo" maxlength="20" inputmode="text" placeholder="e.g. 8"></label><label>Vehicle<select id="deVeh"></select></label></div>' +
    '<div class="duty-rows-head"><span>Time</span><span>Description</span><span>Route (optional)</span><span></span></div><div id="deRows" class="duty-rows"></div>' +
    '<div class="duty-ed-btns"><button class="btn small" type="button" id="deAdd">+ Add row</button><button class="btn small" type="button" id="deTpl">Use worksheet template</button></div>' +
    '<label class="duty-note">Note (optional)<textarea id="deNote" rows="2" maxlength="500"></textarea></label>' +
    '<div class="form-msg" id="deMsg" role="status"></div>' +
    '<div class="duty-ed-actions"><button class="btn primary" type="button" id="deSave">Save duty</button><button class="btn" type="button" id="dePrint">🖨 Print</button>' +
    '<button class="btn" type="button" id="deCopyBtn">⧉ Copy to…</button><button class="btn danger" type="button" id="deDel">Delete</button></div>' +
    '<div class="duty-copy" id="deCopy" style="display:none"><h3>Copy this duty</h3><p class="muted">To these dates (pick a date and tap Add, or a quick choice), for these drivers. Days that already have a duty are skipped.</p>' +
    '<div class="duty-copy-dates"><input type="date" id="dcDate" aria-label="Copy to date"><button class="btn small" type="button" id="dcAdd">Add</button>' +
    '<button class="btn small" type="button" id="dcRest">Rest of this week (Mon–Fri)</button><button class="btn small" type="button" id="dcNextWk">Same day next week</button></div>' +
    '<div class="duty-chips" id="dcChips"></div><div class="duty-copy-drivers" id="dcDrivers"></div>' +
    '<button class="btn primary" type="button" id="dcGo">Copy</button><div class="form-msg" id="dcMsg" role="status"></div></div>';
  const src = ex || { date, driverUid: uid, dutyNo: "", rows: TEMPLATE.map((r) => ({ ...r })) };
  $("deDate").value = date; $("deNo").value = src.dutyNo || ""; $("deNote").value = src.note || "";
  fillDriverSelect(); fillVehicleSelect(src.vehicleId || "");
  $("deRows").innerHTML = ""; (src.rows || []).forEach(addRow); if (!(src.rows || []).length) addRow();
  setTitle();
  $("deDel").style.display = ex ? "" : "none"; $("deCopyBtn").style.display = ex ? "" : "none"; $("dePrint").style.display = ex ? "" : "none";
  A.copyDates = [];
  $("deClose").addEventListener("click", closeEditor);
  $("deAdd").addEventListener("click", () => { addRow({ time: "", text: "" }); const ins = $("deRows").querySelectorAll(".de-time"); ins[ins.length - 1].focus(); });
  $("deTpl").addEventListener("click", () => { if ($("deRows").children.length && !confirm("Replace the rows with the worksheet template?")) return; $("deRows").innerHTML = ""; TEMPLATE.forEach(addRow); });
  $("deRows").addEventListener("click", (ev) => { const b = ev.target.closest(".de-del"); if (b) b.closest(".duty-row").remove(); });
  $("deRows").addEventListener("change", (ev) => {     // linking a route fills an empty description with its name
    const s = ev.target.closest(".de-route"); if (!s || !s.value) return;
    const t = s.closest(".duty-row").querySelector(".de-text"); if (!t.value.trim()) t.value = s.options[s.selectedIndex].text;
  });
  $("deSave").addEventListener("click", saveDuty);
  $("deDel").addEventListener("click", deleteDuty);
  $("dePrint").addEventListener("click", () => printDuty(A.all[dutyId(A.ed.uid, A.ed.date)]));
  $("deCopyBtn").addEventListener("click", () => { const c = $("deCopy"); c.style.display = c.style.display === "none" ? "" : "none"; renderCopy(); });
  $("dcAdd").addEventListener("click", () => { const v = $("dcDate").value; if (isIsoDate(v)) addCopyDate(v); });
  $("dcRest").addEventListener("click", () => { const ws = weekStart(A.ed.date); for (let i = 0; i < 5; i++) { const d = addDays(ws, i); if (d > A.ed.date) addCopyDate(d); } });
  $("dcNextWk").addEventListener("click", () => addCopyDate(addDays(A.ed.date, 7)));
  $("dcChips").addEventListener("click", (ev) => { const b = ev.target.closest("[data-rm]"); if (b) { A.copyDates = A.copyDates.filter((d) => d !== b.dataset.rm); renderCopy(); } });
  $("dcGo").addEventListener("click", doCopy);
  e.scrollIntoView({ behavior: "smooth", block: "start" });
  $("deNo").focus({ preventScroll: true });
}
function setTitle() { if (!A.ed) return; $("deTitle").textContent = (A.ed.existing ? "Duty – " : "New duty – ") + (teamName(A.ed.uid) || "Driver") + ", " + dayName(A.ed.date) + " " + ukDate(A.ed.date); }
function closeEditor() { A.ed = null; const e = $("dutyEditor"); e.style.display = "none"; e.innerHTML = ""; }
function fillDriverSelect() {
  const s = $("deDriver"); if (!s) return;
  s.innerHTML = A.team.map((u) => '<option value="' + esc(u.uid) + '">' + esc(u.name) + (u.role === "admin" ? " (admin)" : "") + "</option>").join("");
  s.value = A.ed.uid;
}
function fillVehicleSelect(keep) {
  const s = $("deVeh"); if (!s) return;
  const cur = keep !== undefined ? keep : s.value;
  s.innerHTML = '<option value="">– none –</option>' + vehiclesList().map((v) => '<option value="' + esc(v.id) + '">' + esc(v.reg) + "</option>").join("");
  s.value = cur && vehiclesList().some((v) => v.id === cur) ? cur : "";
}
const routeOptions = (sel) => '<option value="">– no route –</option>' + routesList().map((r) => '<option value="' + esc(r.id) + '"' + (r.id === sel ? " selected" : "") + ">" + esc(r.name) + "</option>").join("") +
  (sel && !routesList().some((r) => r.id === sel) ? '<option value="' + esc(sel) + '" selected>(deleted route)</option>' : "");
function refreshRouteSelects() { document.querySelectorAll("#deRows .de-route").forEach((s) => { const v = s.value; s.innerHTML = routeOptions(v); s.value = v; }); }
function addRow(r) {
  const row = document.createElement("div");
  row.className = "duty-row";
  row.innerHTML = '<input class="de-time" inputmode="numeric" maxlength="5" placeholder="hhmm" aria-label="Time (hhmm)" value="' + esc((r && r.time) || "") + '">' +
    '<input class="de-text" maxlength="200" placeholder="Description" aria-label="Description" value="' + esc((r && r.text) || "") + '">' +
    '<select class="de-route" aria-label="Linked route">' + routeOptions(r && r.routeId) + "</select>" +
    '<button class="mini del de-del" type="button" aria-label="Remove row">✕</button>';
  $("deRows").appendChild(row);
}
function readForm() {
  const veh = $("deVeh").value, v = vehiclesList().find((x) => x.id === veh);
  return { date: $("deDate").value, driverUid: $("deDriver").value, driverName: teamName($("deDriver").value), dutyNo: $("deNo").value,
    vehicleId: veh || "", vehicleReg: v ? String(v.reg).slice(0, 20) : "", note: $("deNote").value,
    rows: [...document.querySelectorAll("#deRows .duty-row")].map((r) => ({ time: r.querySelector(".de-time").value, text: r.querySelector(".de-text").value, routeId: r.querySelector(".de-route").value })) };
}
async function saveDuty() {
  const f = readForm(), chk = checkDuty(f), m = $("deMsg");
  if (!chk.ok) { m.textContent = chk.errors.join(" "); return; }
  const moved = f.driverUid !== A.ed.uid || f.date !== A.ed.date, target = A.all[dutyId(f.driverUid, f.date)];
  if (moved && target && !confirm(teamName(f.driverUid) + " already has duty " + target.dutyNo + " on " + ukDate(f.date) + ". Replace it?")) return;
  $("deSave").disabled = true; m.textContent = "Saving…";
  try {
    await write(buildDuty({ ...f, rows: chk.rows }));
    if (moved && A.ed.existing) await deleteDoc(doc(col(A.c), dutyId(A.ed.uid, A.ed.date)));
    toast("Duty saved ✔");
    A.ed = { uid: f.driverUid, date: f.date, existing: true };
    m.textContent = "Saved ✔"; setTitle();
    $("deDel").style.display = ""; $("deCopyBtn").style.display = ""; $("dePrint").style.display = "";
    if (weekStart(f.date) !== A.week) { A.week = weekStart(f.date); renderWeek(); }
  } catch (e) { m.textContent = errMsg(e); }
  $("deSave").disabled = false;
}
async function deleteDuty() {
  if (!A.ed || !confirm("Delete this duty? The driver will no longer see it.")) return;
  try { await deleteDoc(doc(col(A.c), dutyId(A.ed.uid, A.ed.date))); toast("Duty deleted."); closeEditor(); }
  catch (e) { $("deMsg").textContent = errMsg(e); }
}
function addCopyDate(d) { if (!A.copyDates.includes(d)) A.copyDates.push(d); A.copyDates.sort(); renderCopy(); }
function renderCopy() {
  const keep = new Set([...document.querySelectorAll("#dcDrivers input:checked")].map((i) => i.value));
  if (!keep.size && A.ed) keep.add(A.ed.uid);
  $("dcChips").innerHTML = A.copyDates.length ? A.copyDates.map((d) => '<span class="duty-chip">' + esc(short(d) + "/" + d.slice(0, 4)) + ' <button type="button" class="mini" data-rm="' + d + '" aria-label="Remove ' + esc(ukDate(d)) + '">✕</button></span>').join("") : '<span class="muted">No dates yet – the same date is used for other drivers.</span>';
  $("dcDrivers").innerHTML = A.team.map((u) => '<label class="duty-chk"><input type="checkbox" value="' + esc(u.uid) + '"' + (keep.has(u.uid) ? " checked" : "") + "> " + esc(u.name) + "</label>").join("");
}
async function doCopy() {
  const src = A.all[dutyId(A.ed.uid, A.ed.date)], m = $("dcMsg");
  if (!src) { m.textContent = "Save the duty first."; return; }
  const drivers = [...document.querySelectorAll("#dcDrivers input:checked")].map((i) => i.value), dates = A.copyDates.length ? A.copyDates : [src.date];
  const targets = [];
  dates.forEach((date) => drivers.forEach((uid) => { if (!(uid === src.driverUid && date === src.date)) targets.push({ date, driverUid: uid, driverName: teamName(uid) }); }));
  if (!targets.length) { m.textContent = "Pick at least one other date or driver."; return; }
  const todo = targets.filter((t) => !A.all[dutyId(t.driverUid, t.date)]), skipped = targets.length - todo.length;
  m.textContent = "Copying…";
  const res = await Promise.allSettled(todo.map((t) => write(copyDuty(src, t))));
  const bad = res.filter((r) => r.status === "rejected");
  m.textContent = (todo.length - bad.length) + " copied" + (skipped ? ", " + skipped + " skipped (already had a duty)" : "") + (bad.length ? ", " + bad.length + " failed: " + errMsg(bad[0].reason) : " ✔");
}
function printDuty(d) {
  if (!d) return;
  const p = $("dutyPrint"), routes = A.getRoutes() || {};
  p.innerHTML = worksheetHtml(d, { routes, minRows: 14, company: A.c.company && A.c.company.name });
  document.body.classList.add("printing-duty");
  const done = () => { document.body.classList.remove("printing-duty"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  setTimeout(() => { try { window.print(); } catch (e) { /* ignore */ } setTimeout(done, 500); }, 50);
}

/* ================================================================ driver: My duties */
const D = { c: null, unsub: null, list: [], ready: null, readyRes: null, wired: false, err: "", open: false, ym: null, day: null };
const seenKey = () => "rt_duty_seen_" + D.c.companyId + "_" + D.c.user.uid;
const getSeen = () => { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}") || {}; } catch (e) { return {}; } };
const markSeen = (d) => { if (!d) return; const s = getSeen(); s[d.id] = dutyStamp(d) || Date.now(); try { localStorage.setItem(seenKey(), JSON.stringify(s)); } catch (e) { /* ignore */ } };
export function initDriverDuties(c) {
  // c: { db, user, profile, companyId, getRoutes, startRun(routeId, duty) }
  stopDriverDuties();
  D.c = c; D.list = []; D.err = "";
  D.ready = new Promise((res) => { D.readyRes = res; });
  if (!D.wired) wireDriver();
  ["dutyBtn", "acctDuties"].forEach((id) => { const b = $(id); if (b) b.style.display = ""; });
  D.unsub = onSnapshot(query(col(c), where("driverUid", "==", c.user.uid)), (snap) => {
    D.err = ""; D.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.date.localeCompare(b.date));
    if (D.readyRes) { D.readyRes(); D.readyRes = null; }
    renderDriver();
  }, (err) => {
    console.warn("Duties not readable:", err && err.code); D.err = errMsg(err);
    if (D.readyRes) { D.readyRes(); D.readyRes = null; }
    renderDriver();
  });
}
export function stopDriverDuties() {
  if (D.unsub) D.unsub(); D.unsub = null;
  if (D.readyRes) { D.readyRes(); D.readyRes = null; }
  if (D.open) closeDuties();
  D.c = null; D.list = [];
  ["dutyBtn", "acctDuties"].forEach((id) => { const b = $(id); if (b) b.style.display = "none"; });
}
/* today's duty (for pre-filling the welcome screen), waiting at most ms for the first snapshot */
export async function todayDuty(ms) {
  if (!D.c) return null;
  if (D.ready) await Promise.race([D.ready, new Promise((r) => setTimeout(r, ms || 0))]);
  const t = dutyDay();
  return D.list.find((d) => d.date === t) || null;
}
function wireDriver() {
  D.wired = true;
  $("dutyBtn").addEventListener("click", () => openDuties());
  $("acctDuties").addEventListener("click", () => { $("scrim").click(); openDuties(); });
}
function renderDriver() {
  if (!D.c) return;
  const n = changedDuties(D.list, getSeen(), dutyDay()).length;
  ["dutyBadge", "acctDutiesBadge"].forEach((id) => { const el = $(id); if (el) { el.textContent = n > 9 ? "9+" : String(n || ""); el.hidden = !n; el.style.display = n ? "" : "none"; } });
  if (D.open) { if (D.day) renderDay(); else renderCalendar(); }
}
export function openDuties(date) {
  if (!D.c) return;
  D.open = true;
  const t = dutyDay();
  D.ym = [+(date || t).slice(0, 4), +(date || t).slice(5, 7)]; D.day = date || null;
  const ov = $("mcOverlay"); ov.dataset.owner = "duties";
  $("mcSheet").innerHTML = '<div class="mc-head"><button class="btn small" type="button" id="dtBack" style="display:none">◀ Calendar</button><h2 id="mcTitle">📅 My duties</h2><button class="icon-btn" id="dtClose" type="button" aria-label="Close">✕</button></div><div id="dtBody"></div>';
  ov.setAttribute("aria-labelledby", "mcTitle");
  ov.style.display = "flex";
  $("dtClose").addEventListener("click", closeDuties);
  $("dtBack").addEventListener("click", () => { D.day = null; renderCalendar(); });
  $("dtBody").addEventListener("click", (e) => {
    const s = e.target.closest(".ws-start");
    if (s) { const d = D.list.find((x) => x.date === D.day); closeDuties(); D.c.startRun(s.dataset.route, d); return; }
    const c = e.target.closest("[data-day]");
    if (c) { D.day = c.dataset.day; renderDay(); return; }
    const mv = e.target.closest("[data-month]");
    if (mv) { D.ym = shiftMonth(D.ym[0], D.ym[1], +mv.dataset.month); renderCalendar(); }
  });
  D.day ? renderDay() : renderCalendar();
}
export function closeDuties() {
  D.open = false; D.day = null;
  const ov = $("mcOverlay");
  if (ov && ov.dataset.owner === "duties") { ov.style.display = "none"; $("mcSheet").innerHTML = ""; ov.dataset.owner = ""; }
  renderDriver();
}
function renderCalendar() {
  const b = $("dtBody"); if (!b) return;
  $("dtBack").style.display = "none"; $("mcTitle").textContent = "📅 My duties";
  const t = dutyDay(), byDate = {}, changed = new Set(changedDuties(D.list, getSeen(), t).map((d) => d.id));
  D.list.forEach((d) => { byDate[d.date] = d; });
  const td = byDate[t], next = D.list.find((d) => d.date > t);
  const [y, m] = D.ym;
  b.innerHTML = (D.err ? '<div class="form-msg">' + esc(D.err) + "</div>" : "") +
    '<div class="dt-today' + (td ? "" : " none") + '">' + (td
      ? '<button type="button" class="dt-today-btn" data-day="' + td.date + '"><span class="dt-k">TODAY · ' + esc(dayName(t) + " " + ukDate(t)) + '</span><span class="dt-v">Duty ' + esc(td.dutyNo) + (td.vehicleReg ? " · " + esc(td.vehicleReg) : "") +
        (changed.has(td.id) ? ' <span class="dt-new">NEW</span>' : "") + '</span><span class="dt-first">' + esc(((td.rows || [])[0] || {}).time ? td.rows[0].time + " " + td.rows[0].text : (td.rows || [])[0] ? td.rows[0].text : "") + "</span><span class=\"dt-open\">Open worksheet ›</span></button>"
      : '<div class="dt-k">TODAY · ' + esc(dayName(t) + " " + ukDate(t)) + '</div><div class="muted">No duty for today' + (next ? " – next: " + esc(dayName(next.date) + " " + ukDate(next.date)) + ", duty " + esc(next.dutyNo) : "") + ".</div>") + "</div>" +
    '<div class="dt-month"><button class="btn small" type="button" data-month="-1" aria-label="Previous month">◀</button><b id="dtMonth">' + esc(monthTitle(y, m)) + '</b><button class="btn small" type="button" data-month="1" aria-label="Next month">▶</button></div>' +
    '<table class="dt-cal" id="dtCal"><thead><tr>' + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => "<th>" + x + "</th>").join("") + "</tr></thead><tbody>" +
    monthGrid(y, m).map((w) => "<tr>" + w.map((c) => {
      const d = byDate[c.date], cls = ["dt-d", c.inMonth ? "" : "out", c.date === t ? "today" : "", d ? "has" : "", d && changed.has(d.id) ? "new" : ""].filter(Boolean).join(" ");
      return '<td><button type="button" class="' + cls + '" data-day="' + c.date + '" aria-label="' + esc(dayName(c.date) + " " + ukDate(c.date) + (d ? ", duty " + d.dutyNo : ", no duty")) + '"><span>' + (+c.date.slice(8)) + "</span>" +
        (d ? '<i class="dt-dot"></i><small>' + esc(d.dutyNo) + "</small>" : "") + "</button></td>";
    }).join("") + "</tr>").join("") + "</tbody></table>" +
    '<p class="muted dt-hint">A dot = a duty. Tap a day to see the worksheet.</p>';
}
function renderDay() {
  const b = $("dtBody"); if (!b) return;
  const d = D.list.find((x) => x.date === D.day);
  $("dtBack").style.display = ""; $("mcTitle").textContent = dayName(D.day) + " " + ukDate(D.day);
  if (!d) { b.innerHTML = '<p class="muted dt-none">No duty on ' + esc(dayName(D.day) + " " + ukDate(D.day)) + ".</p>"; return; }
  const routes = D.c.getRoutes() || {}, isToday = D.day === dutyDay();
  b.innerHTML = worksheetHtml(d, { routes, startButtons: isToday }) +
    (!isToday && (d.rows || []).some((r) => r.routeId) ? '<p class="muted dt-hint">“Start this run” buttons appear on the day of the duty.</p>' : "");
  markSeen(d);
  const n = changedDuties(D.list, getSeen(), dutyDay()).length;
  ["dutyBadge", "acctDutiesBadge"].forEach((id) => { const el = $(id); if (el) { el.textContent = n ? String(n) : ""; el.hidden = !n; el.style.display = n ? "" : "none"; } });
}
