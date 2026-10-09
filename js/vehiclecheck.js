/* v18: the two paper vehicle sheets on the phone (driver / admin driving).
     white sheet - "Drivers 1st Use Pre Drive Away Check": after the vehicle is picked, once per vehicle per duty day (05:00-05:00 London)
     pink sheet  - "Drivers Defect Report Form": at the end of the duty (all today's runs done) or from the drawer
   Each sheet becomes ONE document companies/{cid}/defects/{id}. Nil -> the admin's Vehicle defects tab; a defect -> that tab AND
   the maintenance view (the rules decide who can read what). If the write fails (offline, or the v18 rules are not published yet)
   the sheet is kept on this phone and sent the next time the app opens / comes back online - never lost. */
import { doc, collection, setDoc, getDoc, getDocs, query, where, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { $, esc, toast } from "./ui.js?v=16";
import { CHECK_ITEMS, NOTE_MAX, DEFECT_LINES, DEFECT_LINE_MAX, DUTY_NO_MAX, SIG_TARGET, ukDate, checkPredrive, allOk, buildPredrive,
  predriveDefects, checkEndOfDuty, buildEndOfDuty } from "./defects.js?v=18";

let ctx = null;                 // { db, user, profile, companyId }
const PENDING_KEY = "rt_vc_pending";
const WRITE_TIMEOUT_MS = 12000, READ_TIMEOUT_MS = 4000;
let open = false;

export function initVehicleCheck(c) {
  ctx = c;
  retryPending();
}
export function isSheetOpen() { return open; }
const driverName = () => String((ctx.profile && ctx.profile.name) || (ctx.user.email || "").split("@")[0] || "Driver").slice(0, 120);
const vKey = (v) => (v && (v.id || v.reg)) || "none";

/* ---------------------------------------------------------------- what's done today (this phone) */
const recKey = () => "rt_vc_" + ctx.companyId + "_" + ctx.user.uid;
function readRec(day) {
  try { const r = JSON.parse(localStorage.getItem(recKey()) || "null"); if (r && r.day === day) return r; } catch (e) { /* ignore */ }
  return { day, predrive: {}, end: {}, no: {} };
}
function writeRec(r) { try { localStorage.setItem(recKey(), JSON.stringify(r)); } catch (e) { /* ignore */ } }
function remember(day, kind, v, info) {
  const r = readRec(day);
  r[kind === "predrive" ? "predrive" : "end"][vKey(v)] = info || true;
  writeRec(r);
}
/* own sheets for the duty day on the account (another phone, after clearing the phone) - quick, never blocks for long */
async function remoteSheets(day) {
  try {
    const snap = await Promise.race([
      getDocs(query(collection(ctx.db, "companies", ctx.companyId, "defects"), where("driverUid", "==", ctx.user.uid), where("dutyDay", "==", day))),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timed out"), { code: "timeout" })), READ_TIMEOUT_MS))
    ]);
    return snap.docs.map((d) => d.data());
  } catch (e) {
    console.info("Vehicle checks on the account not available (" + ((e && e.code) || e) + ") - using this phone's record");
    return null;
  }
}
const sameVehicle = (d, v) => (v.id && d.vehicleId === v.id) || (!v.id && d.vehicleReg === v.reg);
const toMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : 0);
/* -> false, or { at: ms|0 } for the latest sheet of this kind for the vehicle today */
async function doneInfo(kind, day, v) {
  const r = readRec(day), slot = kind === "predrive" ? r.predrive : r.end;
  const loc = slot[vKey(v)];
  if (loc) return { at: (loc && loc.at) || 0 };
  const pend = readPending().filter((p) => p.data.kind === kind && p.data.dutyDay === day && sameVehicle(p.data, v || {}));
  if (pend.length) return { at: pend[pend.length - 1].savedAt || 0 };
  const list = await remoteSheets(day);
  const hits = (list || []).filter((d) => d.kind === kind && sameVehicle(d, v || {}));
  if (!hits.length) return false;
  const hit = hits.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))[0], at = toMillis(hit.createdAt);
  remember(day, kind, v, kind === "predrive" ? { mileage: hit.mileage, hasDefect: !!hit.hasDefect, at } : { at });
  return { at };
}
async function done(kind, day, v) { return !!(await doneInfo(kind, day, v)); }
export const predriveDone = (day, v) => done("predrive", day, v);
export const predriveInfo = (day, v) => doneInfo("predrive", day, v);
/* v19: the driver answered "No" to "Do you need to do a first use check?" - kept on this phone only (no rules change) */
export function rememberNoCheck(day, v) { const r = readRec(day); r.no = r.no || {}; r.no[vKey(v)] = Date.now(); writeRec(r); }
export function saidNoToday(day, v) { const r = readRec(day); return !!(r.no && r.no[vKey(v)]); }
export const endOfDutyDone = (day, v) => done("endofduty", day, v);
export function startMileage(day, v) { const p = readRec(day).predrive[vKey(v)]; return p && typeof p.mileage === "number" ? p.mileage : null; }

