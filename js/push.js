/* v25: real push notifications (Firebase Cloud Messaging, web push).
   - "Turn on phone notifications" asks for permission (one tap = one user gesture), registers the push
     service worker (firebase-messaging-sw.js, next to index.html - so it works under /Coach_Buddy/ on GitHub
     Pages), gets this device's FCM token and stores it at companies/{cid}/pushTokens/{uid}_{hash}.
   - The Cloud Functions (functions/) send a push when the office creates / changes / removes your duty, or
     sends you (or everyone) a message; a driver's reply goes to the admins.
   - Tapping the notification opens the app at that duty or message (?open=duty&day=… / ?open=msg&thread=…,
     or a message to an already open app).
   Nothing here runs until the user taps the button once; after that the token is refreshed quietly on every open. */
import { doc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { app, isEmulator } from "./firebase-init.js?v=16";
import { vapidKey } from "./push-config.js?v=25";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js";
const SW_FILE = "firebase-messaging-sw.js";
const P = { c: null, state: "off", msg: "", busy: false, tokenId: null, openHandler: null, pending: null };
const onKey = (uid) => "rt_push_on_" + uid;
const $ = (id) => document.getElementById(id);

export const pushKeySet = () => !!vapidKey && !String(vapidKey).startsWith("PASTE");
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;

/* what this browser can do: "ok" | "ios-install" (iPhone/iPad in Safari: add to Home Screen first) | "unsupported" */
export function pushSupport() {
  const has = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
  if (isIOS() && !isStandalone()) return "ios-install";
  return has ? "ok" : "unsupported";
}

async function sha(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* the service worker sits next to index.html: register it relative to the page, scope = this folder */
export async function registerPushWorker() {
  const base = new URL("./", location.href);
  return navigator.serviceWorker.register(new URL(SW_FILE, base).pathname, { scope: base.pathname });
}

async function saveToken(token) {
  const c = P.c; if (!c || !token) return;
  const id = c.user.uid + "_" + (await sha(token));
  await setDoc(doc(c.db, "companies", c.companyId, "pushTokens", id),
    { uid: c.user.uid, token, ua: String(navigator.userAgent || "").slice(0, 300), updatedAt: serverTimestamp() });
  P.tokenId = id;
  try { localStorage.setItem(onKey(c.user.uid), id); } catch (e) { /* ignore */ }
}

async function fetchToken() {
  const m = await import(SDK);
  if (!(await m.isSupported())) throw Object.assign(new Error("unsupported"), { code: "push/unsupported" });
  const reg = await registerPushWorker();
  await navigator.serviceWorker.ready;
  return m.getToken(m.getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
}

/* ctx: { db, user, profile, companyId } - drivers and admins (maintenance gets no pushes) */
export function initPush(c) {
  P.c = c; P.msg = "";
  let id = null; try { id = localStorage.getItem(onKey(c.user.uid)); } catch (e) { /* ignore */ }
  P.tokenId = id;
  P.state = id && "Notification" in window && Notification.permission === "granted" ? "on" : "off";
  if ("Notification" in window && Notification.permission === "denied") P.state = "blocked";
  render();
  // quietly refresh the token (it can change) - only when this user turned push on before on this device
  if (P.state === "on" && pushKeySet() && pushSupport() === "ok" && !isEmulator) {
    fetchToken().then(async (t) => { if (t && P.c === c) { const old = P.tokenId; await saveToken(t); if (old && old !== P.tokenId) removeTokenDoc(old); } })
      .catch((e) => console.warn("Push token refresh failed", e && (e.code || e.message)));
  }
}

export async function enablePush() {
  if (!P.c || P.busy) return;
  const sup = pushSupport();
  if (sup === "ios-install") return say("ios", "On iPhone: tap Share ⬆ then 'Add to Home Screen', open Coach Buddy from your home screen and tap this button again (needs iOS 16.4 or later).");
  if (sup === "unsupported") return say("off", "This browser can't receive phone notifications. Try Chrome on Android, or Safari from the Home Screen on iPhone.");
  if (!pushKeySet()) return say("off", "Phone notifications aren't set up yet – the office still has to add the Web Push key. The in-app alerts keep working.");
  P.busy = true; say(P.state, "Turning on…");
  try {
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") { P.busy = false; return say(perm === "denied" ? "blocked" : "off", perm === "denied" ? "Notifications are blocked for this site. Allow them in your phone or browser settings, then try again." : "Not turned on – you can try again any time."); }
    const t = await fetchToken();
    if (!t) throw new Error("no token");
    await saveToken(t);
    P.busy = false; say("on", "Phone notifications are on ✔ You'll get duty changes and messages even when the app is closed.");
  } catch (e) {
    console.warn("Push enable failed", e);
    P.busy = false;
    say("off", e && e.code === "permission-denied" ? "Couldn't save this phone (the latest Firestore rules aren't published yet)." : "Couldn't turn on phone notifications (" + ((e && (e.code || e.message)) || "error") + ").");
  }
}

async function removeTokenDoc(id) {
  const c = P.c; if (!c || !id) return;
  try { await deleteDoc(doc(c.db, "companies", c.companyId, "pushTokens", id)); } catch (e) { /* ignore */ }
}

export async function disablePush() {
  const c = P.c; if (!c) return;
  const id = P.tokenId;
  try { localStorage.removeItem(onKey(c.user.uid)); } catch (e) { /* ignore */ }
  P.tokenId = null;
  await removeTokenDoc(id);
  try { if (!isEmulator && pushKeySet()) { const m = await import(SDK); await m.deleteToken(m.getMessaging(app)); } } catch (e) { /* ignore */ }
  say("off", "Phone notifications are off on this device.");
}

/* sign out: this device must stop getting the previous user's pushes (best effort, max 3 s) */
export async function pushSignOut() {
  const c = P.c, id = P.tokenId;
  if (!c || !id) return;
  try { localStorage.removeItem(onKey(c.user.uid)); } catch (e) { /* ignore */ }
  await Promise.race([removeTokenDoc(id), new Promise((r) => setTimeout(r, 3000))]);
  P.c = null; P.tokenId = null;
}
export function stopPush() { P.c = null; P.tokenId = null; P.state = "off"; P.msg = ""; render(); }

function say(state, msg) { P.state = state; P.msg = msg || ""; render(); }

/* the button + status line; any element with [data-push-cta] is kept in sync (drawer, My duties, Messages, admin) */
export function pushCtaHtml(extraClass) {
  return '<div class="push-cta ' + (extraClass || "") + '" data-push-cta>' + ctaInner() + "</div>";
}
function ctaInner() {
  const on = P.state === "on";
  return (on
    ? '<span class="push-on">🔔 Phone notifications on</span> <button type="button" class="btn small push-off" data-push-off>Turn off</button>'
    : '<button type="button" class="btn primary push-btn" data-push-on' + (P.busy ? " disabled" : "") + ">🔔 Turn on phone notifications</button>") +
    (P.msg ? '<div class="push-msg' + (on ? " ok" : "") + '" role="status">' + P.msg.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])) + "</div>" : "");
}
function render() {
  document.querySelectorAll("[data-push-cta]").forEach((el) => {
    el.innerHTML = ctaInner();
    el.classList.toggle("is-on", P.state === "on");
    el.style.display = P.c ? "" : "none";
  });
}
export const refreshPushCta = render;
export const pushState = () => P.state;

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-push-on]")) { e.preventDefault(); enablePush(); }
  else if (e.target.closest("[data-push-off]")) { e.preventDefault(); disablePush(); }
});

