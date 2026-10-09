/* App entry point: authentication, company/profile loading, and switching between
   the sign-in screen, the Admin screens and the (original) Driver view. */
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc, getDoc, collection, onSnapshot, writeBatch, serverTimestamp, terminate, clearIndexedDbPersistence,
  getDocs, setDoc, deleteDoc, updateDoc, query, where, Timestamp, deleteField
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { isConfigured, isEmulator, auth, db } from "./firebase-init.js?v=16";
import { $, setView, toast, friendlyError, readServicePick, wireServicePick } from "./ui.js?v=16";
import { decodePolyline, densify } from "./geo.js?v=16";
import { initAdmin, showAdmin, onRoutesChanged, onCompanyChanged, onVehiclesChanged } from "./admin.js?v=18";
import { initVehicleCheck, predriveInfo, endOfDutyDone, openPredrive, openEndOfDuty, isSheetOpen, askFirstUse, rememberNoCheck, saidNoToday }
  from "./vehiclecheck.js?v=19";
import { showMaintenance, stopDefectLists } from "./defectlist.js?v=18";
import { resolveOperator } from "./operator.js?v=16";
import { pickedServiceTypes, welcomeName, selLabel, selMatches, encodeSel, decodeSel, picksFromSel, routeRank, routeSlotLabel,
  dutyDay, prevDutyDay } from "./services.js?v=16";
import { planDocId, planCacheKey, cleanPlan, mergePlans, planDoc } from "./dayplan.js?v=16";
import { vehicleDims } from "./vehicles.js?v=16";
import { runWelcome, welcomeRefresh } from "./welcome.js?v=16";

const session = { user: null, profile: null, company: null, companyId: null, unsubRoutes: null, unsubCompany: null, rawRoutes: {},
  routesReady: null, routesLoaded: null, pick: null, vehicles: {}, unsubVehicles: null, vehicleId: null,
  plan: null, planDay: null, dayOver: false, planWrittenDay: null };
let registering = false;

/* ---------- convert a Firestore route doc into the shape the driver view expects ---------- */
export function docToRoute(id, d, companyOp) {
  const stops = Array.isArray(d.stops) ? d.stops : [];
  const track = d.trackEnc ? densify(decodePolyline(d.trackEnc), 30) : [];
  const upd = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
  // the operator the driver sees: the route's own (custom) details, else the company operator
  const operator = resolveOperator(d, companyOp);
  return {
    id, name: d.name, addedAt: d.addedAt,
    track,
    stops: stops.map((s) => [s.lat, s.lng]),
    stopNames: stops.map((s) => s.name || ""),
    timetable: d.timetable, operator, capacity: d.capacity,
    specifiedRoute: d.specifiedRoute, note: d.note, contacts: d.contacts,
    category: d.category, session: d.session, serviceType: d.serviceType || "", destination: d.destination || "",
    _v: upd + ":" + (d.trackEnc ? d.trackEnc.length : 0) + ":" + (d.name || "") + ":" + stops.length + ":" + (operator ? JSON.stringify(operator) : "") +
        // timetable / session / note too, so a timetable edit always reaches the driver (Next-stop "Due"/Wait, Schedule)
        ":" + JSON.stringify([d.timetable || null, d.session || "", d.note || "", d.serviceType || ""])
  };
}

/* ---------- boot ---------- */
if (!isConfigured) {
  setView("setup");
} else {
  if (isEmulator) {
    // Test hook, available ONLY on localhost with ?emulator=1
    window.__mc = { auth, db, signOut, getDoc, getDocs, doc, collection, query, where, setDoc, deleteDoc, updateDoc, serverTimestamp, deleteField };
  }
  wireAuthForms();
  onAuthStateChanged(auth, (user) => {
    if (registering) return;               // registration finishes the session itself
    if (!user) { teardown(); setView("auth"); return; }
    startSession(user);
  });
}