/* ---------------------------------------------------------------- saving (with the phone as the safety net) */
function readPending() {
  try { const a = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); return Array.isArray(a) ? a.filter((p) => ctx && p.cid === ctx.companyId && p.uid === ctx.user.uid) : []; }
  catch (e) { return []; }
}
function writeAllPending(fn) {
  try { const a = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); localStorage.setItem(PENDING_KEY, JSON.stringify(fn(Array.isArray(a) ? a : []))); } catch (e) { /* ignore */ }
}
const putPending = (p) => writeAllPending((a) => a.filter((x) => x.id !== p.id).concat([p]));
const dropPending = (id) => writeAllPending((a) => a.filter((x) => x.id !== id));
async function send(id, data) {
  if (navigator.onLine === false) throw Object.assign(new Error("offline"), { code: "offline" });
  const ref = doc(ctx.db, "companies", ctx.companyId, "defects", id);
  try {
    await Promise.race([
      setDoc(ref, { ...data, createdAt: serverTimestamp() }),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timed out"), { code: "timeout" })), WRITE_TIMEOUT_MS))
    ]);
  } catch (e) {
    // a retry of a sheet that did reach the server earlier is refused (sheets are write-once): already there = sent
    if (e && e.code === "permission-denied") {
      try { const s = await getDoc(ref); if (s.exists() && s.data().driverUid === ctx.user.uid) return; } catch (e2) { /* not readable */ }
    }
    throw e;
  }
}
async function save(data) {
  const id = doc(collection(ctx.db, "companies", ctx.companyId, "defects")).id;
  putPending({ id, cid: ctx.companyId, uid: ctx.user.uid, data, savedAt: Date.now() });
  try { await send(id, data); dropPending(id); return { sent: true }; }
  catch (e) {
    console.info("Vehicle sheet kept on this phone (" + ((e && e.code) || e) + ")");
    return { sent: false, code: (e && e.code) || "" };
  }
}
let retrying = false;
export async function retryPending() {
  if (!ctx || retrying) return 0;
  retrying = true;
  let n = 0;
  try {
    for (const p of readPending()) {
      try { await send(p.id, p.data); dropPending(p.id); n++; } catch (e) { if (e && e.code === "offline") break; }
    }
  } finally { retrying = false; }
  if (n) toast(n === 1 ? "A vehicle sheet saved on this phone has now been sent." : n + " vehicle sheets saved on this phone have now been sent.");
  return n;
}
window.addEventListener("online", () => { retryPending(); });
const keptMsg = (code) => code === "permission-denied"
  ? "Saved on this phone – ask your admin to update the rules"
  : "Saved on this phone – it will be sent when you have signal";

