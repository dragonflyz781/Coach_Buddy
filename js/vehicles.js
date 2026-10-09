/* Company vehicles (v9) - pure helpers. Units: height/length/width in metres, weight in tonnes.
   companies/{cid}/vehicles/{id}: { reg (required), height?, length?, width?, weight?, createdAt?, updatedAt?, updatedBy? } */
export const VEH_LIMITS = { reg: 20, height: 10, length: 30, width: 5, weight: 100 };

export function normReg(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, VEH_LIMITS.reg);
}
/* empty / blank / NaN -> omit; otherwise a positive number capped at the field's max (or null if invalid for a required check) */
export function parseDim(raw, max) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > max) return { ok: false, value: null };
  return { ok: true, value: Math.round(n * 1000) / 1000 };
}
export function validateVehicle(raw) {
  const reg = normReg(raw && raw.reg);
  if (!reg) return "Registration (number plate) is required.";
  if (reg.length > VEH_LIMITS.reg) return "Registration is longer than " + VEH_LIMITS.reg + " characters.";
  for (const [k, max, label] of [["height", VEH_LIMITS.height, "Height"], ["length", VEH_LIMITS.length, "Length"], ["width", VEH_LIMITS.width, "Width"], ["weight", VEH_LIMITS.weight, "Weight"]]) {
    const p = parseDim(raw && raw[k], max);
    if (!p.ok) return label + " must be a number between 0 and " + max + (k === "weight" ? " tonnes." : " metres.");
  }
  return null;
}
export function cleanVehicle(raw) {
  const out = { reg: normReg(raw && raw.reg) };
  [["height", VEH_LIMITS.height], ["length", VEH_LIMITS.length], ["width", VEH_LIMITS.width], ["weight", VEH_LIMITS.weight]].forEach(([k, max]) => {
    const p = parseDim(raw && raw[k], max);
    if (p.ok && p.value !== undefined) out[k] = p.value;
  });
  return out;
}
export function vehicleDims(v) {
  if (!v) return "";
  const bits = [];
  if (v.height != null) bits.push(v.height + " m H");
  if (v.length != null) bits.push(v.length + " m L");
  if (v.width != null) bits.push(v.width + " m W");
  if (v.weight != null) bits.push(v.weight + " t");
  return bits.join(" · ");
}
