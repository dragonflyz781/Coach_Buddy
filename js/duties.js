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
  changedDuties, dutyStamp, worksheetHtml, isIsoDate,
  routeGroups, findGroup, routeLabel, checkTemplate, buildTemplate, dutyFromTemplate, differsFromTemplate, assignDates, dayBoard } from "./dutycore.js?v=22";

const RULES_MSG = "Duties can’t be loaded yet – publish the updated Firestore rules (firestore-rules-paste-into-firebase.txt) in the Firebase console.";
const col = (c) => collection(c.db, "companies", c.companyId, "duties");
const tcol = (c) => collection(c.db, "companies", c.companyId, "dutyTemplates");     // v22: the duty list
const TEMPLATE = [{ time: "", text: "Report for duty and carry out First Use Checks" }, { time: "", text: "Depart depot" },
  { time: "", text: "" }, { time: "", text: "Return to depot and carry out end of use Vehicle Defect Checks" }];
const short = (d) => dayName(d).slice(0, 3) + " " + ukDate(d).slice(0, 5);
const errMsg = (e) => (e && e.code === "permission-denied" ? RULES_MSG : friendlyError(e));

/* ================================================================ admin */
const A = { c: null, unsub: null, tunsub: null, tpls: {}, te: null, boardDate: null, all: {}, team: [], week: null, ed: null, wired: false, err: "", getRoutes: () => ({}), getVehicles: () => ({}) };
export function initAdminDuties(c, getRoutes, getVehicles) {
  stopAdminDuties();
  A.c = c; A.getRoutes = getRoutes; A.getVehicles = getVehicles; A.all = {}; A.err = "";
  if (!A.week) A.week = weekStart(dutyDay());
  if (!A.wired) wireAdmin();
  // the planner shows a week at a time; keep about 3 months back (for "copy last week") and everything ahead
  A.unsub = onSnapshot(query(col(c), where("date", ">=", addDays(dutyDay(), -98))), (snap) => {
    A.err = ""; A.all = {}; snap.docs.forEach((d) => { A.all[d.id] = { id: d.id, ...d.data() }; }); renderWeek(); renderBoard(); if (A.ed) renderTplBar();
  }, (err) => { console.warn("Duties not readable:", err && err.code); A.err = errMsg(err); renderWeek(); });
  A.tpls = {};
  A.tunsub = onSnapshot(tcol(c), (snap) => {
    A.tpls = {}; snap.docs.forEach((d) => { A.tpls[d.id] = { id: d.id, ...d.data() }; }); renderTpls(); renderBoard();
  }, (err) => { console.warn("Duty list not readable:", err && err.code); $("tlMsg").textContent = errMsg(err); });
  renderWeek();
}
export function stopAdminDuties() { if (A.unsub) A.unsub(); if (A.tunsub) A.tunsub(); A.unsub = null; A.tunsub = null; }
export function setDutyTeam(users) {
  A.team = (users || []).filter((u) => u.role === "driver" || u.role === "admin").map((u) => ({ uid: u.uid, name: u.name || u.email, role: u.role }))
    .sort((a, b) => ((a.role === "admin") - (b.role === "admin")) || String(a.name).localeCompare(String(b.name)));
  renderWeek(); renderBoard(); if (A.ed) fillDriverSelect();
}
export function refreshDutyLists() { if (A.c) { renderWeek(); renderTpls(); renderBoard(); refreshRouteSelects(); if (A.ed) fillVehicleSelect(); if (A.te) fillVehicleSelect(undefined, "teVeh"); } }
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
    // v22: day board (assign the duty list to drivers for a date) + the duty list (templates)
    '<div class="card wide duty-board-card"><h2>Day board</h2><p class="muted">One line per duty on the duty list. Pick a driver to give them that duty for the day – it is copied, so you can change that day without changing the duty list.</p>' +
    '<div class="duty-weekbar"><button class="btn small" type="button" id="dbPrev" aria-label="Previous day">◀</button><input type="date" id="dbDate" aria-label="Day"><button class="btn small" type="button" id="dbNext" aria-label="Next day">▶</button><span class="duty-wtitle" id="dbTitle"></span></div>' +
    '<div class="form-msg" id="dbMsg" role="status"></div><div class="duty-grid-wrap"><table class="duty-board" id="dbTable"></table></div>' +
    '<details class="duty-range" id="drBox"><summary>Assign a duty to several days</summary><div class="duty-range-body">' +
    '<label>Duty<select id="drTpl"></select></label><label>Driver<select id="drDriver"></select></label><label>From<input type="date" id="drFrom"></label><label>To<input type="date" id="drTo"></label>' +
    '<div class="duty-wd" id="drDays" role="group" aria-label="Weekdays">' + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((n, i) => '<label class="duty-chk"><input type="checkbox" value="' + i + '"' + (i < 5 ? " checked" : "") + "> " + n + "</label>").join("") + "</div>" +
    '<button class="btn primary" type="button" id="drGo">Assign</button><div class="form-msg" id="drMsg" role="status"></div></div></details></div>' +
    '<div class="card wide duty-list-card"><div class="duty-ed-head"><h2>Duty list</h2><button class="btn small primary" type="button" id="tlNew">+ New duty</button></div><p class="muted">Your regular duties, set up once: duty number / name, usual vehicle and the times of the day. Use the Day board to give them to drivers.</p>' +
    '<div class="form-msg" id="tlMsg" role="status"></div><div id="tlList" class="duty-tlist"></div><div id="tplEditor" class="duty-editor" style="display:none"></div></div>' +
    '<div id="dutyPrint" class="duty-print" aria-hidden="true"></div>';
  $("dwPrev").addEventListener("click", () => { A.week = addDays(A.week, -7); renderWeek(); });
  $("dwNext").addEventListener("click", () => { A.week = addDays(A.week, 7); renderWeek(); });
  $("dwToday").addEventListener("click", () => { A.week = weekStart(dutyDay()); renderWeek(); });
  $("dwDate").addEventListener("change", (e) => { if (isIsoDate(e.target.value)) { A.week = weekStart(e.target.value); renderWeek(); } });
  $("dwCopyLast").addEventListener("click", copyLastWeek);
  A.boardDate = A.boardDate || dutyDay();
  $("dbPrev").addEventListener("click", () => { A.boardDate = addDays(A.boardDate, -1); renderBoard(); });
  $("dbNext").addEventListener("click", () => { A.boardDate = addDays(A.boardDate, 1); renderBoard(); });
  $("dbDate").addEventListener("change", (e) => { if (isIsoDate(e.target.value)) { A.boardDate = e.target.value; renderBoard(); } });
  $("dbTable").addEventListener("change", (e) => { const s = e.target.closest("[data-assign]"); if (s) assignFromBoard(s.dataset.assign, s.dataset.cur || "", s.value, s); });
  $("dbTable").addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) { const [u, d] = b.dataset.open.split("|"); openEditor(u, d); } });
  $("drGo").addEventListener("click", assignRange);
  $("tlNew").addEventListener("click", () => openTplEditor(null));
  $("tlList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tedit]"); if (b) openTplEditor(b.dataset.tedit);
    const d = e.target.closest("[data-tdel]"); if (d) deleteTpl(d.dataset.tdel);
  });
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
        esc(u.name + ", " + dayName(d) + " " + ukDate(d) + (x ? ", duty " + x.dutyNo : ", no duty")) + '">' + (x ? '<b>' + esc(x.dutyNo) + "</b>" + (x.vehicleReg ? "<small>" + esc(x.vehicleReg) + "</small>" : "") + (x.edited ? '<i class="duty-ed-mark" title="Edited for this day">✎</i>' : "") : "+") + "</button></td>";
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
    '<div class="duty-tpl-bar" id="deTplBar" style="display:none"></div>' +
    '<div class="duty-ed-top"><label>Date<input type="date" id="deDate"></label><label>Driver<select id="deDriver"></select></label>' +
    '<label>Duty no.<input id="deNo" maxlength="20" inputmode="text" placeholder="e.g. 8"></label><label>Vehicle<select id="deVeh"></select></label></div>' +
    '<div class="duty-rows-head"><span></span><span>Time</span><span>Description</span><span>Route (optional)</span><span></span></div><div id="deRows" class="duty-rows"></div>' +
    '<div class="duty-ed-btns"><button class="btn small" type="button" id="deAdd">+ Add row</button><button class="btn small" type="button" id="deTpl">Blank worksheet layout</button></div>' +
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
  setTitle(); renderTplBar();
  $("deDel").style.display = ex ? "" : "none"; $("deCopyBtn").style.display = ex ? "" : "none"; $("dePrint").style.display = ex ? "" : "none";
  A.copyDates = [];
  $("deClose").addEventListener("click", closeEditor);
  $("deAdd").addEventListener("click", () => { addRow({ time: "", text: "" }); const ins = $("deRows").querySelectorAll(".de-time"); ins[ins.length - 1].focus(); });
  $("deTpl").addEventListener("click", () => { if ($("deRows").children.length && !confirm("Replace the rows with the blank worksheet layout?")) return; $("deRows").innerHTML = ""; TEMPLATE.forEach(addRow); });
  wireRows($("deRows"));
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
/* v22: a duty made from the duty list: which template, 'edited for this day', reset to template */
function renderTplBar() {
  const b = $("deTplBar"); if (!b || !A.ed) return;
  const d = A.all[dutyId(A.ed.uid, A.ed.date)], t = d && d.templateId ? A.tpls[d.templateId] : null;
  if (!d || !d.templateId) { b.style.display = "none"; b.innerHTML = ""; return; }
  b.style.display = "";
  b.innerHTML = '<span>📋 From the duty list: <b>' + esc(t ? t.dutyNo : "(template deleted)") + "</b></span>" +
    (d.edited ? '<span class="duty-edited" id="deEdited">✎ Edited for this day</span>' : '<span class="muted" id="deEdited">Same as the template</span>') +
    (t ? '<button class="btn small" type="button" id="deReset">↺ Reset to template</button>' : "");
  if (t) $("deReset").addEventListener("click", resetToTemplate);
}
async function resetToTemplate() {
  const d = A.all[dutyId(A.ed.uid, A.ed.date)], t = d && A.tpls[d.templateId];
  if (!t || !confirm("Put this day's duty back to the template “" + t.dutyNo + "”? Changes made for this day are lost.")) return;
  try { await write(dutyFromTemplate(t, { date: d.date, driverUid: d.driverUid, driverName: d.driverName })); toast("Back to the template ✔"); setTimeout(() => openEditor(d.driverUid, d.date), 300); }
  catch (e) { $("deMsg").textContent = errMsg(e); }
}
function setTitle() { if (!A.ed) return; $("deTitle").textContent = (A.ed.existing ? "Duty – " : "New duty – ") + (teamName(A.ed.uid) || "Driver") + ", " + dayName(A.ed.date) + " " + ukDate(A.ed.date); }
function closeEditor() { A.ed = null; const e = $("dutyEditor"); e.style.display = "none"; e.innerHTML = ""; }
function fillDriverSelect() {
  const s = $("deDriver"); if (!s) return;
  s.innerHTML = A.team.map((u) => '<option value="' + esc(u.uid) + '">' + esc(u.name) + (u.role === "admin" ? " (admin)" : "") + "</option>").join("");
  s.value = A.ed.uid;
}
function fillVehicleSelect(keep, id) {
  const s = $(id || "deVeh"); if (!s) return;
  const cur = keep !== undefined ? keep : s.value;
  s.innerHTML = '<option value="">– none –</option>' + vehiclesList().map((v) => '<option value="' + esc(v.id) + '">' + esc(v.reg) + "</option>").join("");
  s.value = cur && vehiclesList().some((v) => v.id === cur) ? cur : "";
}
/* v22: each route ONCE (its AM / PM documents grouped), with an AM / PM selector beside it showing only the sessions it has */
const groups = () => routeGroups(A.getRoutes() || {});
function routeCell(routeId, session) {
  const gs = groups(), f = routeId ? findGroup(gs, routeId, session) : null;
  const dead = routeId && !f;
  return '<select class="de-route" aria-label="Linked route"><option value="">– no route –</option>' +
    gs.map((g) => '<option value="' + esc(g.key) + '"' + (f && f.group.key === g.key ? " selected" : "") + ">" + esc(g.label) + "</option>").join("") +
    (dead ? '<option value="#dead" data-id="' + esc(routeId) + '" data-sess="' + esc(session || "") + '" selected>(deleted route)</option>' : "") + "</select>" +
    '<select class="de-sess" aria-label="Session">' + sessOptions(f && f.group, f && f.session) + "</select>";
}
function sessOptions(g, sel) {
  if (!g) return '<option value="">–</option>';
  return g.list.map((k) => '<option value="' + k + '"' + (k === sel ? " selected" : "") + ">" + (k || "–") + "</option>").join("");
}
function rowRoute(row) {
  const s = row.querySelector(".de-route"), ss = row.querySelector(".de-sess");
  if (!s.value) return { routeId: "", session: "" };
  if (s.value === "#dead") { const o = s.options[s.selectedIndex]; return { routeId: o.dataset.id, session: o.dataset.sess }; }
  const g = groups().find((x) => x.key === s.value);
  if (!g) return { routeId: "", session: "" };
  const k = g.list.includes(ss.value) ? ss.value : g.list[0];
  return { routeId: g.sessions[k], session: k };
}
function syncSess(row) {
  const s = row.querySelector(".de-route"), ss = row.querySelector(".de-sess"), g = groups().find((x) => x.key === s.value), cur = ss.value;
  ss.innerHTML = sessOptions(g, g && g.list.includes(cur) ? cur : g && g.list[0]);
  ss.disabled = !g || g.list.length < 2;
}
function refreshRouteSelects() {
  document.querySelectorAll(".duty-rows .duty-row").forEach((row) => {
    const v = rowRoute(row), cell = row.querySelector(".de-routecell"); cell.innerHTML = routeCell(v.routeId, v.session); syncSess(row);
  });
}
function wireRows(box) {
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest(".de-del"); if (b) { b.closest(".duty-row").remove(); return; }
    const u = ev.target.closest(".de-up, .de-down"); if (!u) return;      // v23: ▲▼ = keyboard / accessible fallback for dragging
    const row = u.closest(".duty-row"), up = u.classList.contains("de-up"), sib = up ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    if (up) box.insertBefore(row, sib); else box.insertBefore(sib, row);
    (row.querySelector(up ? ".de-up" : ".de-down") || u).focus();
  });
  wireDrag(box);
  box.addEventListener("change", (ev) => {     // linking a route fills an empty description with its name (+ session)
    const row = ev.target.closest(".duty-row"); if (!row || !ev.target.closest(".de-route, .de-sess")) return;
    if (ev.target.classList.contains("de-route")) syncSess(row);
    const s = row.querySelector(".de-route"); if (!s.value || s.value === "#dead") return;
    const t = row.querySelector(".de-text"), g = groups().find((x) => x.key === s.value), k = row.querySelector(".de-sess").value;
    const auto = (x) => !x.trim() || groups().some((gg) => x === gg.label || gg.list.some((kk) => x === gg.label + " " + kk));
    if (g && auto(t.value)) t.value = g.label + (k ? " " + k : "");
  });
}
const readRows = (box) => [...box.querySelectorAll(".duty-row")].map((r) => ({ time: r.querySelector(".de-time").value, text: r.querySelector(".de-text").value, ...rowRoute(r) }));
function addRow(r, box) {
  const row = document.createElement("div");
  row.className = "duty-row";
  row.innerHTML = '<span class="de-move"><span class="de-handle" role="button" tabindex="-1" aria-hidden="true" title="Drag to move this row">⋮⋮</span>' +
    '<span class="de-ud"><button class="mini de-up" type="button" aria-label="Move row up">▲</button><button class="mini de-down" type="button" aria-label="Move row down">▼</button></span></span>' +
    '<input class="de-time" inputmode="numeric" maxlength="5" placeholder="hhmm" aria-label="Time (hhmm)" value="' + esc((r && r.time) || "") + '">' +
    '<input class="de-text" maxlength="200" placeholder="Description" aria-label="Description" value="' + esc((r && r.text) || "") + '">' +
    '<span class="de-routecell">' + routeCell(r && r.routeId, r && r.session) + "</span>" +
    '<button class="mini del de-del" type="button" aria-label="Remove row">✕</button>';
  (box && box.nodeType ? box : $("deRows")).appendChild(row); syncSess(row);
}
function readForm() {
  const veh = $("deVeh").value, v = vehiclesList().find((x) => x.id === veh);
  return { date: $("deDate").value, driverUid: $("deDriver").value, driverName: teamName($("deDriver").value), dutyNo: $("deNo").value,
    vehicleId: veh || "", vehicleReg: v ? String(v.reg).slice(0, 20) : "", note: $("deNote").value,
    rows: readRows($("deRows")) };
}
async function saveDuty() {
  const f = readForm(), chk = checkDuty(f), m = $("deMsg");
  if (!chk.ok) { m.textContent = chk.errors.join(" "); return; }
  const moved = f.driverUid !== A.ed.uid || f.date !== A.ed.date, target = A.all[dutyId(f.driverUid, f.date)];
  if (moved && target && !confirm(teamName(f.driverUid) + " already has duty " + target.dutyNo + " on " + ukDate(f.date) + ". Replace it?")) return;
  $("deSave").disabled = true; m.textContent = "Saving…";
  try {
    const prev = A.all[dutyId(A.ed.uid, A.ed.date)], tid = prev && prev.templateId;
    const edited = !!tid && (differsFromTemplate({ ...f, rows: chk.rows }, A.tpls[tid]) || (!A.tpls[tid] && !!prev.edited));
    await write(buildDuty({ ...f, rows: chk.rows, templateId: tid || "", edited }));
    if (moved && A.ed.existing) await deleteDoc(doc(col(A.c), dutyId(A.ed.uid, A.ed.date)));
    toast("Duty saved ✔");
    A.ed = { uid: f.driverUid, date: f.date, existing: true };
    m.textContent = "Saved ✔"; setTitle();
    setTimeout(renderTplBar, 400);
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
    if (s) { const d = D.list.find((x) => x.date === D.day); closeDuties(); D.c.startRun(s.dataset.route, d, s.dataset.session || ""); return; }
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

/* ================================================================ v22: duty list (templates) + day board */
const tplList = () => Object.values(A.tpls).sort((a, b) => String(a.dutyNo).localeCompare(String(b.dutyNo), "en-GB", { numeric: true }));
const routeText = (r) => routeLabel(A.getRoutes() || {}, r.routeId, r.session) || "(deleted route)";
function renderTpls() {
  const box = $("tlList"); if (!box || !A.c) return;
  const list = tplList();
  box.innerHTML = list.length ? list.map((t) => '<div class="duty-tpl" data-tpl="' + esc(t.id) + '"><div class="duty-tpl-main"><b class="duty-tpl-no">' + esc(t.dutyNo) + "</b>" +
    (t.vehicleReg ? ' <span class="duty-tpl-veh">🚌 ' + esc(t.vehicleReg) + "</span>" : "") +
    '<div class="muted duty-tpl-sum">' + esc((t.rows || []).map((r) => (r.time ? r.time + " " : "") + (r.text || (r.routeId ? routeText(r) : ""))).slice(0, 4).join(" · ")) + ((t.rows || []).length > 4 ? " …" : "") + "</div></div>" +
    '<div class="duty-tpl-btns"><button class="btn small" type="button" data-tedit="' + esc(t.id) + '">Edit</button><button class="btn small danger" type="button" data-tdel="' + esc(t.id) + '">Delete</button></div></div>').join("")
    : '<p class="muted">No duties on the list yet. Tap “+ New duty” to set one up.</p>';
}
function openTplEditor(id) {
  const t = id ? A.tpls[id] : null, e = $("tplEditor");
  A.te = { id: id || null };
  e.style.display = "";
  e.innerHTML = '<div class="duty-ed-head"><h3 id="teTitle">' + (t ? "Edit duty " + esc(t.dutyNo) : "New duty for the duty list") + '</h3><button class="icon-btn" type="button" id="teClose" aria-label="Close">✕</button></div>' +
    '<div class="duty-ed-top"><label>Duty no. / name<input id="teNo" maxlength="20" placeholder="e.g. 8"></label><label>Default vehicle<select id="teVeh"></select></label></div>' +
    '<div class="duty-rows-head"><span></span><span>Time</span><span>Description</span><span>Route (optional) + AM/PM</span><span></span></div><div id="teRows" class="duty-rows"></div>' +
    '<div class="duty-ed-btns"><button class="btn small" type="button" id="teAdd">+ Add row</button></div>' +
    '<label class="duty-note">Note (optional)<textarea id="teNote" rows="2" maxlength="500"></textarea></label><div class="form-msg" id="teMsg" role="status"></div>' +
    '<div class="duty-ed-actions"><button class="btn primary" type="button" id="teSave">Save to duty list</button><button class="btn" type="button" id="teCancel">Cancel</button></div>' +
    '<p class="muted">Changing the duty list does not change duties already given to drivers.</p>';
  $("teNo").value = t ? t.dutyNo : ""; $("teNote").value = (t && t.note) || "";
  fillVehicleSelect((t && t.vehicleId) || "", "teVeh");
  (t ? t.rows : TEMPLATE).forEach((r) => addRow(r, $("teRows")));
  wireRows($("teRows"));
  $("teAdd").addEventListener("click", () => addRow({ time: "", text: "" }, $("teRows")));
  $("teClose").addEventListener("click", closeTplEditor); $("teCancel").addEventListener("click", closeTplEditor);
  $("teSave").addEventListener("click", saveTpl);
  e.scrollIntoView({ behavior: "smooth", block: "start" }); $("teNo").focus({ preventScroll: true });
}
function closeTplEditor() { A.te = null; const e = $("tplEditor"); e.style.display = "none"; e.innerHTML = ""; }
async function saveTpl() {
  const veh = $("teVeh").value, v = vehiclesList().find((x) => x.id === veh);
  const f = { dutyNo: $("teNo").value, vehicleId: veh, vehicleReg: v ? String(v.reg).slice(0, 20) : "", note: $("teNote").value, rows: readRows($("teRows")) };
  const chk = checkTemplate(f), m = $("teMsg");
  if (!chk.ok) { m.textContent = chk.errors.join(" "); return; }
  const dup = tplList().find((t) => t.id !== A.te.id && String(t.dutyNo).toLowerCase() === f.dutyNo.trim().toLowerCase());
  if (dup) { m.textContent = "There is already a duty “" + dup.dutyNo + "” on the list."; return; }
  $("teSave").disabled = true; m.textContent = "Saving…";
  try {
    const ref = A.te.id ? doc(tcol(A.c), A.te.id) : doc(tcol(A.c));
    await setDoc(ref, { ...buildTemplate({ ...f, rows: chk.rows }), updatedAt: serverTimestamp(), updatedBy: A.c.user.uid });
    toast("Saved to the duty list ✔"); closeTplEditor();
  } catch (e) { m.textContent = errMsg(e); $("teSave").disabled = false; }
}
async function deleteTpl(id) {
  const t = A.tpls[id]; if (!t || !confirm("Delete “" + t.dutyNo + "” from the duty list? Duties already given to drivers stay as they are.")) return;
  try { await deleteDoc(doc(tcol(A.c), id)); toast("Removed from the duty list."); if (A.te && A.te.id === id) closeTplEditor(); }
  catch (e) { $("tlMsg").textContent = errMsg(e); }
}
function renderBoard() {
  const tb = $("dbTable"); if (!tb || !A.c || !A.wired) return;
  const date = A.boardDate || dutyDay();
  $("dbDate").value = date; $("dbTitle").textContent = dayName(date) + " " + ukDate(date);
  const list = tplList(), board = dayBoard(list, Object.values(A.all), date);
  fillRangeSelects(list);
  if (!list.length) { tb.innerHTML = '<tr><td class="muted">Set up the duty list below first.</td></tr>'; return; }
  const busy = new Set(Object.values(A.all).filter((d) => d.date === date).map((d) => d.driverUid));
  tb.innerHTML = '<thead><tr><th>Duty</th><th>Vehicle</th><th>Driver</th><th></th></tr></thead><tbody>' + board.map(({ t, duties }) => {
    const d = duties[0], cur = d ? d.driverUid : "";
    return '<tr data-brow="' + esc(t.id) + '"><th>' + esc(t.dutyNo) + "</th><td>" + esc((d ? d.vehicleReg : t.vehicleReg) || "–") + "</td><td>" +
      '<select data-assign="' + esc(t.id) + '" data-cur="' + esc(cur) + '" aria-label="Driver for duty ' + esc(t.dutyNo) + '"><option value="">– not given out –</option>' +
      A.team.map((u) => '<option value="' + esc(u.uid) + '"' + (u.uid === cur ? " selected" : "") + ">" + esc(u.name) + (u.uid !== cur && busy.has(u.uid) ? " (has a duty)" : "") + "</option>").join("") + "</select>" +
      (duties.length > 1 ? ' <small class="muted">+ ' + (duties.length - 1) + " more</small>" : "") + "</td><td>" +
      (d ? (d.edited ? '<span class="duty-edited">✎ Edited for this day</span> ' : "") + '<button class="btn small" type="button" data-open="' + esc(d.driverUid + "|" + date) + '">Open</button>' : "") + "</td></tr>";
  }).join("") + "</tbody>";
}
function fillRangeSelects(list) {
  const ts = $("drTpl"), ds = $("drDriver"); if (!ts) return;
  const tv = ts.value, dv = ds.value;
  ts.innerHTML = list.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.dutyNo) + "</option>").join("");
  ds.innerHTML = A.team.map((u) => '<option value="' + esc(u.uid) + '">' + esc(u.name) + "</option>").join("");
  if (tv && A.tpls[tv]) ts.value = tv; if (dv) ds.value = dv;
  if (!$("drFrom").value) { $("drFrom").value = A.boardDate || dutyDay(); $("drTo").value = addDays(weekStart(A.boardDate || dutyDay()), 4); }
}
async function assignFromBoard(tid, cur, uid, sel) {
  const t = A.tpls[tid], date = A.boardDate, m = $("dbMsg");
  if (!t) return;
  try {
    if (cur) {
      const old = A.all[dutyId(cur, date)];
      if (old && old.edited && !confirm(teamName(cur) + "’s duty " + t.dutyNo + " was edited for this day. Take it off them?")) { sel.value = cur; return; }
    }
    if (uid) {
      const ex = A.all[dutyId(uid, date)];
      if (ex && !confirm(teamName(uid) + " already has duty " + ex.dutyNo + " on " + ukDate(date) + ". Replace it with " + t.dutyNo + "?")) { sel.value = cur; return; }
      await write(dutyFromTemplate(t, { date, driverUid: uid, driverName: teamName(uid) }));
    }
    if (cur && cur !== uid) await deleteDoc(doc(col(A.c), dutyId(cur, date)));
    m.classList.add("ok");
    m.textContent = uid ? "Duty " + t.dutyNo + " given to " + teamName(uid) + " for " + ukDate(date) + " ✔" : "Duty " + t.dutyNo + " is not given out on " + ukDate(date) + ".";
  } catch (e) { m.classList.remove("ok"); m.textContent = errMsg(e); sel.value = cur; }
}
async function assignRange() {
  const t = A.tpls[$("drTpl").value], uid = $("drDriver").value, m = $("drMsg");
  if (!t || !uid) { m.textContent = "Pick a duty and a driver."; return; }
  const days = [...document.querySelectorAll("#drDays input:checked")].map((i) => +i.value);
  const dates = assignDates($("drFrom").value, $("drTo").value, days);
  if (!dates.length) { m.textContent = "No dates in that range on the ticked days."; return; }
  const todo = dates.filter((d) => !A.all[dutyId(uid, d)]), skipped = dates.length - todo.length;
  m.textContent = "Assigning…";
  const res = await Promise.allSettled(todo.map((date) => write(dutyFromTemplate(t, { date, driverUid: uid, driverName: teamName(uid) }))));
  const bad = res.filter((r) => r.status === "rejected");
  m.classList.toggle("ok", !bad.length);
  m.textContent = (todo.length - bad.length) + " day" + (todo.length - bad.length === 1 ? "" : "s") + " assigned" + (skipped ? ", " + skipped + " skipped (already had a duty)" : "") + (bad.length ? ", " + bad.length + " failed: " + errMsg(bad[0].reason) : " ✔");
}