/* ---------------------------------------------------------------- overlay */
function show(html) {
  const ov = $("vcOverlay"), sh = $("vcSheet");
  sh.innerHTML = html; ov.style.display = "flex"; open = true;
  document.body.classList.add("vc-open");
  ov.scrollTop = 0; sh.scrollTop = 0;
}
function hide() {
  $("vcOverlay").style.display = "none"; $("vcSheet").innerHTML = ""; open = false;
  document.body.classList.remove("vc-open");
}
const field = (label, value, id) => '<div class="vc-f"><span class="vc-fl">' + label + '</span><b class="vc-fv"' + (id ? ' id="' + id + '"' : "") + ">" + esc(value || "—") + "</b></div>";
function resultCard(kind, defect, lines, res, startNote) {
  const title = defect
    ? (kind === "predrive" ? "⚠️ Defect reported – check with your depot before driving" : "⚠️ Defect report sent to your admin and maintenance")
    : (kind === "predrive" ? "✔ Vehicle check done – no defects" : "✔ End-of-duty report sent – nil defects");
  return '<div class="vc-result ' + (defect ? "bad" : "good") + '" id="vcResult">' +
    '<div class="vc-r-title" id="vcResultTitle">' + title + "</div>" +
    (lines.length ? '<ul class="vc-r-lines">' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>" : "") +
    (defect && kind === "predrive" ? '<p class="vc-r-p">Your admin and maintenance can see this defect. Don’t take the vehicle out until your depot says it is safe.</p>' : "") +
    (startNote ? '<p class="vc-r-p">' + esc(startNote) + "</p>" : "") +
    (res.sent ? "" : '<p class="vc-r-kept" id="vcKept">' + esc(keptMsg(res.code)) + "</p>") +
    '<button class="btn primary vc-big" id="vcContinue" type="button">' + (defect && kind === "predrive" ? "I’ve reported it – continue" : kind === "predrive" ? "Continue" : "Done") + "</button></div>";
}

/* ================================================================ v19: "Do you need to do a first use check?" */
const hhmm = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
export function askFirstUse(o) {
  // o: { vehicle: { id?, reg }, done: false | { at } }  ->  resolves 'yes' | 'no'
  return new Promise((resolve) => {
    const v = o.vehicle || {}, d = o.done;
    show('<div class="vc-paper white vc-ask" data-sheet="firstuse" data-done="' + (d ? "1" : "0") + '">' +
      '<div class="vc-head"><h2 id="vcTitle">First use check</h2><div class="vc-sub">' + esc(driverName()) + "</div></div>" +
      '<div class="vc-ask-reg" id="vcAskReg">' + esc(v.reg || "—") + "</div>" +
      (d ? '<div class="vc-ask-done" id="vcAskDone">✔ Already checked today' + (d.at ? " at " + hhmm(d.at) : "") + "</div>" +
           '<p class="vc-ask-q" id="vcAskQ">The first use check for <b>' + esc(v.reg) + "</b> has been done. Carry on, or do the check again if you need to.</p>" +
           '<div class="vc-ask-btns"><button type="button" class="btn primary vc-big" id="vcAskNo">Continue – already checked</button>' +
           '<button type="button" class="btn vc-big" id="vcAskYes">Do the check again</button></div>'
         : '<p class="vc-ask-q" id="vcAskQ">Do you need to do a first use check on <b>' + esc(v.reg) + "</b>?</p>" +
           '<div class="vc-ask-btns"><button type="button" class="btn primary vc-big" id="vcAskYes">Yes – do the check</button>' +
           '<button type="button" class="btn vc-big" id="vcAskNo">No – already done / not first use</button></div>') +
      "</div>");
    $("vcAskYes").addEventListener("click", () => { hide(); resolve("yes"); });
    $("vcAskNo").addEventListener("click", () => { hide(); resolve("no"); });
    setTimeout(() => { const b = $(d ? "vcAskNo" : "vcAskYes"); if (b) b.focus(); }, 0);
  });
}

/* ================================================================ white sheet */
export function openPredrive(o) {
  // o: { vehicle: { id?, reg }, day }
  return new Promise((resolve) => {
    const v = o.vehicle || {}, day = o.day;
    const st = { items: {}, notes: {}, mileage: "", dutyNo: "", tried: false };
    show('<div class="vc-paper white" data-sheet="predrive">' +
      '<div class="vc-head"><h2 id="vcTitle">Drivers 1st Use Pre Drive Away Check</h2>' +
      '<div class="vc-sub">To be completed (and handed in) <b>before</b> taking the vehicle from the depot</div></div>' +
      '<div class="vc-grid">' + field("Date", ukDate(day), "vcDate") + field("Name", driverName(), "vcName") + field("Full reg.", v.reg, "vcReg") +
      '<label class="vc-f"><span class="vc-fl">Duty no.</span><input type="text" id="vcDutyNo" maxlength="' + DUTY_NO_MAX + '" autocomplete="off"></label>' +
      '<label class="vc-f"><span class="vc-fl">Mileage <span class="req">*</span></span><input type="text" id="vcMileage" inputmode="numeric" maxlength="9" autocomplete="off" placeholder="e.g. 120345"></label></div>' +
      '<div class="vc-bar"><span>Tick if OK – “X” if not</span><button type="button" class="vc-allok" id="vcAllOk">✓ All OK</button></div>' +
      '<div class="vc-items" id="vcItems">' + CHECK_ITEMS.map((it) =>
        '<div class="vc-item" data-item="' + it.key + '"><div class="vc-row"><div class="vc-lbl">' + esc(it.label) + '</div><div class="vc-tg" role="group" aria-label="' + esc(it.label) + '">' +
        '<button type="button" class="vc-ok" data-v="ok" aria-pressed="false" aria-label="OK">✓</button>' +
        '<button type="button" class="vc-x" data-v="x" aria-pressed="false" aria-label="Not OK">✗</button>' +
        (it.na ? '<button type="button" class="vc-na" data-v="na" aria-pressed="false" aria-label="Not applicable">N/A</button>' : "") +
        '</div></div><input type="text" class="vc-note" maxlength="' + NOTE_MAX + '" placeholder="What’s wrong? (required)" aria-label="What is wrong with ' + esc(it.label) + '"></div>').join("") +
      "</div>" +
      '<div class="vc-msg" id="vcMsg" role="alert"></div>' +
      '<div class="vc-foot">This form must be completed before you take the vehicle out.</div>' +
      '<div class="vc-actions">' +
      '<button type="button" class="btn primary vc-big" id="vcSubmit">Submit check</button></div></div>');
    const items = $("vcItems");
    const paint = () => {
      const chk = checkPredrive(st);
      items.querySelectorAll(".vc-item").forEach((row) => {
        const k = row.dataset.item, val = st.items[k] || "";
        row.querySelectorAll("[data-v]").forEach((b) => { const on = b.dataset.v === val; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
        row.classList.toggle("is-x", val === "x"); row.classList.toggle("is-ok", val === "ok"); row.classList.toggle("is-na", val === "na");
        row.classList.toggle("missing", st.tried && (chk.missing.includes(k) || chk.needNote.includes(k)));
      });
      $("vcMileage").classList.toggle("missing", st.tried && chk.mileage === null);
      if (st.tried) $("vcMsg").textContent = chk.errors.join(" ");
      return chk;
    };
    items.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-v]"); if (!b) return;
      const row = b.closest(".vc-item"), k = row.dataset.item;
      st.items[k] = st.items[k] === b.dataset.v ? "" : b.dataset.v;
      paint();
      if (st.items[k] === "x") row.querySelector(".vc-note").focus();
    });
    items.addEventListener("input", (ev) => { const n = ev.target.closest(".vc-note"); if (n) { st.notes[n.closest(".vc-item").dataset.item] = n.value; if (st.tried) paint(); } });
    $("vcMileage").addEventListener("input", (e) => { st.mileage = e.target.value; if (st.tried) paint(); });
    $("vcDutyNo").addEventListener("input", (e) => { st.dutyNo = e.target.value; });
    $("vcAllOk").addEventListener("click", () => { st.items = allOk(st.items); paint(); });
    $("vcSubmit").addEventListener("click", async () => {
      st.tried = true;
      const chk = paint();
      if (!chk.ok) { const m = items.querySelector(".vc-item.missing") || $("vcMileage"); if (m && m.scrollIntoView) m.scrollIntoView({ block: "center" }); return; }
      $("vcSubmit").disabled = true; $("vcSubmit").textContent = "Sending…";
      const data = buildPredrive({ ...st, driverUid: ctx.user.uid, driverName: driverName(), dutyDay: day, vehicleId: v.id, vehicleReg: v.reg });
      const res = await save(data);
      remember(day, "predrive", v, { mileage: data.mileage, hasDefect: data.hasDefect, at: Date.now() });
      show(resultCard("predrive", data.hasDefect, predriveDefects(data.items, data.notes), res));
      $("vcContinue").addEventListener("click", () => { hide(); resolve({ sent: res.sent, hasDefect: data.hasDefect }); });
      if (!data.hasDefect && res.sent) toast("Vehicle check saved ✔");
    });
    paint();
  });
}

