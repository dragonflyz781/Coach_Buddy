export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
export function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast" + (isErr ? " err" : ""); }, isErr ? 6000 : 3200);
}

/* view: boot | setup | auth | orphan | welcome | admin | editor | driver */
export function setView(name) {
  document.body.className = document.body.className.replace(/\bview-\S+/g, "").trim() + " view-" + name;
}

export function friendlyError(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/missing-password": "Please enter a password.",
    "auth/weak-password": "Password is too weak - use at least 6 characters.",
    "auth/email-already-in-use": "There is already an account with that email address.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
    "auth/network-request-failed": "Can't reach the server - check your internet connection.",
    "auth/operation-not-allowed": "Email/password sign-in isn't switched on in your Firebase project (Authentication -> Sign-in method).",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "Can't reach the server - check your internet connection."
  };
  return map[code] || (e && e.message) || "Something went wrong.";
}

/* Theme toggle that shares the driver app's saved preference (localStorage 'rt_theme'). */
export function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : cur === "light" ? null :
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
  if (next) document.documentElement.setAttribute("data-theme", next); else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("rt_theme", next || ""); } catch (e) { /* ignore */ }
}

/* ---------- v8: "What do you operate?" chips with an "All" convenience box (register + Operator details) ---------- */
export function readServicePick(name) {
  return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map((i) => i.value).filter((v) => v !== "all");
}
export function setServicePick(name, types) {
  const set = new Set(types || []);
  document.querySelectorAll('input[name="' + name + '"]').forEach((i) => { if (i.value !== "all") i.checked = set.has(i.value); });
  syncAllBox(name);
}
function syncAllBox(name) {
  const boxes = Array.from(document.querySelectorAll('input[name="' + name + '"]'));
  const all = boxes.find((i) => i.value === "all");
  if (all) all.checked = boxes.filter((i) => i !== all).every((i) => i.checked);
}
export function wireServicePick(name, onChange) {
  document.querySelectorAll('input[name="' + name + '"]').forEach((box) => box.addEventListener("change", () => {
    if (box.value === "all") document.querySelectorAll('input[name="' + name + '"]').forEach((i) => { i.checked = box.checked; });
    else syncAllBox(name);
    if (onChange) onChange();
  }));
}
