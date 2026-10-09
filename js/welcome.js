/* Welcome screen after sign-in, before the driver view.
   v12:
     step "kind"     – single pick: Schools and Colleges | Rail | All
     step "slots"    – dropdown-style multi-selects per session slot
                       (School AM, College AM, School PM, College PM, and/or Rail AM/PM).
                       Each lists destinations for that type×session; "None" = not doing it.
                       Continue when ≥1 destination is chosen across the menus.
     step "vehicle"  – company vehicles when present
   Filtering is the union of chosen slot destinations. "Same as last time" applies a remembered set. */
import { $, setView } from "./ui.js?v=16";
import {
  KIND_KEYS, KIND_LABEL, SLOT_LABEL, availableSlots, slotDestOptions,
  selFromSlots, selLabel, destKey, serviceIcon
} from "./services.js?v=16";
import { vehicleDims } from "./vehicles.js?v=16";

export const WELCOME_AFTER_PICK_MS = 650;
export const WELCOME_MAX_WAIT_MS = 6000;
let cur = null;

export function runWelcome(opts) {
  if (cur) cur.cancel();
  return new Promise((resolve) => {
    const st = {
      step: "kind", kind: null, slots: {}, openSlot: null,
      chosen: null, vehicleId: null, picked: false, loaded: false, done: false, timers: []
    };
    const me = {
      cancel() { st.done = true; st.timers.forEach(clearTimeout); },
      refresh() { if (!st.picked) render(); }
    };
    cur = me;
    const finish = () => {
      if (st.done) return;
      st.done = true; st.timers.forEach(clearTimeout);
      if (cur === me) cur = null;
      resolve();
    };
    const routes = () => opts.getRoutes() || [];
    const vehicles = () => (opts.getVehicles ? opts.getVehicles() : []) || [];
    const needsVehicle = () => vehicles().length > 0;
    const expandLegacy = (slots) => {
      const out = {};
      Object.keys(slots || {}).forEach((k) => {
        const v = slots[k];
        if (v && v.length === 1 && v[0] === "*") {
          out[k] = slotDestOptions(routes(), k).map((o) => o.key);
        } else out[k] = (v || []).slice();
      });
      return out;
    };
    const currentSel = () => selFromSlots(st.kind, st.slots);
    const chosenCount = () => Object.values(st.slots).reduce((n, a) => n + ((a && a.length) || 0), 0);

    $("wlHello").textContent = opts.name ? "Welcome, " + opts.name : "Welcome";
    $("wlCompany").textContent = opts.company || "";

    function button(cls, text, count, attrs) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "wl-chip " + cls;
      if (typeof text === "string") b.appendChild(document.createTextNode(text));
      else b.appendChild(text);
      if (count !== undefined && count !== null) {
        const c = document.createElement("span"); c.className = "wl-count"; c.textContent = count; b.appendChild(c);
      }
      Object.keys(attrs || {}).forEach((k) => b.setAttribute(k, attrs[k]));
      return b;
    }
    function status(text, busy) {
      $("wlStatusTxt").textContent = text;
      $("wlStatus").classList.toggle("busy", !!busy);
    }
    function goToVehicleOrDone(sel) {
      st.chosen = sel;
      opts.onPick(sel);
      if (needsVehicle()) {
        st.step = "vehicle"; st.vehicleId = null; render();
      } else {
        opts.onVehicle && opts.onVehicle(null);
        confirmDone(null, true);
      }
    }
    function confirmDone(btn, immediate) {
      st.picked = true;
      $("wlChips").querySelectorAll(".wl-chip").forEach((c) => {
        if (btn) c.classList.toggle("active", c === btn);
        if (c !== btn) c.disabled = true;
      });
      $("wlBack").style.display = "none"; $("wlLast").style.display = "none";
      const go = $("wlGo");
      const v = st.vehicleId && vehicles().find((x) => x.id === st.vehicleId);
      const label = selLabel(st.chosen, routes()) + (v ? " · " + v.reg : "");
      go.style.display = ""; go.disabled = false; go.textContent = "Continue – " + label;
      go.onclick = finish;
      status("Ready – " + label, true);
      const later = () => st.timers.push(setTimeout(finish, immediate ? 0 : WELCOME_AFTER_PICK_MS));
      if (st.loaded) later();
      else { status("Loading your routes…", true); st.timers.push(setTimeout(finish, WELCOME_MAX_WAIT_MS)); st.afterLoad = later; }
    }

    function render() {
      const chips = $("wlChips"), q = $("wlPickQ"), back = $("wlBack"), last = $("wlLast"), go = $("wlGo");
      chips.innerHTML = ""; go.style.display = "none"; go.disabled = false; last.style.display = "none";
      $("wlPick").style.display = ""; $("wlPick").dataset.step = st.step;
      const list = routes(), vehs = vehicles();

      if (st.step === "kind") {
        back.style.display = "none";
        q.textContent = "What are you doing today?";
        KIND_KEYS.forEach((k) => {
          const b = button("kind" + (st.kind === k ? " active" : ""), KIND_LABEL[k], null, { "data-kind": k, "aria-pressed": st.kind === k ? "true" : "false" });
          b.addEventListener("click", () => {
            st.kind = k; st.slots = {}; st.openSlot = null; st.step = "slots"; render();
          });
          chips.appendChild(b);
        });
        const L = opts.last;
        if (L && st.loaded) {
          let keep = null;
          if (L.all) keep = null;
          else if (L.slots) {
            const slots = expandLegacy(L.slots);
            const avail = new Set(availableSlots(list, L.kind || "all"));
            const cleaned = {};
            Object.keys(slots).forEach((slot) => {
              if (!avail.has(slot)) return;
              const keys = slots[slot].filter((dk) => slotDestOptions(list, slot).some((o) => o.key === dk));
              if (keys.length) cleaned[slot] = keys;
            });
            keep = Object.keys(cleaned).length ? { kind: L.kind || "all", slots: cleaned } : false;
          } else keep = false;
          if (keep !== false) {
            last.style.display = "";
            last.textContent = "↻ Same as last time: " + selLabel(keep, list);
            last.onclick = () => {
              if (keep) { st.kind = keep.kind; st.slots = { ...keep.slots }; }
              goToVehicleOrDone(keep);
            };
          }
        }
        status(st.loaded ? "Pick one to continue" : "Loading your routes…", !st.loaded);
      } else if (st.step === "slots") {
        back.style.display = "";
        back.setAttribute("aria-label", "Back to service type");
        back.onclick = () => { st.step = "kind"; st.openSlot = null; render(); };
        q.textContent = st.kind === "rail" ? "Which rail routes today?"
          : st.kind === "schools_colleges" ? "Choose schools and colleges for each session"
          : "Choose routes for each session";
        const slots = st.loaded ? availableSlots(list, st.kind) : [];
        if (!slots.length && st.loaded) {
          status("No matching routes for " + KIND_LABEL[st.kind] + " yet – you can still continue and add routes in Admin.", false);
          go.style.display = ""; go.disabled = false;
          go.textContent = "Continue – no routes yet";
          go.onclick = () => goToVehicleOrDone(null);
          go.setAttribute("data-empty", "1");
        } else if (!slots.length) {
          status("Loading your routes…", true);
        } else {
          slots.forEach((slot) => {
            const opts = slotDestOptions(list, slot);
            const chosen = st.slots[slot] || [];
            const wrap = document.createElement("div");
            wrap.className = "wl-dd" + (st.openSlot === slot ? " open" : "");
            wrap.dataset.slot = slot;
            const btn = document.createElement("button");
            btn.type = "button"; btn.className = "wl-dd-btn";
            btn.setAttribute("aria-expanded", st.openSlot === slot ? "true" : "false");
            const title = document.createElement("span"); title.className = "wl-dd-title";
            title.textContent = (slot.startsWith("schools") ? "🏫 " : slot.startsWith("colleges") ? "🎓 " : "🚆 ") + (SLOT_LABEL[slot] || slot);
            const val = document.createElement("span"); val.className = "wl-dd-val";
            val.textContent = !chosen.length ? "None" : chosen.length === 1
              ? (opts.find((o) => o.key === chosen[0]) || { label: chosen[0] }).label
              : chosen.length + " selected";
            const chev = document.createElement("span"); chev.className = "wl-dd-chev"; chev.textContent = st.openSlot === slot ? "▴" : "▾";
            btn.appendChild(title); btn.appendChild(val); btn.appendChild(chev);
            btn.addEventListener("click", () => { st.openSlot = st.openSlot === slot ? null : slot; render(); });
            wrap.appendChild(btn);
            if (st.openSlot === slot) {
              const panel = document.createElement("div"); panel.className = "wl-dd-panel"; panel.setAttribute("role", "group");
              const none = document.createElement("button");
              none.type = "button"; none.className = "wl-dd-opt" + (!chosen.length ? " on" : "");
              none.textContent = "None";
              none.addEventListener("click", () => { st.slots[slot] = []; render(); });
              panel.appendChild(none);
              opts.forEach((o) => {
                const on = chosen.includes(o.key);
                const b = document.createElement("button");
                b.type = "button"; b.className = "wl-dd-opt" + (on ? " on" : "");
                b.setAttribute("data-dest", o.key); b.setAttribute("aria-pressed", on ? "true" : "false");
                b.innerHTML = "<span class='wl-dd-check'>" + (on ? "✓" : "") + "</span><span class='wl-dd-name'>" + o.label + "</span>";
                b.addEventListener("click", () => {
                  const set = new Set(st.slots[slot] || []);
                  if (set.has(o.key)) set.delete(o.key); else set.add(o.key);
                  st.slots[slot] = [...set];
                  render();
                });
                panel.appendChild(b);
              });
              wrap.appendChild(panel);
            }
            chips.appendChild(wrap);
          });
          status(st.loaded ? (chosenCount() ? selLabel(currentSel(), list) : "Pick at least one school, college or rail route") : "Loading…", !st.loaded);
          const n = chosenCount();
          go.style.display = "";
          go.disabled = n < 1;
          go.removeAttribute("data-empty");
          go.textContent = n < 1 ? "Continue" : "Continue (" + n + " selected)";
          go.onclick = () => {
            const sel = currentSel();
            if (sel) goToVehicleOrDone(sel);
          };
        }
      } else { // vehicle
        back.style.display = "";
        back.setAttribute("aria-label", "Back");
        back.onclick = () => { st.step = "slots"; st.vehicleId = null; opts.onVehicle && opts.onVehicle(null); render(); };
        q.textContent = "Which vehicle today?";
        const lastId = opts.lastVehicleId;
        vehs.forEach((v) => {
          const wrap = document.createElement("span");
          const reg = document.createElement("span"); reg.className = "veh-reg"; reg.textContent = v.reg || "—";
          wrap.appendChild(reg);
          const d = vehicleDims(v);
          if (d) { const dd = document.createElement("span"); dd.className = "veh-dims"; dd.textContent = d; wrap.appendChild(dd); }
          const b = button("veh" + (v.id === lastId ? " remembered" : ""), wrap, null, { "data-veh": v.id });
          if (v.id === lastId) b.setAttribute("aria-description", "Same as last time");
          b.addEventListener("click", () => {
            st.vehicleId = v.id;
            opts.onVehicle && opts.onVehicle(v);
            confirmDone(b, false);
          });
          chips.appendChild(b);
        });
        status(vehs.length ? "Pick a vehicle to continue" + (lastId && vehs.some((v) => v.id === lastId) ? " (last time is highlighted)" : "") : "No vehicles yet – ask your admin to add one.", false);
      }
    }

    render();
    setView("welcome");
    Promise.resolve(opts.routesReady).then(() => {
      if (st.done) return;
      st.loaded = true;
      if (st.picked) { status("Ready – " + selLabel(st.chosen, routes()), true); if (st.afterLoad) st.afterLoad(); }
      else render();
    });
  });
}
export function welcomeRefresh() { if (cur) cur.refresh(); }