/* ================================================================ pink sheet */
export function openEndOfDuty(o) {
  // o: { vehicle: { id?, reg } | null, day, vehicles?: [{ id, reg }] (v19: to choose from when no vehicle was picked today) }
  return new Promise((resolve) => {
    let v = o.vehicle && o.vehicle.reg ? o.vehicle : null;
    const day = o.day, fixed = !!v;
    const fleet = (o.vehicles || []).filter((x) => x && x.reg);
    let start = v ? startMileage(day, v) : null;
    const regField = fixed ? field("Full reg.", v.reg, "vcReg")
      : '<label class="vc-f vc-regpick"><span class="vc-fl">Full reg. <span class="req">*</span></span>' +
        (fleet.length ? '<select id="vcRegSel"><option value="">Choose the vehicle…</option>' + fleet.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.reg) + "</option>").join("") +
          '<option value="__other">Other – type the registration</option></select>' : "") +
        '<input type="text" id="vcRegIn" maxlength="20" autocomplete="off" placeholder="e.g. CY12 ABC"' + (fleet.length ? ' style="display:none"' : "") + "></label>";
    const st = { nil: null, defects: [""], endMileage: "", lowOk: false, lowShown: false, tried: false };
    show('<div class="vc-paper pink" data-sheet="endofduty">' +
      '<div class="vc-head"><h2 id="vcTitle">Drivers Defect Report Form</h2>' +
      '<div class="vc-sub">To be completed (and handed in) at the end of your duty</div></div>' +
      '<div class="vc-grid">' + field("Date", ukDate(day), "vcDate") +
      regField +
      field("Name", driverName(), "vcName") + "</div>" +
      '<div class="vc-q">Please note any defects found below. If no defects then choose “Nil”.</div>' +
      '<div class="vc-seg" role="group" aria-label="Defects"><button type="button" class="vc-nil" id="vcNil" aria-pressed="false">✓ Nil defects</button>' +
      '<button type="button" class="vc-def" id="vcDef" aria-pressed="false">⚠️ Report a defect</button></div>' +
      '<div class="vc-lines" id="vcLines" style="display:none"></div>' +
      '<div class="vc-sign"><div class="vc-fl">Sign <span class="req">*</span></div>' +
      '<div class="vc-pad-wrap"><canvas class="vc-pad" id="vcPad" aria-label="Signature – sign with your finger"></canvas><span class="vc-pad-hint" id="vcPadHint">Sign here with your finger</span></div>' +
      '<div class="vc-pad-tools"><button type="button" class="btn small" id="vcPadClear">Clear</button>' +
      '<label class="vc-typed" id="vcTypedWrap" style="display:none">Type your name to sign<input type="text" id="vcTyped" maxlength="120" autocomplete="name"></label></div></div>' +
      '<label class="vc-f vc-end"><span class="vc-fl">End mileage <span class="req">*</span></span><input type="text" id="vcEndMiles" inputmode="numeric" maxlength="9" autocomplete="off">' +
      '<span class="vc-hint" id="vcStartHint">' + (start !== null ? "Start mileage today: " + start.toLocaleString("en-GB") : "") + "</span></label>" +
      '<div class="vc-msg" id="vcMsg" role="alert"></div>' +
      '<div class="vc-foot">This copy is to be deposited in the correct place <b>before you leave for home</b>.</div>' +
      '<div class="vc-actions"><button type="button" class="btn" id="vcLater">Not now</button>' +
      '<button type="button" class="btn primary vc-big" id="vcSubmit">Submit report</button></div></div>');
    const pad = signaturePad($("vcPad"), () => { $("vcPadHint").style.display = "none"; if (st.tried) paint(); });
    if (!pad) { $("vcTypedWrap").style.display = ""; $("vcPad").parentElement.style.display = "none"; $("vcPadClear").style.display = "none"; }
    const renderLines = () => {
      const w = $("vcLines");
      w.innerHTML = st.defects.map((t, i) => '<label class="vc-line"><span class="vc-fl">Defect ' + (i + 1) + '</span><textarea rows="2" maxlength="' + DEFECT_LINE_MAX +
        '" data-line="' + i + '" placeholder="What is wrong, and where">' + esc(t) + "</textarea></label>").join("") +
        (st.defects.length < DEFECT_LINES ? '<button type="button" class="btn small vc-addline" id="vcAddLine">+ Add another defect</button>' : "");
      if ($("vcAddLine")) $("vcAddLine").addEventListener("click", () => { st.defects.push(""); renderLines(); const t = w.querySelectorAll("textarea"); t[t.length - 1].focus(); });
    };
    $("vcLines").addEventListener("input", (e) => { const t = e.target.closest("textarea"); if (t) { st.defects[+t.dataset.line] = t.value; if (st.tried) paint(); } });
    const form = (withSig) => ({ ...st, signature: pad && !pad.empty() ? (withSig ? pad.dataUrl() : "x") : "", signedName: pad ? "" : ($("vcTyped").value || "") });
    const paint = () => {
      $("vcNil").classList.toggle("on", st.nil === true); $("vcNil").setAttribute("aria-pressed", st.nil === true ? "true" : "false");
      $("vcDef").classList.toggle("on", st.nil === false); $("vcDef").setAttribute("aria-pressed", st.nil === false ? "true" : "false");
      $("vcLines").style.display = st.nil === false ? "" : "none";
      const chk = checkEndOfDuty({ ...form(false), startMileage: start });
      if (st.tried) {
        const msgs = chk.errors.slice();
        if (chk.low && !st.lowOk && st.lowShown) msgs.push("The end mileage is lower than the start mileage (" + start.toLocaleString("en-GB") + "). Check it – or tap Submit again to send it as it is.");
        $("vcMsg").textContent = msgs.join(" ");
        $("vcMsg").classList.toggle("warn", !chk.errors.length && chk.low && st.lowShown);
      }
      return chk;
    };
    $("vcNil").addEventListener("click", () => { st.nil = true; paint(); });
    $("vcDef").addEventListener("click", () => { st.nil = false; if (!$("vcLines").children.length) renderLines(); paint(); const t = $("vcLines").querySelector("textarea"); if (t) t.focus(); });
    $("vcEndMiles").addEventListener("input", (e) => { st.endMileage = e.target.value; st.lowOk = false; st.lowShown = false; if (st.tried) paint(); });
    if ($("vcTyped")) $("vcTyped").addEventListener("input", () => { if (st.tried) paint(); });
    $("vcPadClear").addEventListener("click", () => { if (pad) pad.clear(); $("vcPadHint").style.display = ""; if (st.tried) paint(); });
    $("vcLater").addEventListener("click", () => { hide(); resolve({ cancelled: true }); });
    if ($("vcRegSel")) $("vcRegSel").addEventListener("change", (e) => {
      const id = e.target.value, other = id === "__other";
      $("vcRegIn").style.display = other ? "" : "none";
      if (other) $("vcRegIn").focus();
      v = !other && id ? fleet.find((x) => x.id === id) || null : null;
      start = v ? startMileage(day, v) : null;
      $("vcStartHint").textContent = start !== null ? "Start mileage today: " + start.toLocaleString("en-GB") : "";
      st.lowOk = false; st.lowShown = false;
      if (st.tried) paint();
    });
    $("vcSubmit").addEventListener("click", async () => {
      st.tried = true;
      let chk = paint();
      const reg = v && v.reg ? v.reg : ($("vcRegIn") ? $("vcRegIn").value.trim().toUpperCase() : "");
      if (!reg) {
        $("vcMsg").textContent = ((fleet.length ? "Choose the vehicle (or Other and type the registration). " : "Enter the vehicle registration. ") + $("vcMsg").textContent).trim();
        return;
      }
      if (!chk.errors.length && chk.low && !st.lowOk) {
        if (!st.lowShown) { st.lowShown = true; paint(); return; }   // first tap: the warning; a second tap sends it as it is
        st.lowOk = true; chk = paint();
      }
      if (!chk.ok && !(chk.low && st.lowOk && !chk.errors.length)) return;
      $("vcSubmit").disabled = true; $("vcSubmit").textContent = "Sending…";
      const f = form(true);
      const data = buildEndOfDuty({ ...f, startMileage: start, driverUid: ctx.user.uid, driverName: driverName(), dutyDay: day,
        vehicleId: v && v.id, vehicleReg: reg });
      const res = await save(data);
      remember(day, "endofduty", v || { reg }, { at: Date.now() });
      show(resultCard("endofduty", data.hasDefect, data.defects, res));
      $("vcContinue").addEventListener("click", () => { hide(); resolve({ sent: res.sent, hasDefect: data.hasDefect }); });
    });
    paint();
  });
}

