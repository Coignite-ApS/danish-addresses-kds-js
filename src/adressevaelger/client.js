/**
 * Adressevælger API client (Klimadatastyrelsen — DAWA replacement).
 * Pure, isomorphic (browser + Node 18+), no DOM. All knowledge of the HTTP API lives here.
 *
 *   const client = createClient({ token });
 *   await client.search({ resource: 'accessAddresses', street: 'Akseltorv', municipalityCode: '621' });
 *   await client.lookupById(id);            // resolve a DAR id -> normalized address (probes type)
 *
 * Verified live (2026-06): token required; CORS open; kommuneKode filters in BOTH `tekst` and
 * `vejnavn` modes; multiple municipalities = comma (pipe -> HTTP 400); maksimum cap 200.
 */
import { normKommuneList, clamp, utm32ToWgs84 } from "./util.js";
import { kommuneNavn } from "./kommuner.js";

const DEFAULT_BASE = "https://adressevaelger.dk";

export function createClient(opts = {}) {
  // `apiUrl` is the official KDS component's name for the host; accept it as an alias for baseUrl.
  const baseUrl = (opts.baseUrl || opts.apiUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const token = opts.token;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const onRequest = opts.onRequest; // optional (redactedUrl) => void, for debugging
  if (!token) throw new Error("createClient: missing token");
  if (!fetchImpl) throw new Error("createClient: no fetch available (pass opts.fetch on old Node)");

  function url(path, params) {
    const u = new URL(baseUrl + path);
    u.searchParams.set("token", token);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    }
    return u;
  }

  async function getJson(u) {
    if (onRequest) onRequest(u.toString().replace(/token=[^&]*/, "token=***"));
    const r = await fetchImpl(u);
    if (!r.ok) throw new Error(`Adressevælger ${r.status}: ${await r.text()}`);
    return r.json();
  }

  /**
   * Search. `resource` is 'adresser' (full addresses incl. floor/door) or 'husnumre' (access addresses).
   * Provide EITHER `tekst` (free-text) OR `vejnavn` (structured; required for husnummer/postnummer/etage/doer).
   * Returns the raw `fund[]` rows (minimal: id, type, titel, ...).
   */
  // English option names are canonical; the Danish API names are accepted as aliases (KDS-doc parity).
  // resource: 'addresses' (full addresses, incl. floor/door) | 'accessAddresses' (house numbers).
  async function search(o = {}) {
    const resource = o.resource === "accessAddresses" || o.resource === "husnumre" ? "husnumre" : "adresser";
    const maxResults = o.maxResults ?? o.maksimum;
    const params = {
      tekst: o.text ?? o.tekst,
      vejnavn: o.street ?? o.vejnavn,
      husnummer: o.houseNumber ?? o.husnummer,
      postnummer: o.postalCode ?? o.postnummer, // NB: API wants postnummer, NOT postnr
      etage: o.floor ?? o.etage,
      doer: o.door ?? o.doer, // NB: API wants doer, NOT dør
      kommuneKode: normKommuneList(o.municipalityCode ?? o.kommuneKode ?? o.kommunekode) || undefined,
      maksimum: maxResults != null ? clamp(maxResults, 1, 200) : undefined,
      medtagForeloebige: ((o.includeProvisional ?? o.medtagForeloebige) ?? true) ? "true" : undefined, // default ON (KDS excludes provisional otherwise)
    };
    const json = await getJson(url(`/${resource}/soeg`, params));
    return json.fund || [];
  }

  const resourceForType = (t) => (t === "husnummer" || t === "adgangsadresse" ? "husnumre" : "adresser");

  /** Look up one id at an explicit resource; returns a normalized address, or null on 404 (wrong type). */
  async function lookupAt(resource, id) {
    const u = url(`/${resource}/${encodeURIComponent(id)}`, {});
    if (onRequest) onRequest(u.toString().replace(/token=[^&]*/, "token=***"));
    const r = await fetchImpl(u);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Adressevælger ${resource}/${id} ${r.status}: ${await r.text()}`);
    return mapAddress(await r.json());
  }

  /**
   * Resolve a DAR id to a full normalized address. Pass `{ type }` if known
   * ('adresse'|'husnummer'|'adgangsadresse'); otherwise the type is probed (adresser then husnumre).
   */
  async function lookupById(id, { type } = {}) {
    if (type) return lookupAt(resourceForType(type), id);
    return (await lookupAt("adresser", id)) || (await lookupAt("husnumre", id));
  }

  return { search, lookupById, resolve: (id) => lookupById(id), baseUrl, url };
}

/**
 * Map an id-lookup response (nested DAR) to a flat, normalized address object.
 * `/adresser/{id}` wraps `{ adresse: { husnummer: {...} } }`; `/husnumre/{id}` is the husnummer directly.
 */
export function mapAddress(resp) {
  const isAdr = resp.adresse !== undefined;
  const a = resp.adresse || null;
  const h = isAdr ? a.husnummer : resp.husnummer;
  const kd = (h && h.navngivenvejkommunedel) || {};
  const k = (h && h.adgangspunkt && h.adgangspunkt.koordinater) || null;
  const municipality_code = kd.kommune != null ? parseInt(kd.kommune, 10) : null; // "0561" -> 561
  return {
    id: isAdr ? a.id_lokalid : h.id_lokalid,
    type: isAdr ? "adresse" : "adgangsadresse",
    address: isAdr ? a.adressebetegnelse : h.adgangsadressebetegnelse,
    street: h.vejnavn,
    house_number: h.husnummertekst,
    floor: isAdr ? a.etagebetegnelse : null,
    door: isAdr ? a.doerbetegnelse : null,
    zip: h.postnummer?.postnr ?? null,
    city: h.postnummer?.navn ?? null,
    subcity: h.supplerendebynavn?.navn ?? null,
    municipality_code,
    municipality_name: kommuneNavn(municipality_code),
    way_code: kd.vejkode != null ? parseInt(kd.vejkode, 10) : null,
    position: k ? { type: "Point", coordinates: utm32ToWgs84(k.x, k.y) } : null,
  };
}
