/* v18: vehicle defect sheets for the office.
     admin       - "Vehicle defects" tab: every white (pre-drive) and pink (end-of-duty) sheet, newest first, filters, the full sheet with
                   the signature, mark rectified, CSV.
     maintenance - their whole app: only sheets with a defect (open first) and "Mark rectified". Nil sheets stay admin-only (rules). */
import { doc, collection, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { $, esc, toast, setView, friendlyError, toggleTheme } from "./ui.js?v=16";
import { CHECK_ITEMS, ITEM_LABEL, KIND_LABEL, STATUS_LABEL, normDefect, filterDefects, sortForMaintenance, byNewest, defectLines,
  buildDefectCsv, ukDate, londonIsoDate, londonDateTime } from "./defects.js?v=18";

const RULES_MSG = "Vehicle defects can’t be loaded yet – publish the updated Firestore rules (firestore-rules-paste-into-firebase.txt) in the Firebase console.";

/* one list (admin tab or maintenance screen) */
function makeList(ctx, opt) {
  // opt: { mode: 'admin'|'maint', mount: Element, onOpenCount?: fn(n) }
  const S = { all: [], open: new Set(), show: opt.mode === "admin" ? "" : "open", veh: "", unsub: null, err: "" };
  const m = opt.mount, isAdmin = opt.mode === "admin";
  const showOpts = isAdmin
    ? [["", "All sheets"], ["defects", "Defects only"], ["open", "Open defects"], ["rectified", "Rectified"], ["nil", "Nil defects"]]
    : [["open", "Open defects"], ["rectified", "Rectified"], ["defects", "All defects"]];
  m.innerHTML = '<div class="card wide dfx-card-top"><h2>' + (isAdmin ? "Vehicle defects" : "Defects to fix") + "</h2>" +
    '<p class="muted">' + (isAdmin
      ? "Drivers fill in the white <b>pre-drive check</b> when they take a vehicle out and the pink <b>defect report</b> at the end of their duty. Every sheet arrives here; sheets with a defect also go to your maintenance login."
      : "Defects reported by drivers on their pre-drive checks and end-of-duty reports. Mark each one rectified when it is fixed.") + "</p>" +
    '<div class="run-filters"><label>Show<select class="dfx-show">' + showOpts.map(([v, t]) => '<option value="' + v + '">' + t + "</option>").join("") + "</select></label>" +
    '<label>Vehicle<select class="dfx-veh"><option value="">All vehicles</option></select></label></div>' +
    '<div class="run-actions"><div class="run-summary dfx-summary" role="status">Loading…</div>' +
    (isAdmin ? '<button class="btn small primary dfx-csv" type="button">⬇ Download CSV</button>' : "") + "</div></div>" +
    '<div class="dfx-list"></div>';
  const q = (s) => m.querySelector(s);
  q(".dfx-show").value = S.show;
  q(".dfx-show").addEventListener("change", (e) => { S.show = e.target.value; render(); });
  q(".dfx-veh").addEventListener("change", (e) => { S.veh = e.target.value; render(); });
  if (q(".dfx-csv")) q(".dfx-csv").addEventListener("click", () => {
    const rows = filterDefects(S.all, S.show, S.veh);
    if (!rows.length) { toast("Nothing to download with these filters."); return; }
    const blob = new Blob(["\ufeff" + buildDefectCsv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "vehicle-defects-" + londonIsoDate() + ".csv";
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  const col = collection(ctx.db, "companies", ctx.companyId, "defects");
  const qy = isAdmin ? query(col, orderBy("createdAt", "desc"), limit(500)) : query(col, where("hasDefect", "==", true));
  S.unsub = onSnapshot(qy, (snap) => {
    S.err = "";
    S.all = snap.docs.map((d) => normDefect(d.id, d.data()));
    S.all = isAdmin ? S.all.sort(byNewest) : sortForMaintenance(S.all);
    render();
  }, (err) => {
    console.warn("Vehicle defects not readable:", err && err.code);
    S.err = err && err.code === "permission-denied" ? RULES_MSG : "Could not load vehicle defects: " + friendlyError(err);
    S.all = []; render();
  });

  function vehicleOptions() {
    const sel = q(".dfx-veh"), regs = [...new Set(S.all.map((r) => r.vehicleReg).filter(Boolean))].sort();
    if (S.veh && !regs.includes(S.veh)) regs.push(S.veh);
    sel.innerHTML = '<option value="">All vehicles</option>' + regs.map((r) => '<option value="' + esc(r) + '">' + esc(r) + "</option>").join("");
    sel.value = S.veh;
  }
  function render() {
    vehicleOptions();
    const nOpen = S.all.filter((r) => r.status === "open").length;
    if (opt.onOpenCount) opt.onOpenCount(nOpen);
    const rows = filterDefects(S.all, S.show, S.veh);
    q(".dfx-summary").innerHTML = S.err ? '<span class="dfx-err">' + esc(S.err) + "</span>"
      : "<b>" + rows.length + "</b> " + (rows.length === 1 ? "sheet" : "sheets") + " · <b>" + nOpen + "</b> open " + (nOpen === 1 ? "defect" : "defects");
    const list = q(".dfx-list");
    if (!rows.length) { list.innerHTML = S.err ? "" : '<div class="empty-note muted">' + (S.all.length ? "No sheets match these filters." : isAdmin ? "No vehicle sheets yet." : "No defects reported. 👍") + "</div>"; return; }
    list.innerHTML = rows.map(card).join("");
  }
  function card(r) {
    const isOpen = S.open.has(r.id), lines = defectLines(r);
    const head = '<div class="dfx-head" data-act="toggle" role="button" tabindex="0" aria-expanded="' + isOpen + '">' +
      '<div class="dfx-l1"><span class="dfx-kind ' + r.kind + '">' + (r.kind === "predrive" ? "White · " : "Pink · ") + esc(KIND_LABEL[r.kind]) + "</span>" +
      '<span class="dfx-status ' + r.status + '">' + esc(STATUS_LABEL[r.status]) + "</span></div>" +
      '<div class="dfx-l2"><b class="dfx-reg">' + esc(r.vehicleReg || "—") + "</b> · " + esc(r.driverName || "Driver") + " · " + esc(ukDate(r.dutyDay)) +
      (r.createdAt ? ' <span class="muted">(' + esc(londonDateTime(r.createdAt)) + ")</span>" : "") + "</div>" +
      (lines.length ? '<div class="dfx-l3">' + esc(lines.join(" · ")) + "</div>" : "") + "</div>";
    return '<div class="dfx-item ' + r.status + '" data-def-id="' + esc(r.id) + '">' + head + (isOpen ? detail(r, lines) : "") + "</div>";
  }
  function detail(r, lines) {
    let h = '<div class="dfx-detail">';
    h += '<div class="dfx-meta"><span>Date <b>' + esc(ukDate(r.dutyDay)) + "</b></span><span>Name <b>" + esc(r.driverName) + "</b></span><span>Full reg. <b>" + esc(r.vehicleReg) + "</b></span>" +
      (r.dutyNo ? "<span>Duty no. <b>" + esc(r.dutyNo) + "</b></span>" : "") +
      (r.kind === "predrive" ? "<span>Mileage <b>" + (r.mileage === null ? "—" : r.mileage.toLocaleString("en-GB")) + "</b></span>"
        : (r.startMileage !== null ? "<span>Start mileage <b>" + r.startMileage.toLocaleString("en-GB") + "</b></span>" : "") +
          "<span>End mileage <b>" + (r.endMileage === null ? "—" : r.endMileage.toLocaleString("en-GB")) + "</b>" +
          (r.startMileage !== null && r.endMileage !== null && r.endMileage < r.startMileage ? ' <span class="dfx-warn">lower than start</span>' : "") + "</span>") + "</div>";
    if (r.kind === "predrive") {
      h += '<table class="run-table dfx-items"><thead><tr><th>Check</th><th class="n">Result</th></tr></thead><tbody>' +
        CHECK_ITEMS.map((it) => {
          const v = r.items[it.key];
          return "<tr" + (v === "x" ? ' class="x"' : "") + "><td>" + esc(ITEM_LABEL[it.key]) + (v === "x" && r.notes[it.key] ? '<div class="dfx-note">' + esc(r.notes[it.key]) + "</div>" : "") +
            '</td><td class="n">' + (v === "ok" ? "✓" : v === "x" ? "✗" : v === "na" ? "N/A" : "—") + "</td></tr>";
        }).join("") + "</tbody></table>";
    } else {
      h += '<div class="dfx-lines">' + (r.nil ? '<div class="dfx-nil">NIL defects</div>' : r.defects.map((d, i) => '<div class="dfx-line"><b>' + (i + 1) + ".</b> " + esc(d) + "</div>").join("")) + "</div>";
      h += '<div class="dfx-sig"><span class="muted">Signed</span>' + (r.signature ? '<img class="dfx-sig-img" alt="Driver signature" src="' + esc(r.signature) + '">'
        : r.signedName ? '<span class="dfx-typed">' + esc(r.signedName) + "</span>" : " —") + "</div>";
    }
    if (r.status === "rectified") {
      h += '<div class="dfx-rect done">✔ Defect rectified by <b>' + esc(r.rectifiedBy) + "</b>" + (r.rectifiedOn ? " on " + esc(ukDate(r.rectifiedOn)) : "") +
        (r.rectifiedNote ? '<div class="dfx-note">' + esc(r.rectifiedNote) + "</div>" : "") + "</div>";
    } else if (r.status === "open") {
      const me = String((ctx.profile && ctx.profile.name) || "").slice(0, 120);
      h += '<form class="dfx-rect" data-act="rectify" autocomplete="off"><div class="dfx-rect-t">Defect rectified</div><div class="grid3">' +
        '<label>By<input type="text" name="by" maxlength="120" required value="' + esc(me) + '"></label>' +
        '<label>Date<input type="date" name="on" required value="' + londonIsoDate() + '"></label>' +
        '<label>Note <span class="muted">(optional)</span><input type="text" name="note" maxlength="500" placeholder="e.g. Mirror glass replaced"></label></div>' +
        '<button class="btn primary small" type="submit">✔ Mark rectified</button><span class="dfx-rect-msg" role="status"></span></form>';
    }
    if (isAdmin) h += '<div class="dfx-tools"><button class="btn small danger" type="button" data-act="delete">Delete sheet</button></div>';
    return h + "</div>";
  }
  m.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-act]"); if (!t) return;
    const item = t.closest(".dfx-item"), id = item && item.dataset.defId; if (!id) return;
    if (t.dataset.act === "toggle") { S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); }
    else if (t.dataset.act === "delete") {
      if (!confirm("Delete this vehicle sheet? This can’t be undone.")) return;
      try { await deleteDoc(doc(col, id)); toast("Sheet deleted."); } catch (e) { toast(friendlyError(e), true); }
    }
  });
  m.addEventListener("keydown", (ev) => {
    const t = ev.target.closest('[data-act="toggle"]');
    if (t && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); t.click(); }
  });
  m.addEventListener("submit", async (ev) => {
    const f = ev.target.closest('form[data-act="rectify"]'); if (!f) return;
    ev.preventDefault();
    const id = f.closest(".dfx-item").dataset.defId, by = f.by.value.trim(), on = f.on.value, note = f.note.value.trim();
    const msg = f.querySelector(".dfx-rect-msg");
    if (!by || !/^\d{4}-\d{2}-\d{2}$/.test(on)) { msg.textContent = "Enter who fixed it and the date."; return; }
    const upd = { status: "rectified", rectifiedBy: by.slice(0, 120), rectifiedOn: on, rectifiedAt: serverTimestamp(), rectifiedUid: ctx.user.uid };
    if (note) upd.rectifiedNote = note.slice(0, 500);
    f.querySelector("button").disabled = true; msg.textContent = "Saving…";
    try { await updateDoc(doc(col, id), upd); toast("Marked rectified ✔"); }
    catch (e) {
      f.querySelector("button").disabled = false;
      msg.textContent = e && e.code === "permission-denied" ? "Not allowed – it may already be rectified, or the Firestore rules need updating." : friendlyError(e);
    }
  });
  return { stop: () => { if (S.unsub) S.unsub(); S.unsub = null; } };
}