/* ---------------------------------------------------------------- finger signature -> small PNG data URL (<= ~50 KB) */
function signaturePad(canvas, onInk) {
  const g = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  if (!g) return null;
  let strokes = [], cur = null;
  const fit = () => {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
    redraw();
  };
  const redraw = () => {
    const r = canvas.getBoundingClientRect(), sx = canvas.width / (r.width || 1);
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
    g.setTransform(sx, 0, 0, sx, 0, 0);
    strokes.forEach((s) => drawStroke(g, s));
  };
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (ev) => { ev.preventDefault(); canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId); cur = [pos(ev)]; strokes.push(cur); redraw(); });
  canvas.addEventListener("pointermove", (ev) => { if (!cur) return; cur.push(pos(ev)); redraw(); });
  const end = () => { if (cur) { cur = null; onInk && onInk(); } };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end); canvas.addEventListener("pointerleave", end);
  setTimeout(fit, 0); window.addEventListener("resize", fit);
  return {
    empty: () => !strokes.some((s) => s.length > 0),
    clear: () => { strokes = []; redraw(); },
    dataUrl: () => exportSig(strokes, canvas.getBoundingClientRect())
  };
}
function drawStroke(g, s) {
  g.strokeStyle = "#111"; g.lineWidth = 2.4; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath();
  s.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  if (s.length === 1) g.lineTo(s[0][0] + 0.1, s[0][1] + 0.1);
  g.stroke();
}
function exportSig(strokes, rect) {
  // crop to the ink (+ margin), draw at <= 600 px wide, shrink until the PNG is under ~50 KB
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  strokes.forEach((s) => s.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }));
  if (!isFinite(x0)) return "";
  const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(rect.width, x1 + m); y1 = Math.min(rect.height, y1 + m);
  const w = Math.max(10, x1 - x0), h = Math.max(10, y1 - y0);
  let scale = Math.min(1.5, 600 / w), url = "";
  for (let i = 0; i < 8; i++) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const g = c.getContext("2d");
    g.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    strokes.forEach((s) => drawStroke(g, s));
    url = c.toDataURL("image/png");
    if (url.length <= SIG_TARGET) break;
    scale *= 0.7;
  }
  return url;
}