async function startSession(user) {
  setView("boot");
  teardown();
  try {
    const ps = await getDoc(doc(db, "users", user.uid));
    if (!ps.exists()) {
      $("orphanEmail").textContent = user.email || "";
      setView("orphan");
      return;
    }
    const profile = ps.data();
    const cs = await getDoc(doc(db, "companies", profile.companyId));
    session.user = user; session.profile = profile; session.companyId = profile.companyId;
    session.company = cs.exists() ? cs.data() : { name: "Your company" };

    // v18: a maintenance login sees ONLY the vehicle defects (no routes, runs, Sat-Nav or settings)
    if (profile.role === "maintenance") {
      showMaintenance({ db, user, profile, companyId: session.companyId, company: session.company, signOutAndReset });
      return;
    }
    $("acctLine").textContent = (profile.name || user.email) + " · " + session.company.name +
      " · " + (profile.role === "admin" ? "Administrator" : "Driver");
    $("acctAdmin").style.display = profile.role === "admin" ? "" : "none";
    $("emptyAdminBtn").style.display = profile.role === "admin" ? "" : "none";
    if (profile.role === "admin") $("emptyMsg").textContent = "Your company has no routes yet. Add some from the Admin screen.";

    subscribeRoutes();
    configureRuns(user, profile);
    initVehicleCheck({ db, user, profile, companyId: session.companyId });     // v18: also sends sheets kept on this phone
    if (profile.role === "admin") {
      initAdmin({ db, auth, user, profile, companyId: session.companyId, company: session.company, openDriver, signOutAndReset });
      showAdmin();
    } else {
      openDriver();
    }
  } catch (e) {
    console.error(e);
    setView("auth");
    $("authMsg").textContent = friendlyError(e);
  }
}

/* push the current raw route docs (+ the company operator fallback) to the driver view and the admin screens */
function pushRoutes() {
  const op = session.company && session.company.operator;
  const fresh = {};
  Object.keys(session.rawRoutes).forEach((id) => { fresh[id] = docToRoute(id, session.rawRoutes[id], op); });
  window.RoundTracker.setRoutes(fresh);
}

function subscribeRoutes() {
  session.rawRoutes = {};
  session.routesReady = new Promise((res) => { session.routesLoaded = res; });
  session.unsubRoutes = onSnapshot(
    collection(db, "companies", session.companyId, "routes"),
    (snap) => {
      const raw = {};
      snap.docs.forEach((d) => { raw[d.id] = d.data(); });
      session.rawRoutes = raw;
      pushRoutes();
      if (session.routesLoaded) { session.routesLoaded(); session.routesLoaded = null; }
      welcomeRefresh();
      onRoutesChanged(raw);
    },
    (err) => { console.error(err); toast("Could not load routes: " + friendlyError(err), true); }
  );
  session.vehicles = {};
  session.unsubVehicles = onSnapshot(
    collection(db, "companies", session.companyId, "vehicles"),
    (snap) => {
      const raw = {};
      snap.docs.forEach((d) => { raw[d.id] = Object.assign({ id: d.id }, d.data()); });
      session.vehicles = raw;
      if (session.vehicleId && raw[session.vehicleId]) storeVehicle(raw[session.vehicleId]);   // v15: a plan vehicle restored before the list arrived
      onVehiclesChanged(raw);
      welcomeRefresh();
    },
    (err) => { console.warn("vehicles listener:", err && err.code); }
  );
  // live company doc: the operator details can change while a driver has the app open
  session.unsubCompany = onSnapshot(
    doc(db, "companies", session.companyId),
    (cs) => {
      if (!cs.exists()) return;
      session.company = cs.data();
      pushRoutes();
      welcomeRefresh();
      onCompanyChanged(session.company);
    },
    (err) => { console.warn("company listener:", err && err.code); }
  );
}

