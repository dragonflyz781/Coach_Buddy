/* v21: messages - pure logic (no Firebase / DOM; unit-tested in tests/msgcore.test.mjs).
   companies/{cid}/messages/{id}
     { thread: 'all' (broadcast) | <driverUid>, fromUid, fromName, fromRole: 'admin'|'driver', text, at, readBy: { uid: time } } */
export const MSG_MAX = 1000;
export const cleanText = (t) => String(t == null ? "" : t).replace(/\r\n?/g, "\n").trim().slice(0, MSG_MAX);
const toMs = (t) => (!t ? 0 : typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : typeof t.seconds === "number" ? t.seconds * 1000 : 0);
export function normMsg(id, d) {
  d = d || {};
  return { id, thread: String(d.thread || ""), fromUid: String(d.fromUid || ""), fromName: String(d.fromName || ""),
    fromRole: d.fromRole === "driver" ? "driver" : "admin", text: String(d.text || ""), at: toMs(d.at) || Date.now() + 1e12,
    pendingAt: !toMs(d.at), readBy: d.readBy && typeof d.readBy === "object" ? d.readBy : {} };
}
export const byTime = (a, b) => a.at - b.at || a.id.localeCompare(b.id);
/* a receipt counts as soon as the key exists (a just-written server time reads back as null until it is confirmed) */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const isRead = (m, uid) => m.fromUid === uid || has(m.readBy, uid);
/* a driver: messages from the office not read yet (broadcasts + their thread) */
export const driverUnread = (msgs, uid) => msgs.filter((m) => m.fromRole === "admin" && (m.thread === "all" || m.thread === uid) && !isRead(m, uid)).sort(byTime);
/* admin: driver replies not read by this admin */
export const adminUnread = (msgs, adminUid) => msgs.filter((m) => m.fromRole === "driver" && !isRead(m, adminUid));
/* admin thread list: 'all' (broadcasts) + one per driver (with or without messages), newest activity first */
export function threadList(msgs, drivers, adminUid) {
  const t = { all: { id: "all", name: "All drivers", msgs: [], unread: 0, last: 0 } };
  (drivers || []).forEach((u) => { t[u.uid] = { id: u.uid, name: u.name || u.email || "Driver", msgs: [], unread: 0, last: 0 }; });
  msgs.forEach((m) => {
    const k = m.thread;
    if (!t[k]) t[k] = { id: k, name: m.fromRole === "driver" ? m.fromName : "Driver", msgs: [], unread: 0, last: 0 };
    t[k].msgs.push(m); t[k].last = Math.max(t[k].last, m.at);
    if (m.fromRole === "driver" && !isRead(m, adminUid)) t[k].unread++;
  });
  Object.values(t).forEach((x) => x.msgs.sort(byTime));
  const all = t.all; delete t.all;
  return [all].concat(Object.values(t).sort((a, b) => (b.unread - a.unread) || (b.last - a.last) || a.name.localeCompare(b.name)));
}
/* who has read an office message: names of the drivers it went to that have a read receipt */
export function readers(m, drivers) {
  const to = m.thread === "all" ? (drivers || []) : (drivers || []).filter((u) => u.uid === m.thread);
  const read = to.filter((u) => has(m.readBy, u.uid)).map((u) => u.name || u.email);
  return { read, of: to.length, unread: to.filter((u) => !has(m.readBy, u.uid)).map((u) => u.name || u.email) };
}
export function readLabel(m, drivers) {
  const r = readers(m, drivers);
  if (!r.of) return "";
  if (m.thread !== "all") return r.read.length ? "✓✓ Read" : "✓ Sent";
  return r.read.length === r.of ? "✓✓ Read by everyone (" + r.of + ")" : "Read by " + r.read.length + " of " + r.of + (r.read.length ? ": " + r.read.join(", ") : "");
}
export function londonTime(ms, withDate) {
  const o = { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (withDate) Object.assign(o, { day: "2-digit", month: "2-digit", year: "numeric" });
  return new Intl.DateTimeFormat("en-GB", o).format(new Date(ms)).replace(",", "");
}
