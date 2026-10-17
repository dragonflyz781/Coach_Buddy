/* v21: two-way messages between the office and the drivers (realtime listeners in the app; v25: + phone push via functions/).
     companies/{cid}/messages/{id} { thread: 'all' | <driverUid>, fromUid, fromName, fromRole, text, at, readBy: { uid: time } }
   admin  - "Messages" tab: All drivers (broadcasts) + one thread per driver, unread count, who has read each message.
   driver - ✉ button in the top bar (+ a floating 💬 button in Sat-Nav), unread badge, pop-up for a new message (Reply / Got it),
            replies in their own thread. */
import { doc, collection, addDoc, updateDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { $, esc, toast, friendlyError } from "./ui.js?v=16";
import { MSG_MAX, cleanText, normMsg, byTime, driverUnread, adminUnread, threadList, readLabel, readers, londonTime, isRead } from "./msgcore.js?v=21";
import { pushCtaHtml } from "./push.js?v=25";     // v25: phone notifications (Cloud Functions send them, see functions/)

const RULES_MSG = "Messages can’t be loaded yet – publish the updated Firestore rules (firestore-rules-paste-into-firebase.txt) in the Firebase console.";
const col = (c) => collection(c.db, "companies", c.companyId, "messages");
const when = (ms) => {
  const d = new Date(ms), today = londonTime(Date.now(), true).slice(0, 10), dt = londonTime(ms, true);
  return isFinite(d) && ms < Date.now() + 1e11 ? (dt.slice(0, 10) === today ? londonTime(ms) : dt) : "sending…";
};
const fmt = (t) => esc(t).replace(/\n/g, "<br>");
const sentReceipts = new Set();          // one receipt per message per app session
function markRead(c, list) {
  list.forEach((m) => {
    if (isRead(m, c.user.uid) || m.pendingAt || sentReceipts.has(m.id)) return;
    sentReceipts.add(m.id);
    m.readBy = { ...m.readBy, [c.user.uid]: Date.now() };          // optimistic, the listener brings the real one
    updateDoc(doc(col(c), m.id), { ["readBy." + c.user.uid]: serverTimestamp() }).catch((e) => { sentReceipts.delete(m.id); console.warn("read receipt", e && e.code); });
  });
}
async function send(c, thread, role, text) {
  text = cleanText(text);
  if (!text) return false;
  await addDoc(col(c), { thread, fromUid: c.user.uid, fromName: String(c.profile.name || c.user.email || (role === "admin" ? "Office" : "Driver")).slice(0, 120),
    fromRole: role, text, at: serverTimestamp(), readBy: {} });
  return true;
}
function setBadge(el, n) { if (!el) return; el.textContent = n > 9 ? "9+" : String(n || ""); el.hidden = !n; el.style.display = n ? "" : "none"; }

/* ================================================================ admin tab */
const A = { c: null, unsub: null, msgs: [], team: [], sel: "all", err: "", wired: false };
export function initAdminMessages(c) {
  stopAdminMessages();
  A.c = c; A.msgs = []; A.err = "";
  if (!A.wired) wireAdmin();
  A.unsub = onSnapshot(query(col(c), orderBy("at", "desc"), limit(500)), (snap) => {
    A.err = ""; A.msgs = snap.docs.map((d) => normMsg(d.id, d.data())); renderAdmin();
  }, (err) => { console.warn("Messages not readable:", err && err.code); A.err = err && err.code === "permission-denied" ? RULES_MSG : friendlyError(err); renderAdmin(); });
  renderAdmin();
}
export function stopAdminMessages() { if (A.unsub) A.unsub(); A.unsub = null; }
export function setMessageTeam(users) {
  A.team = (users || []).filter((u) => u.role === "driver").map((u) => ({ uid: u.uid, name: u.name || u.email, email: u.email }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  renderAdmin();
}
export function adminMessagesShown() { renderAdmin(); }
/* v25: a tapped push for a driver's reply opens that driver's thread */
export function adminOpenThread(id) { if (id) A.sel = String(id); renderAdmin(); }
const adminVisible = () => { const s = $("admMessages"); return !!s && s.style.display !== "none" && document.body.classList.contains("view-admin") && document.visibilityState === "visible"; };
document.addEventListener("visibilitychange", () => { if (A.c) renderAdmin(); });

function wireAdmin() {
  A.wired = true;
  const m = $("admMessagesBody");
  m.innerHTML = '<div class="card wide"><h2>Messages</h2><p class="muted">Send a message to <b>all drivers</b> or to <b>one driver</b>. Drivers see it in the app straight away (with a pop-up) and can reply. Drivers who turned on <b>phone notifications</b> also get a push when the app is closed; turn them on here to be told about drivers\' replies.</p>' + pushCtaHtml("adm-push") + '</div>' +
    '<div class="msg-admin"><div class="msg-threads" id="msgThreads" role="list"></div>' +
    '<div class="card msg-conv"><div class="msg-conv-head"><h2 id="msgConvTitle">All drivers</h2><span class="muted" id="msgConvSub"></span></div>' +
    '<div class="msg-list" id="msgAdminList" aria-live="polite"></div>' +
    '<form class="msg-compose" id="msgAdminForm"><textarea id="msgAdminText" rows="2" maxlength="' + MSG_MAX + '" placeholder="Type a message…" aria-label="Message"></textarea>' +
    '<button class="btn primary" id="msgAdminSend" type="submit">Send</button></form><div class="form-msg" id="msgAdminMsg"></div></div></div>';
  $("msgThreads").addEventListener("click", (e) => { const b = e.target.closest("[data-thread]"); if (b) { A.sel = b.dataset.thread; renderAdmin(); $("msgAdminText").focus(); } });
  $("msgAdminForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = $("msgAdminText"), btn = $("msgAdminSend");
    if (!cleanText(t.value)) return;
    btn.disabled = true; $("msgAdminMsg").textContent = "";
    try { await send(A.c, A.sel, "admin", t.value); t.value = ""; toast(A.sel === "all" ? "Sent to all drivers ✔" : "Message sent ✔"); }
    catch (err) { $("msgAdminMsg").textContent = err && err.code === "permission-denied" ? RULES_MSG : friendlyError(err); }
    btn.disabled = false;
  });
  $("msgAdminText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("msgAdminForm").requestSubmit(); } });
}
function renderAdmin() {
  if (!A.c || !A.wired) return;
  const uid = A.c.user.uid, threads = threadList(A.msgs, A.team, uid);
  if (!threads.some((t) => t.id === A.sel)) A.sel = "all";
  const unread = adminUnread(A.msgs, uid).length;
  setBadge($("admMessagesCount"), unread);
  $("msgThreads").innerHTML = threads.map((t) => {
    const last = t.msgs[t.msgs.length - 1];
    return '<button type="button" role="listitem" class="msg-thread' + (t.id === A.sel ? " active" : "") + (t.unread ? " unread" : "") + '" data-thread="' + esc(t.id) + '">' +
      '<span class="msg-t-name">' + (t.id === "all" ? "📢 " : "") + esc(t.name) + "</span>" + (t.unread ? '<span class="tab-count">' + t.unread + "</span>" : "") +
      '<span class="msg-t-last">' + (last ? esc((last.fromRole === "driver" ? "" : "You: ") + last.text.slice(0, 60)) : '<i>No messages yet</i>') + "</span></button>";
  }).join("");
  const t = threads.find((x) => x.id === A.sel);
  $("msgConvTitle").textContent = t.id === "all" ? "📢 All drivers" : t.name;
  $("msgConvSub").textContent = t.id === "all" ? A.team.length + " driver" + (A.team.length === 1 ? "" : "s") : "";
  $("msgAdminSend").textContent = t.id === "all" ? "Send to all" : "Send";
  const list = $("msgAdminList");
  if (A.err) list.innerHTML = '<div class="form-msg">' + esc(A.err) + "</div>";
  else if (!t.msgs.length) list.innerHTML = '<p class="muted msg-empty">' + (t.id === "all" ? "No broadcasts yet. Anything you send here goes to every driver." : "No messages with " + esc(t.name) + " yet.") + "</p>";
  else list.innerHTML = t.msgs.map((m) => {
    const mine = m.fromRole === "admin", r = mine ? readers(m, A.team) : null;
    return '<div class="msg-b ' + (mine ? "out" : "in") + '" data-msg="' + esc(m.id) + '"><div class="msg-meta">' + esc(mine ? (m.fromUid === uid ? "You" : m.fromName) : m.fromName) + " · " + esc(when(m.at)) + "</div>" +
      '<div class="msg-text">' + fmt(m.text) + "</div>" +
      (mine ? '<div class="msg-read"' + (r && r.unread.length && m.thread === "all" ? ' title="Not read yet: ' + esc(r.unread.join(", ")) + '"' : "") + ">" + esc(readLabel(m, A.team)) + "</div>" : "") + "</div>";
  }).join("");
  list.scrollTop = list.scrollHeight;
  if (adminVisible()) markRead(A.c, t.msgs.filter((m) => m.fromRole === "driver"));
}

/* ================================================================ driver */
const D = { c: null, unsubs: [], parts: { all: [], mine: [] }, msgs: [], popped: new Set(), popId: null, open: false, wired: false, err: "" };
export function initDriverMessages(c) {
  stopDriverMessages();
  D.c = c; D.parts = { all: [], mine: [] }; D.msgs = []; D.popped = new Set(); D.err = "";
  if (!D.wired) wireDriver();
  ["msgBtn", "acctMsgs"].forEach((id) => { const b = $(id); if (b) b.style.display = ""; });
  document.body.classList.add("has-msgs");
  const listen = (key, q) => onSnapshot(q, (snap) => {
    D.err = ""; D.parts[key] = snap.docs.map((d) => normMsg(d.id, d.data()));
    D.msgs = D.parts.all.concat(D.parts.mine).sort(byTime); renderDriver();
  }, (err) => { console.warn("Messages not readable:", err && err.code); D.err = err && err.code === "permission-denied" ? RULES_MSG : friendlyError(err); renderDriver(); });
  D.unsubs = [listen("all", query(col(c), where("thread", "==", "all"))), listen("mine", query(col(c), where("thread", "==", c.user.uid)))];
}
export function stopDriverMessages() {
  D.unsubs.forEach((u) => u()); D.unsubs = [];
  D.c = null; closePop();
  ["msgBtn", "acctMsgs"].forEach((id) => { const b = $(id); if (b) b.style.display = "none"; });
  document.body.classList.remove("has-msgs");
  if (D.open) closeDriverMessages();
}
function wireDriver() {
  D.wired = true;
  $("msgBtn").addEventListener("click", openDriverMessages);
  $("msgFab").addEventListener("click", openDriverMessages);
  $("acctMsgs").addEventListener("click", () => { $("scrim").click(); openDriverMessages(); });
  $("msgPopReply").addEventListener("click", () => { closePop(); openDriverMessages(); });
  $("msgPopOk").addEventListener("click", () => {
    const m = D.msgs.find((x) => x.id === D.popId);
    if (m && D.c) markRead(D.c, [m]);
    closePop(); renderDriver();
  });
}
function renderDriver() {
  if (!D.c) return;
  const uid = D.c.user.uid, unread = driverUnread(D.msgs, uid);
  ["msgBadge", "msgFabBadge", "acctMsgsBadge"].forEach((id) => setBadge($(id), unread.length));
  if (D.open) { renderDriverSheet(); markRead(D.c, unread); return; }
  // pop-up: the newest unread message not shown yet (one at a time)
  if (D.popId && !unread.some((m) => m.id === D.popId)) closePop();
  if (!D.popId) {
    const next = unread.filter((m) => !D.popped.has(m.id)).pop();
    if (next) showPop(next, unread.length);
  } else $("msgPopMore").textContent = unread.length > 1 ? "+ " + (unread.length - 1) + " more unread" : "";
}
function showPop(m, n) {
  D.popId = m.id; D.popped.add(m.id);
  $("msgPopFrom").textContent = (m.thread === "all" ? "📢 To all drivers · " : "") + (m.fromName || "Office") + " · " + when(m.at);
  $("msgPopText").innerHTML = fmt(m.text);
  $("msgPopMore").textContent = n > 1 ? "+ " + (n - 1) + " more unread" : "";
  $("msgPop").style.display = "flex";
  try { if (navigator.vibrate) navigator.vibrate(150); } catch (e) { /* ignore */ }
}
function closePop() { D.popId = null; const p = $("msgPop"); if (p) p.style.display = "none"; }

export function openDriverMessages() {
  if (!D.c) return;
  closePop(); D.open = true;
  const ov = $("mcOverlay"); ov.dataset.owner = "msgs";
  $("mcSheet").innerHTML = '<div class="mc-head"><h2 id="mcTitle">💬 Messages</h2><button class="icon-btn" id="msgClose" type="button" aria-label="Close">✕</button></div>' +
    pushCtaHtml("msg-push") + '<div class="msg-list drv" id="msgDrvList" aria-live="polite"></div>' +
    '<form class="msg-compose" id="msgDrvForm"><textarea id="msgDrvText" rows="2" maxlength="' + MSG_MAX + '" placeholder="Reply to the office…" aria-label="Reply"></textarea>' +
    '<button class="btn primary" id="msgDrvSend" type="submit">Send</button></form><div class="form-msg" id="msgDrvMsg"></div>';
  ov.setAttribute("aria-labelledby", "mcTitle");
  ov.style.display = "flex";
  $("msgClose").addEventListener("click", closeDriverMessages);
  $("msgDrvForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = $("msgDrvText"), b = $("msgDrvSend");
    if (!cleanText(t.value) || !D.c) return;
    b.disabled = true; $("msgDrvMsg").textContent = "";
    try { await send(D.c, D.c.user.uid, "driver", t.value); t.value = ""; }
    catch (err) { $("msgDrvMsg").textContent = err && err.code === "permission-denied" ? RULES_MSG : friendlyError(err); }
    b.disabled = false;
  });
  renderDriver();
}
export function closeDriverMessages() {
  D.open = false;
  const ov = $("mcOverlay");
  if (ov && ov.dataset.owner === "msgs") { ov.style.display = "none"; $("mcSheet").innerHTML = ""; ov.dataset.owner = ""; }
  renderDriver();
}
function renderDriverSheet() {
  const list = $("msgDrvList"); if (!list) return;
  const uid = D.c.user.uid;
  if (D.err) { list.innerHTML = '<div class="form-msg">' + esc(D.err) + "</div>"; return; }
  if (!D.msgs.length) { list.innerHTML = '<p class="muted msg-empty">No messages yet. Messages from the office appear here, and you can reply.</p>'; return; }
  list.innerHTML = D.msgs.map((m) => {
    const mine = m.fromUid === uid;
    return '<div class="msg-b ' + (mine ? "out" : "in") + (m.thread === "all" ? " bc" : "") + '" data-msg="' + esc(m.id) + '"><div class="msg-meta">' +
      (m.thread === "all" ? "📢 To all drivers · " : "") + esc(mine ? "You" : m.fromName || "Office") + " · " + esc(when(m.at)) + '</div><div class="msg-text">' + fmt(m.text) + "</div></div>";
  }).join("");
  list.scrollTop = list.scrollHeight;
}