/* ---------- "Finish & submit run": hands the driver view a function that writes companies/{cid}/runs/{id} ---------- */
const RUN_TIMEOUT_MS = 12000;
function configureRuns(user, profile) {
  const cid = session.companyId;
  const driverName = String(profile.name || (user.email || "").split("@")[0] || "Driver").slice(0, 120);   // users/{uid}.name
  window.RoundTracker.configureRuns({
    uid: user.uid, companyId: cid,
    // v15: the duty day (05:00 → 05:00 London) - the one helper, from services.js
    dutyDay: (at) => dutyDay(at),
    // v15: a route was submitted -> today's plan on the driver's account remembers it
    onDone: (ids) => { if (session.plan && session.plan.day === dutyDay()) savePlan({ ...session.plan, done: ids }); },
    // v15: is the duty day over (05:00 passed) while a run is being submitted? then don't move on to the next job
    dayOver: () => { checkDutyDay(); return session.dayOver; },
    // v15: the run finished / Sat-Nav ended: a new duty day that was waiting can start now
    onIdle: () => { if (session.dayOver) checkDutyDay(); },
    // v18: every run of today submitted -> the pink end-of-duty defect report
    onAllDone: () => promptEndOfDuty(true),
    newRunId: () => doc(collection(db, "companies", cid, "runs")).id,           // Firestore auto id, kept for retries
    async submit(id, run) {
      if (navigator.onLine === false) { const e = new Error("offline"); e.code = "offline"; throw e; }
      const ref = doc(db, "companies", cid, "runs", id);
      const data = {
        routeId: String(run.routeId), routeName: String(run.routeName || "").slice(0, 200), session: String(run.session || "").slice(0, 10),
        driverUid: user.uid, driverName,
        startedAt: Timestamp.fromMillis(run.startedAt || Date.now()), submittedAt: serverTimestamp(),
        // Alighting is no longer tracked. The alighted fields are always written as 0 and are never shown anywhere:
        // the published firestore.rules still REQUIRE totalAlighted and unscheduledAlighted on every run (and old runs have
        // per-stop "alighted"), so dropping them would need Keith to re-publish the rules. Keep writing 0.
        totalBoarded: run.totalBoarded, totalAlighted: 0,
        unscheduledBoarded: run.unscheduledBoarded, unscheduledAlighted: 0,
        stops: run.stops.map((s) => ({ index: s.index, name: String(s.name || "").slice(0, 120), boarded: s.boarded, alighted: 0 }))
      };
      // v9: optional vehicle registration (only when the driver picked one on the welcome screen)
      if (run.vehicleReg) data.vehicleReg = String(run.vehicleReg).slice(0, 20);
      // v16: optional incidents flagged during the run (<= 20)
      const incidents = runIncidents(run.incidents);
      if (incidents.length) data.incidents = incidents;
      const write = (d) => Promise.race([
        setDoc(ref, d),
        new Promise((_, rej) => setTimeout(() => { const e = new Error("timed out"); e.code = "timeout"; rej(e); }, RUN_TIMEOUT_MS))
      ]);
      try {
        await write(data);
      } catch (e) {
        if (!(e && e.code === "permission-denied")) throw e;
        // A retry of a write that actually did reach the server earlier is rejected (runs are write-once):
        // if our own run is already there, that is a success, not an error.
        try { const s = await getDoc(ref); if (s.exists() && s.data().driverUid === user.uid) return; } catch (e2) { /* fall through */ }
        // v16: the published rules may not know `incidents` yet -> save the run without them (never lose the run);
        // the driver view keeps the incidents on the phone and tells the driver.
        if (!data.incidents) throw e;
        const { incidents: _dropped, ...noInc } = data;
        await write(noInc);
        console.info("Run saved without its incidents - the published Firestore rules don't accept them yet");
        return { incidentsDropped: true };
      }
    }
  });
}