/* ---- opening the app from a notification ---- */
export function readPushLink(search) {
  const q = new URLSearchParams(search || location.search);
  const open = q.get("open");
  if (open !== "duty" && open !== "msg") return null;
  const day = q.get("day") || "";
  return { open, day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "", thread: (q.get("thread") || "").slice(0, 128) };
}
/* main.js calls this once the session is ready; links that arrived earlier are kept until then */
export function onPushOpen(fn) {
  P.openHandler = fn;
  if (P.pending) { const p = P.pending; P.pending = null; fn(p); }
}
function deliver(p) {
  if (!p) return;
  if (P.openHandler && P.c) P.openHandler(p); else P.pending = p;
}
const first = readPushLink();
if (first) {
  P.pending = first;
  // tidy the address bar so a reload doesn't reopen it
  try { const u = new URL(location.href); ["open", "day", "thread"].forEach((k) => u.searchParams.delete(k)); history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* ignore */ }
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "rt-push-open") deliver(readPushLink("?open=" + encodeURIComponent(d.open || "") + "&day=" + encodeURIComponent(d.day || "") + "&thread=" + encodeURIComponent(d.thread || "")));
  });
}
if (isEmulator) window.__mcPush = { saveToken, sha, registerPushWorker, deliver, state: () => ({ ...P, c: !!P.c }), say };