/* ---------------------------------------------------------------- admin tab */
let adminList = null;
export function initAdminDefects(ctx) {
  if (adminList) adminList.stop();
  adminList = makeList(ctx, { mode: "admin", mount: $("admDefectsBody"), onOpenCount: (n) => {
    const b = $("admDefectsCount"); if (!b) return;
    b.textContent = n ? String(n) : ""; b.style.display = n ? "" : "none";
  } });
}

/* ---------------------------------------------------------------- maintenance login */
let maintList = null, maintWired = false;
export function showMaintenance(ctx) {
  // ctx: { db, user, profile, companyId, company, signOutAndReset }
  $("maintCompany").textContent = (ctx.company && ctx.company.name) || "Vehicle defects";
  $("maintWho").textContent = (ctx.profile.name || ctx.user.email) + " · Maintenance";
  if (!maintWired) {
    maintWired = true;
    $("maintSignOut").addEventListener("click", () => ctx.signOutAndReset());
    $("maintTheme").addEventListener("click", toggleTheme);
  }
  if (maintList) maintList.stop();
  maintList = makeList(ctx, { mode: "maint", mount: $("maintBody") });
  setView("maint");
}
export function stopDefectLists() {
  if (adminList) { adminList.stop(); adminList = null; }
  if (maintList) { maintList.stop(); maintList = null; }
}