/* v16: incidents as stored on the run document */
const INC_TYPES = ["passenger", "road", "other"];
function runIncidents(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((x) => {
    const o = {
      at: Timestamp.fromMillis(+x.at || Date.now()),
      type: INC_TYPES.includes(x.type) ? x.type : "other",
      note: String(x.note || "").slice(0, 1000),
      cctv: !!x.cctv
    };
    if (typeof x.lat === "number" && typeof x.lng === "number") { o.lat = x.lat; o.lng = x.lng; }
    if (typeof x.stopIndex === "number" && x.stopIndex >= 0) { o.stopIndex = x.stopIndex | 0; o.stopName = String(x.stopName || "").slice(0, 120); }
    return o;
  });
}

function teardown() {
  stopDefectLists();
  if (session.unsubRoutes) { session.unsubRoutes(); session.unsubRoutes = null; }
  if (session.unsubCompany) { session.unsubCompany(); session.unsubCompany = null; }
  if (session.unsubVehicles) { session.unsubVehicles(); session.unsubVehicles = null; }
}

/* ---------- what the driver is doing today: a SET of service type x session picks + the chosen schools/colleges (v11)
   filters the route list to their union. Stored by encodeSel ("all" = every route). ---------- */
const svcKey = () => "rt_svc_" + session.companyId;
function lastPick() {
  let v = null;
  try { v = sessionStorage.getItem(svcKey()); } catch (e) { /* private mode */ }
  if (v === null) { try { v = localStorage.getItem(svcKey()); } catch (e) { /* ignore */ } }
  return decodeSel(v);                       // { picks, dests }, {all:true}, or null = never chosen / unreadable
}
function storePick(sel) {
  // null / {all} = every route; otherwise kind+slots (v12) or legacy picks+dests
  session.pick = (!sel || sel.all) ? null : sel;
  const v = encodeSel(session.pick);
  try { sessionStorage.setItem(svcKey(), v); localStorage.setItem(svcKey(), v); } catch (e) { /* ignore */ }
  pushService();
}
const vehKey = () => "rt_veh_" + session.companyId;
function lastVehicleId() {
  let v = null;
  try { v = localStorage.getItem(vehKey()); } catch (e) { /* ignore */ }
  return v && session.vehicles[v] ? v : null;
}
function storeVehicle(vOrId) {
  const v = vOrId && typeof vOrId === "object" ? vOrId : (vOrId && session.vehicles[vOrId]) || null;
  session.vehicleId = v && v.id ? v.id : null;
  try { if (session.vehicleId) localStorage.setItem(vehKey(), session.vehicleId); else localStorage.removeItem(vehKey()); } catch (e) { /* ignore */ }
  if (window.RoundTracker.setVehicle) {
    window.RoundTracker.setVehicle(v && v.reg ? { id: v.id, reg: v.reg, dims: vehicleDims(v) } : null);
  }
}

function pushService() {
  if (!window.RoundTracker.setService) return;
  const sel = session.pick || null, picks = picksFromSel(sel);
  window.RoundTracker.setService({
    label: selLabel(sel, Object.values(session.rawRoutes || {})),
    match: sel ? (r) => selMatches(r, sel) : null,
    // v13: open the first route of the day in canonical order (School AM first …)
    rank: (r) => routeRank(r, sel),
    // v14: "Next: College AM – <route>" after a submit
    slotLabel: (r) => routeSlotLabel(r, sel),
    // drawer tabs for the picks: schools|AM -> schools-am …; "no set time" and Other -> the Other tab
    tabs: picks && picks.length ? picks.map((p) => (p.type === "other" || p.sess === "none" ? "other" : p.type + "-" + p.sess.toLowerCase())) : null,
    onChange: () => openDriver({ fresh: true })          // v15 "Change today's jobs": always the picker
  });
}

/* ---------- v15: today's plan (picks + vehicle + submitted routes) for the duty day, on the driver's account ----------
   companies/{cid}/dayPlans/{uid}_{YYYY-MM-DD}, cached on the phone (planCacheKey). If the account copy can't be read or
   written (offline, or the v15 rules not published yet) the app carries on with the phone copy - no error for the driver. */
