/* v15: the driver's plan for one duty day (05:00 → 05:00 London), saved to their account and cached on the phone.
   Firestore: companies/{companyId}/dayPlans/{uid}_{YYYY-MM-DD}
     { uid, day, sel (encodeSel string), vehicleId?, vehicleReg?, done: [routeId…], updatedAt }
   localStorage cache: rt_plan_<companyId>_<uid>  (one entry, holds its own day - a different day = no plan). */
export const PLAN_MAX_DONE = 200;
export const planDocId = (uid, day) => uid + "_" + day;
export const planCacheKey = (cid, uid) => "rt_plan_" + cid + "_" + uid;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
/* a clean plan object (or null if it isn't a plan for this uid + day) */
export function cleanPlan(p, uid, day) {
  if (!p || typeof p !== "object") return null;
  if (uid && p.uid !== uid) return null;
  if (day && p.day !== day) return null;
  if (typeof p.sel !== "string") return null;
  const done = Array.isArray(p.done) ? [...new Set(p.done.filter((x) => typeof x === "string" && x && x.length <= 128))].slice(0, PLAN_MAX_DONE) : [];
  const out = { uid: p.uid, day: p.day, sel: str(p.sel, 4000), done };
  if (p.vehicleId) out.vehicleId = str(p.vehicleId, 128);
  if (p.vehicleReg) out.vehicleReg = str(p.vehicleReg, 20);
  return out;
}
/* account copy + phone copy of the same day: the account copy wins for picks / vehicle, done = both together */
export function mergePlans(remote, local) {
  if (!remote) return local || null;
  if (!local) return remote;
  const done = [...new Set([...(remote.done || []), ...(local.done || [])])].slice(0, PLAN_MAX_DONE);
  return { ...remote, done };
}
/* what is written to Firestore (updatedAt is added by the caller as serverTimestamp()) */
export function planDoc(p) {
  const d = { uid: p.uid, day: p.day, sel: str(p.sel, 4000), done: (p.done || []).slice(0, PLAN_MAX_DONE) };
  if (p.vehicleId) d.vehicleId = str(p.vehicleId, 128);
  if (p.vehicleReg) d.vehicleReg = str(p.vehicleReg, 20);
  return d;
}
