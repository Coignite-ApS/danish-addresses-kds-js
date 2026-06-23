/** Pure, dependency-free helpers shared by the client and the autocomplete controller. */

/**
 * Danish kommune codes are 3-digit but the Adressevælger API requires 4-digit zero-padded
 * ("561" -> "0561"). Strip non-digits + leading zeros, then pad to 4. Empty -> ''.
 */
export function normKommune(v) {
  const d = String(v == null ? "" : v).replace(/\D/g, "").replace(/^0+/, "");
  return d ? d.padStart(4, "0") : "";
}

/**
 * Normalize one or many municipality codes into the API's comma-joined 4-digit form.
 * Accepts a single value, an array, or a comma/pipe/space-separated string.
 * NB: the API rejects DAWA's pipe "|" (HTTP 400) — we always emit commas, which it accepts and unions.
 *   normKommuneList('561')                 -> '0561'
 *   normKommuneList(['661','665'])          -> '0661,0665'
 *   normKommuneList('661|665')              -> '0661,0665'
 *   normKommuneList('')                     -> ''
 */
export function normKommuneList(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,|\s]+/);
  return parts.map(normKommune).filter(Boolean).join(",");
}

/** Clamp a number into [lo, hi], defaulting non-numbers to lo. */
export function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Split a full titel into the identifying head and the trailing ", {zip} {town}".
 * "Rudholmvej 4, Søhale, 6715 Esbjerg N" -> { head:"Rudholmvej 4, Søhale", zip:"6715", city:"Esbjerg N" }
 * No trailing district -> { head: titel, zip:null, city:null }.
 */
export function parseTail(titel) {
  const m = String(titel == null ? "" : titel).match(/^(.*),\s*(\d{4})\s+([^,]+)$/);
  return m ? { head: m[1], zip: m[2], city: m[3] } : { head: String(titel || ""), zip: null, city: null };
}

/**
 * Normalize messy user address input so the (format-strict) API matches it. Live testing showed the
 * service fails on glued tokens — `Vej87` (0 hits), `87, 5th` (floor/door ignored) — while `Vej 87`
 * and `87, 5 th` work. We therefore:
 *   - insert a space between a letter and a following digit:  "Vej87" -> "Vej 87"
 *   - split a glued floor+door and lowercase the door:        "5th"/"5.th"/"5TH" -> "5 th"
 *   - normalize dotted door forms:                            "t.h." -> "th", "t.v." -> "tv"
 *   - lowercase bare door tokens, collapse whitespace
 * House letters ("2A") are preserved (digit+single-letter is not a door).
 */
const DOORS = "th|tv|mf";
export function normalizeQuery(s) {
  let t = String(s == null ? "" : s);
  t = t.replace(/\bt\.?\s*h\.?\b/gi, "th").replace(/\bt\.?\s*v\.?\b/gi, "tv").replace(/\bm\.?\s*f\.?\b/gi, "mf");
  t = t.replace(/(\p{L})(\d)/gu, "$1 $2");                                  // letter|digit  (street|house)
  t = t.replace(new RegExp(`\\b(\\d{1,3}|st|kl)\\.?\\s*(${DOORS})\\b`, "gi"), // floor|door  ("5th" -> "5 th")
    (_m, a, b) => `${a} ${b.toLowerCase()}`);
  t = t.replace(new RegExp(`\\b(${DOORS})\\b`, "gi"), (m) => m.toLowerCase()); // lowercase bare door
  return t.replace(/\s+/g, " ").trim().replace(/[.,\s]+$/, ""); // drop trailing punctuation ("…th." -> "…th")
}

/**
 * Best-effort parse of a typed address into components, after normalization.
 * House number = the LAST token shaped like `12`/`12A` that is not the first token (so leading-number
 * street names like "5. Junivej" aren't mistaken for a house). Floor = digit/`st`/`kl`; door = th/tv/mf.
 *   "Edvard Thomsens Vej 87, 5th" -> { street:"Edvard Thomsens Vej", houseNumber:"87", floor:"5", door:"th" }
 *   "Akseltorv"                   -> { street:"Akseltorv", houseNumber:null, floor:null, door:null }
 */
export function parseAddress(input) {
  const toks = normalizeQuery(input).split(/[\s,]+/).filter(Boolean);
  // house number = FIRST number-shaped token after the street (index >= 1), so a numeric floor ("…87, 5 th")
  // isn't mistaken for the house, and leading-number street names ("5. Junivej") aren't either.
  let hi = -1;
  for (let i = 1; i < toks.length; i++) {
    if (/^\d{1,3}[a-zæøå]?$/i.test(toks[i])) { hi = i; break; }
  }
  if (hi < 0) return { street: toks.join(" "), houseNumber: null, floor: null, door: null };
  let floor = null, door = null;
  for (const tk of toks.slice(hi + 1)) {
    const v = tk.replace(/\.$/, "").toLowerCase();
    if (floor === null && /^(\d{1,3}|st|kl)$/.test(v)) floor = v;
    else if (door === null && /^(th|tv|mf)$/.test(v)) door = v;
  }
  return { street: toks.slice(0, hi).join(" "), houseNumber: toks[hi], floor, door };
}

/**
 * EPSG:25832 (ETRS89 / UTM32N, metres) -> WGS84 [lon, lat]. Pure JS, no imports.
 * Adressevælger coordinates are in 25832 — there is no WGS84 output mode. Accurate to ~1 mm.
 */
export function utm32ToWgs84(E, N) {
  const a = 6378137.0, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const lon0 = (9 * Math.PI) / 180, x = E - 500000, M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 = mu + (3 * e1 / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const ep2 = e2 / (1 - e2), C1 = ep2 * Math.cos(phi1) ** 2, T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5);
  const D = x / (N1 * k0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
  return [+(lon * 180 / Math.PI).toFixed(8), +(lat * 180 / Math.PI).toFixed(8)];
}