const PLAN_READ_TIMEOUT_MS = 4000;
const planRef = (day) => doc(db, "companies", session.companyId, "dayPlans", planDocId(session.user.uid, day));
function readPlanCache(day) {
  try { return cleanPlan(JSON.parse(localStorage.getItem(planCacheKey(session.companyId, session.user.uid)) || "null"), session.user.uid, day); }
  catch (e) { return null; }
}
function writePlanCache(p) {
  try { localStorage.setItem(planCacheKey(session.companyId, session.user.uid), JSON.stringify(p)); } catch (e) { /* ignore */ }
}
async function loadPlan(day) {
  const local = readPlanCache(day);
  let remote = null;
  try {
    const snap = await Promise.race([
      getDoc(planRef(day)),
      new Promise((_, rej) => setTimeout(() => { const e = new Error("timed out"); e.code = "timeout"; rej(e); }, PLAN_READ_TIMEOUT_MS))
    ]);
    if (snap.exists()) remote = cleanPlan(snap.data(), session.user.uid, day);
  } catch (e) {
    console.info("Today's plan: account copy not available (" + ((e && e.code) || e) + ") - using this phone's copy");
  }
  return mergePlans(remote, local);
}
function savePlan(p) {
  session.plan = p;
  writePlanCache(p);
  const day = p.day, first = session.planWrittenDay !== day;
  session.planWrittenDay = day;
  setDoc(planRef(day), { ...planDoc(p), updatedAt: serverTimestamp() })
    .then(() => { if (first) return deleteDoc(planRef(prevDutyDay(day))).catch(() => {}); })   // yesterday's plan isn't needed any more
    .catch((e) => console.info("Today's plan not saved to your account (" + ((e && e.code) || e) + ") - kept on this phone"));
}
function applyPlan(plan) {
  session.plan = plan; session.planDay = plan.day; session.dayOver = false;
  writePlanCache(plan);
  window.RoundTracker.setDoneToday && window.RoundTracker.setDoneToday(plan.done || []);
  storePick(decodeSel(plan.sel));
  const v = plan.vehicleId ? (session.vehicles[plan.vehicleId] || { id: plan.vehicleId, reg: plan.vehicleReg || "" }) : null;
  storeVehicle(v);
  return vehicleGate(false).then(showDriverView);
}
/* the duty day has changed (05:00 London) while the app is open: new picks - but never in the middle of a run */
function checkDutyDay() {
  if (!session.user || !session.planDay) return;
  const day = dutyDay();
  if (day === session.planDay) { session.dayOver = false; return; }
  session.dayOver = true;
  if (!document.body.classList.contains("view-driver")) return;       // admin screens / picker: next time the driver view shows
  if (window.RoundTracker.runInProgress && window.RoundTracker.runInProgress()) return;   // waits for onIdle
  session.dayOver = false; session.plan = null; session.planDay = null;
  try { localStorage.removeItem(planCacheKey(session.companyId, session.user.uid)); } catch (e) { /* ignore */ }
  toast("A new day has started – choose today’s jobs.");
  openDriver({ fresh: true });
}
setInterval(checkDutyDay, 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkDutyDay(); });