/* ================================================================ v23: drag rows to reorder (mouse + touch)
   Pointer events on the ⋮⋮ handle only (typing in the inputs never starts a drag). The row follows the finger, a
   placeholder shows where it will drop, and the page / sheet scrolls by itself near the top and bottom edges. */
function scrollParent(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;     // the window
}
function wireDrag(box) {
  box.addEventListener("pointerdown", (ev) => {
    const h = ev.target.closest(".de-handle");
    if (!h || (ev.pointerType === "mouse" && ev.button !== 0)) return;
    ev.preventDefault();
    const row = h.closest(".duty-row"), r = row.getBoundingClientRect(), sp = scrollParent(box);
    const ph = document.createElement("div");
    ph.className = "duty-row-ph"; ph.style.height = r.height + "px";
    row.after(ph);
    const off = ev.clientY - r.top;
    Object.assign(row.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", zIndex: 2000 });
    row.classList.add("dragging"); document.body.classList.add("duty-dragging");
    let y = ev.clientY, raf = 0;
    const place = () => {
      row.style.top = (y - off) + "px";
      const others = [...box.querySelectorAll(".duty-row:not(.dragging)")];
      const before = others.find((o) => { const b = o.getBoundingClientRect(); return y < b.top + b.height / 2; });
      if (before) { if (ph.nextElementSibling !== before) box.insertBefore(ph, before); } else if (box.lastElementChild !== ph) box.appendChild(ph);
    };
    const tick = () => {     // auto-scroll near the edges of the sheet (or the window)
      const top = sp ? sp.getBoundingClientRect().top : 0, bot = sp ? sp.getBoundingClientRect().bottom : window.innerHeight, edge = 60;
      const d = y < top + edge ? -Math.ceil((top + edge - y) / 4) : y > bot - edge ? Math.ceil((y - (bot - edge)) / 4) : 0;
      if (d) { if (sp) sp.scrollTop += d; else window.scrollBy(0, d); place(); }
      raf = requestAnimationFrame(tick);
    };
    const move = (e) => { y = e.clientY; place(); };
    const end = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      ph.replaceWith(row);
      row.classList.remove("dragging"); document.body.classList.remove("duty-dragging");
      Object.assign(row.style, { position: "", left: "", top: "", width: "", zIndex: "" });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    raf = requestAnimationFrame(tick);
  });
}
