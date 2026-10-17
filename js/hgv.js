/* v26: lorry / coach-aware routing for the Sat-Nav - calls the hgvRoute Cloud Function (europe-west2), which asks
   TomTom for a truck route that respects the picked vehicle's height, width, length and weight.
   driver-app.js gets it through RoundTracker.setRouter(route) and falls back to OSRM on any error.
   Emulator / e2e: window.__mcHgv.setMock(fn | "fail" | null) replaces the function call. */
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import { app, isEmulator } from "./firebase-init.js?v=16";

export const HGV_REGION = "europe-west2";
const TIMEOUT_MS = 15000;
let callable = null, mock = null, calls = 0;
const memo = new Map();          // this session: same points + same vehicle -> no second call

function fn() {
  if (callable) return callable;
  const f = getFunctions(app, HGV_REGION);
  if (isEmulator) { try { connectFunctionsEmulator(f, "127.0.0.1", 5001); } catch (e) { /* already connected */ } }
  callable = httpsCallable(f, "hgvRoute", { timeout: TIMEOUT_MS });
  return callable;
}
const keyOf = (points, v) => JSON.stringify([points.map((p) => [Math.round(p[0] * 1e5), Math.round(p[1] * 1e5)]), v.heightM || 0, v.widthM || 0, v.lengthM || 0, v.weightKg || 0]);

/* points [[lat,lng]...] (in order), vehicle {heightM,widthM,lengthM,weightKg} -> { coords, distance, duration, instructions, hgv } */
export async function hgvRoute(points, vehicle) {
  const k = keyOf(points, vehicle);
  if (memo.has(k)) return memo.get(k);
  calls++;
  let res;
  if (mock) {
    if (mock === "fail") throw Object.assign(new Error("Lorry routing unavailable (test)"), { code: "functions/unavailable" });
    res = await mock(points, vehicle);
  } else {
    if (!app) throw new Error("Not signed in");
    res = (await fn()({ points: points.map((p) => [p[0], p[1]]), vehicle })).data;
  }
  if (!res || !Array.isArray(res.coords) || res.coords.length < 2) throw new Error("No lorry route");
  memo.set(k, res);
  if (memo.size > 30) memo.delete(memo.keys().next().value);
  return res;
}

export function initHgv() {
  if (window.RoundTracker && window.RoundTracker.setRouter) window.RoundTracker.setRouter(hgvRoute);
  if (isEmulator) window.__mcHgv = { setMock: (m) => { mock = m || null; memo.clear(); }, calls: () => calls };
}