export async function openDriver(opts) {
  const fresh = !!(opts && opts.fresh);
  const day = dutyDay();
  if (!fresh && session.user) {
    // v15: a plan for today already (this phone, another phone, before a reload) -> straight to the driver view
    const plan = await loadPlan(day);
    if (plan) { await applyPlan(plan); return; }
  }
  return runWelcome({
    name: welcomeName(session.user && session.user.displayName, session.profile && session.profile.name, session.user && session.user.email),
    company: session.company && session.company.name,
    getTypes: () => session.company && session.company.serviceTypes,
    getRoutes: () => Object.values(session.rawRoutes || {}),
    getVehicles: () => Object.values(session.vehicles || {}).sort((a, b) => String(a.reg || "").localeCompare(String(b.reg || ""))),
    routesReady: session.routesReady,
    last: lastPick(),
    lastVehicleId: lastVehicleId(),
    onPick: storePick,
    onVehicle: storeVehicle
  }).then(async () => {
    // Re-push the welcome pick into the driver view (setVehicle is harmless if nothing was picked).
    storeVehicle(session.vehicleId);
    await vehicleGate(true);                 // v19: "Do you need to do a first use check?" -> the white pre-drive sheet
    if (session.user) {
      const pday = dutyDay();
      const prev = (session.plan && session.plan.day === pday) ? session.plan : readPlanCache(pday);
      const v = session.vehicleId ? session.vehicles[session.vehicleId] : null;
      const plan = { uid: session.user.uid, day: pday, sel: encodeSel(session.pick),
        done: [...new Set([...((prev && prev.done) || []), ...((window.RoundTracker.doneToday && window.RoundTracker.doneToday()) || [])])] };
      if (session.vehicleId) { plan.vehicleId = session.vehicleId; if (v && v.reg) plan.vehicleReg = String(v.reg).slice(0, 20); }
      session.planDay = pday; session.dayOver = false;
      savePlan(plan);                        // "Change today's jobs" overwrites picks + vehicle; submitted runs stay done
    }
    showDriverView();
  });
}

/* ---------- v18: vehicle sheets (white pre-drive check / pink end-of-duty defect report) ---------- */
function currentVehicle() {
  if (!session.vehicleId) return null;
  const v = session.vehicles[session.vehicleId];
  return { id: session.vehicleId, reg: String((v && v.reg) || (session.plan && session.plan.vehicleReg) || "").slice(0, 20) };
}
/* picked: true right after the vehicle tap on the welcome screen (always ask, showing "Already checked today at hh:mm" when done);
   false when today's plan is restored (reload / another phone): only ask if the driver hasn't answered for this vehicle yet */
async function vehicleGate(picked) {
  const v = currentVehicle();
  if (!v || !session.user) return;                       // no vehicle picked (or the company has no vehicles): nothing to ask
  const day = dutyDay();
  if (!picked && saidNoToday(day, v)) return;
  const done = await predriveInfo(day, v);
  if (!picked && done) return;
  const ans = await askFirstUse({ vehicle: v, done });
  if (ans === "yes") await openPredrive({ vehicle: v, day });
  else rememberNoCheck(day, v);
}
const fleetList = () => Object.values(session.vehicles || {}).filter((x) => x && x.reg)
  .map((x) => ({ id: x.id, reg: String(x.reg).slice(0, 20) })).sort((a, b) => a.reg.localeCompare(b.reg));
let allDoneWaiting = false, endPromptedDay = null;
function showDriverView() {
  setView("driver");
  window.RoundTracker.show();
  if (allDoneWaiting) { allDoneWaiting = false; promptEndOfDuty(true); }
}
async function promptEndOfDuty(auto) {
  const day = dutyDay();
  if (auto) {
    if (!document.body.classList.contains("view-driver") || isSheetOpen()) { allDoneWaiting = true; return; }
    const v = currentVehicle();
    if (!v || endPromptedDay === day) return;            // once per app session; the drawer / all-done card can open it again
    endPromptedDay = day;
    if (await endOfDutyDone(day, v)) return;
    if (isSheetOpen() || !document.body.classList.contains("view-driver")) return;
    return openEndOfDuty({ vehicle: v, day, vehicles: fleetList() });
  }
  if (isSheetOpen()) return;
  return openEndOfDuty({ vehicle: currentVehicle(), day, vehicles: fleetList() });
}

async function signOutAndReset() {
  teardown();
  try { await signOut(auth); } catch (e) { /* ignore */ }
  // Clear the on-device Firestore cache so nothing from this company stays behind on a shared phone.
  try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) { /* ignore */ }
  location.reload();
}
$("acctSignOut").addEventListener("click", signOutAndReset);
$("orphanOut").addEventListener("click", signOutAndReset);
$("orphanRetry").addEventListener("click", () => auth.currentUser && startSession(auth.currentUser));
$("acctAdmin").addEventListener("click", () => { $("scrim").click(); showAdmin(); });
$("acctDefect").addEventListener("click", () => { $("scrim").click(); promptEndOfDuty(false); });
$("allDoneDefect").addEventListener("click", () => promptEndOfDuty(false));
$("emptyAdminBtn").addEventListener("click", showAdmin);

/* ---------- sign in / register forms ---------- */
function wireAuthForms() {
  const msg = (t, ok) => { const m = $("authMsg"); m.textContent = t || ""; m.className = "form-msg" + (ok ? " ok" : ""); };
  const tab = (reg) => {
    $("segSignIn").classList.toggle("active", !reg);
    $("segRegister").classList.toggle("active", reg);
    $("signInForm").style.display = reg ? "none" : "";
    $("registerForm").style.display = reg ? "" : "none";
    msg("");
  };
  wireServicePick("rgSvc", () => msg(""));
  $("segSignIn").addEventListener("click", () => tab(false));
  $("segRegister").addEventListener("click", () => tab(true));

  $("signInForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    msg(""); $("siBtn").disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $("siEmail").value.trim(), $("siPass").value);
    } catch (e) { msg(friendlyError(e)); }
    $("siBtn").disabled = false;
  });

  $("forgotBtn").addEventListener("click", async () => {
    const email = $("siEmail").value.trim();
    if (!email) { msg("Type your email address above first, then tap “Forgot password?”."); return; }
    try { await sendPasswordResetEmail(auth, email); msg("If that email has an account, a password-reset link is on its way.", true); }
    catch (e) { msg(friendlyError(e)); }
  });

  $("registerForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    msg(""); $("rgBtn").disabled = true;
    const companyName = $("rgCompany").value.trim(), email = $("rgEmail").value.trim(), pass = $("rgPass").value;
    const name = $("rgName").value.trim();
    if (!companyName) { msg("Please enter your company name."); $("rgBtn").disabled = false; return; }
    const serviceTypes = pickedServiceTypes(readServicePick("rgSvc"));
    if (!serviceTypes) { msg("Please choose what you operate (Schools, Colleges, Rail, Other – or All)."); $("rgBtn").disabled = false; return; }
    registering = true;
    let cred = null;
    try {
      cred = await createUserWithEmailAndPassword(auth, email, pass);
      const uid = cred.user.uid;
      const companyRef = doc(collection(db, "companies"));
      const batch = writeBatch(db);
      const makeBatch = (withTypes) => {
        const batch = writeBatch(db);
        const co = { name: companyName, ownerUid: uid, createdAt: serverTimestamp() };
        if (withTypes) co.serviceTypes = serviceTypes;
        batch.set(companyRef, co);
        batch.set(doc(db, "users", uid), {
          companyId: companyRef.id, role: "admin", name: name || email.split("@")[0], email, createdAt: serverTimestamp()
        });
        return batch;
      };
      try {
        await makeBatch(true).commit();
      } catch (e) {
        // The live rules may be older than v8 (Keith has not published them yet): they refuse the new
        // serviceTypes field. Register anyway without it (= all four); it can be set later once the rules are live.
        if (!(e && e.code === "permission-denied")) throw e;
        console.warn("serviceTypes refused by the security rules - registering without it (publish the v8 firestore.rules)");
        await makeBatch(false).commit();
      }
      registering = false;
      await startSession(cred.user);
    } catch (e) {
      registering = false;
      console.error(e);
      msg(friendlyError(e));
      if (cred) { try { await cred.user.delete(); } catch (e2) { try { await signOut(auth); } catch (e3) { /* ignore */ } } }
    }
    $("rgBtn").disabled = false;
  });
}

