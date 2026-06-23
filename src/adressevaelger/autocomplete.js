/**
 * Headless, framework-agnostic staged address autocomplete (Adressevælger).
 * Ported from the proven demo/AddressAutocomplete.vue — same deterministic commit-stack machine,
 * but with NO DOM and NO Vue. Views (Vue, vanilla) render purely from getState()/subscribe().
 *
 * Flow, driven by a commit-stack (NEVER by the server's response type):
 *   VEJ street name -> HUS house number (adgangsadresse) -> ADR floor/door (adresse)
 *
 *   const ac = createAutocomplete(client, { municipalityCode: '621' });
 *   const unsub = ac.subscribe(state => render(state));
 *   ac.setQuery('Akseltorv');   // user typing
 *   ac.moveActive(1); ac.choose(0); ac.clear();
 *
 * State snapshot: { stage, query, ghost:{zip,city}, suggestions[], activeIdx, loading, value }
 *   value = { id, type:'adresse'|'adgangsadresse', label } | null
 */
import { parseTail, normalizeQuery, parseAddress } from "./util.js";

export function createAutocomplete(client, config = {}) {
  // English option names are canonical; Danish/official names accepted as aliases.
  const maxResults = config.maxResults ?? config.maksimum;
  const cfg = {
    municipalityCode: config.municipalityCode ?? config.kommuneKode ?? config.kommunekode ?? "",
    accessAddressOnly: !!(config.accessAddressOnly ?? config.stopAtAdgang ?? config.adgangsadresserOnly),
    minLength: config.minLength != null ? config.minLength : 1,
    debounce: config.debounce != null ? config.debounce : 180,
    maxResults: maxResults != null ? maxResults : 10,
    // Default ON: include provisional (foreløbige) addresses — KDS excludes them otherwise, and some real
    // addresses are provisional (e.g. "Landemærket 27F"). Matches danmarksadresser.dk. Pass false to opt out.
    includeProvisional: !!((config.includeProvisional ?? config.medtagForeloebige) ?? true),
  };

  // ---- public state ----
  const state = {
    stage: "VEJ",
    query: "",
    ghost: { zip: null, city: null },
    suggestions: [],
    activeIdx: -1,
    loading: false,
    value: null,
  };

  // ---- internal machine state ----
  let commits = [];        // stack of { stage, anchor, data }
  let committed = {};      // flattened { vejnavn, postnummer, postdistrikt, husnummer, adgangsId }
  let suffix = "";         // text typed for the current stage
  let pendingName = null;  // street chosen but district not yet resolved
  let pool = [];           // cached HUS houses / ADR units
  let poolKey = "";
  let seq = 0;             // stale-response guard
  let debounceTimer = null;

  const listeners = new Set();
  function emit() { const snap = getState(); for (const fn of listeners) fn(snap); }
  function set(partial) { Object.assign(state, partial); emit(); }

  function getState() {
    return {
      stage: state.stage,
      query: state.query,
      ghost: { ...state.ghost },
      suggestions: state.suggestions.slice(),
      activeIdx: state.activeIdx,
      loading: state.loading,
      value: state.value ? { ...state.value } : null,
    };
  }

  /* ----------------------------- helpers ----------------------------- */
  const startsWithCI = (s, p) => s.length >= p.length && s.slice(0, p.length).toLowerCase() === p.toLowerCase();
  // A real floor/door unit titel contains a "st."/"kl."/"N." floor token; the bare building row doesn't.
  const hasFloorToken = (titel) => /,\s*(st|kl|\d{1,3})\.(\s|,|$)/i.test(titel);

  function searchParams(extra) {
    return { municipalityCode: cfg.municipalityCode, includeProvisional: cfg.includeProvisional, ...extra };
  }

  // VEJ: the API returns different row types per prefix length; ALWAYS collapse to distinct street
  // names in the API's relevance order (do NOT re-sort) for a stable list at every keystroke.
  function synthesizeNames(fund) {
    const map = new Map();
    for (const r of fund) {
      const vejnavn = r.vejnavn || r.vejNavn;
      if (!vejnavn || map.has(vejnavn)) continue;
      map.set(vejnavn, { kind: "NAME", vejnavn, label: vejnavn, meta: "›" });
    }
    return [...map.values()];
  }

  async function resolveDistricts(name) {
    const fund = await client.search(searchParams({ resource: "accessAddresses", street: name, maxResults: 200 }));
    const map = new Map();
    for (const r of fund) {
      if ((r.vejnavn || r.vejNavn) !== name) continue; // exact name only
      let pn = null, pd = null;
      if (r.type === "navngivenvejpostnummer") { pn = r.postnr; pd = r.postdistrikt; }
      else if (r.type === "husnummer" || r.type === "adresse") { const t = parseTail(r.titel); pn = t.zip; pd = t.city; }
      if (pn && !map.has(pn)) {
        map.set(pn, { kind: "DIST", vejnavn: name, postnummer: pn, postdistrikt: pd, label: `${name}, ${pn} ${pd}`, meta: "" });
      }
    }
    const rows = [...map.values()].sort((a, b) => String(a.postnummer).localeCompare(String(b.postnummer)));
    if (!rows.length) rows.push({ kind: "DIST", vejnavn: name, postnummer: null, postdistrikt: null, label: name, meta: "" });
    return rows;
  }

  function mapHouses(fund) {
    return fund
      .filter((r) => r.type === "husnummer")
      .map((r) => ({ kind: "HUS", husnummer: r.husnummer, adgangsId: r.id, label: r.titel }))
      .sort((a, b) => (parseInt(a.husnummer, 10) - parseInt(b.husnummer, 10)) || a.husnummer.localeCompare(b.husnummer, "da"));
  }
  function mapUnits(fund) {
    return fund
      .filter((r) => r.type === "adresse")
      .map((r) => ({ kind: "ADR", id: r.id, label: r.titel, hasFloor: hasFloorToken(r.titel) }));
  }

  /* ------------------- reconcile (bulletproof deletion) ------------------- */
  function reconcileState(input) {
    while (commits.length && !startsWithCI(input, commits[commits.length - 1].anchor)) commits.pop();
    const top = commits[commits.length - 1];
    const anchor = top ? top.anchor : "";
    suffix = input.slice(anchor.length);
    state.stage = !top ? "VEJ" : (top.stage === "VEJ" ? "HUS" : "ADR");
    const c = {};
    for (const x of commits) Object.assign(c, x.data);
    committed = c;
    state.ghost = { zip: c.postnummer || null, city: c.postdistrikt || null };
  }

  function poolKeyFor() {
    return state.stage === "HUS"
      ? `HUS|${committed.vejnavn}|${committed.postnummer}`
      : `ADR|${committed.vejnavn}|${committed.postnummer}|${committed.husnummer}`;
  }

  /* ----------------------------- input ----------------------------- */
  function setQuery(str) {
    state.value = null;
    pendingName = null;          // any typing invalidates a half-made district choice
    state.query = str;
    reconcileState(str);
    clearTimeout(debounceTimer);

    if (state.stage === "VEJ") {
      const parsed = parseAddress(suffix);
      // Direct mode: the user typed/pasted a house number (and maybe floor/door). The street-name
      // search can't handle that ("Edvard Thomsens Vej 87, 5th" -> 0 streets), so resolve the whole
      // thing via free-text instead. This is where we beat the raw service: normalized input + tekst.
      if (parsed.houseNumber && parsed.street) {
        emit();
        debounceTimer = setTimeout(() => searchDirect(suffix, parsed), Math.max(0, cfg.debounce));
        return;
      }
      const s = suffix.trim();
      if (s.length < cfg.minLength) { set({ suggestions: [], activeIdx: -1 }); return; }
      debounceTimer = setTimeout(() => searchStreet(s), Math.max(0, cfg.debounce));
      emit();
    } else {
      emit();
      ensurePool().then(applyFilter);
    }
  }

  // Resolve a typed/pasted address. Rather than trusting ONE rewrite, we ask the API several
  // authoritative ways IN PARALLEL and merge most-specific-first:
  //   - structured (parsed vejnavn+husnummer+etage+doer) — exact, no string-guess; only when a
  //     floor/door was parsed (husnummer is a prefix match, so it would add noise on its own)
  //   - free-text on the NORMALIZED string (handles glued tokens, missing spaces)
  //   - free-text on the RAW string — only when normalization changed it, so a lossy rewrite can't
  //     hide a result the original would have found
  // This only runs in "direct mode" (a house number was typed), debounced — never during plain
  // street browsing. Escalates to the street-name picker only if everything comes back empty.
  function toFinalRows(funds, seen, rows) {
    for (const r of funds) {
      if ((r.type !== "adresse" && r.type !== "husnummer") || seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push({ kind: "FINAL", id: r.id, type: r.type === "husnummer" ? "adgangsadresse" : "adresse", label: r.titel });
    }
    return rows;
  }
  const safeSearch = (params) => client.search(searchParams(params)).catch(() => []);

  async function searchDirect(rawSuffix, parsed) {
    const my = ++seq;
    set({ loading: true });
    const raw = rawSuffix.trim();
    const norm = normalizeQuery(rawSuffix);
    const queries = [
      safeSearch({ resource: "addresses", text: norm, maxResults: 40 }), // B: normalized free-text
    ];
    if (parsed.floor || parsed.door) {                                    // A: structured (precise unit)
      queries.unshift(safeSearch({ resource: "addresses", street: parsed.street, houseNumber: parsed.houseNumber, floor: parsed.floor || undefined, door: parsed.door || undefined, maxResults: 40 }));
    }
    if (norm !== raw) queries.push(safeSearch({ resource: "addresses", text: raw, maxResults: 40 })); // C: raw hedge

    try {
      const results = await Promise.all(queries);
      if (my !== seq) return;
      const seen = new Set(), rows = [];
      for (const fund of results) toFinalRows(fund, seen, rows);   // order: structured → normalized → raw
      if (rows.length) { set({ suggestions: rows.slice(0, Math.max(cfg.maxResults, 20)), activeIdx: 0, loading: false }); return; }
      // nothing matched anywhere → fall back to the staged street picker
      const names = synthesizeNames(await safeSearch({ resource: "accessAddresses", street: parsed.street, maxResults: 50 }));
      if (my !== seq) return;
      set({ suggestions: names.slice(0, Math.max(cfg.maxResults, 8)), activeIdx: names.length ? 0 : -1, loading: false });
    } catch {
      if (my === seq) set({ suggestions: [], loading: false });
    }
  }

  async function searchStreet(text) {
    const my = ++seq;
    set({ loading: true });
    try {
      const fund = await client.search(searchParams({ resource: "accessAddresses", street: text, maxResults: 50 }));
      if (my !== seq) return;
      const names = synthesizeNames(fund).slice(0, Math.max(cfg.maxResults, 8));
      set({ suggestions: names, activeIdx: names.length ? 0 : -1, loading: false });
    } catch {
      if (my === seq) set({ suggestions: [], loading: false });
    }
  }

  async function ensurePool() {
    const key = poolKeyFor();
    if (key === poolKey && pool.length) return; // cache hit
    const my = ++seq;
    set({ loading: true });
    try {
      const fund = state.stage === "HUS"
        ? await client.search(searchParams({ resource: "accessAddresses", street: committed.vejnavn, postalCode: committed.postnummer, maxResults: 200 }))
        : await client.search(searchParams({ resource: "addresses", street: committed.vejnavn, postalCode: committed.postnummer, houseNumber: committed.husnummer, maxResults: 200 }));
      if (my !== seq) return;
      pool = state.stage === "HUS" ? mapHouses(fund) : mapUnits(fund).filter((u) => u.hasFloor);
      poolKey = key;
    } catch {
      if (my === seq) { pool = []; poolKey = key; }
    } finally {
      if (my === seq) state.loading = false;
    }
  }

  function applyFilter() {
    const raw = normalizeQuery(suffix); // tolerant: "5th" -> "5 th", glued tokens spaced, doors lowercased
    let next;
    if (state.stage === "HUS") {
      // a HUS suffix may carry a trailing floor/door ("87, 5. th") — filter on the house-number part only
      const m = raw.trim().match(/^(\d{1,3}[a-zæøå]?)/i);
      const r = (m ? m[1] : raw.trim()).toLowerCase();
      next = pool.filter((h) => !r || (h.husnummer || "").toLowerCase().startsWith(r));
    } else {
      const norm = (s) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
      const toks = norm(raw).split(" ").filter(Boolean);
      next = pool.filter((u) => {
        const words = norm(u.label).split(" ");
        return toks.every((t) => words.some((w) => w.startsWith(t)));
      });
    }
    set({ suggestions: next, activeIdx: next.length ? 0 : -1 });
  }

  /* ----------------------------- selection ----------------------------- */
  async function choose(arg) {
    const s = typeof arg === "number" ? state.suggestions[arg] : arg;
    if (!s) return;

    if (s.kind === "FINAL") return finish({ id: s.id, type: s.type, titel: s.label }); // direct-mode result

    if (s.kind === "NAME") {                 // street name -> resolve its district(s)
      pendingName = s.vejnavn;
      state.query = s.vejnavn;
      reconcileState(state.query);           // stays VEJ
      const my = ++seq;
      set({ loading: true });
      let dists;
      try { dists = await resolveDistricts(s.vejnavn); }
      catch { if (my === seq) set({ loading: false, suggestions: [] }); return; }
      if (my !== seq) return;
      if (dists.length === 1) { state.loading = false; return commitStreet(dists[0]); }
      set({ suggestions: dists, activeIdx: dists.length ? 0 : -1, loading: false });
      return;
    }

    if (s.kind === "DIST") return commitStreet(s);

    if (s.kind === "HUS") {
      if (cfg.accessAddressOnly) return finish({ id: s.adgangsId, type: "adgangsadresse", titel: s.label });
      return enterAdrOrFinish(s);
    }

    return finish({ id: s.id, type: "adresse", titel: s.label }); // ADR
  }

  async function commitStreet(d) {           // commit {vejnavn, postnummer, postdistrikt} -> HUS
    pendingName = null;
    commits.push({ stage: "VEJ", anchor: d.vejnavn + " ", data: { vejnavn: d.vejnavn, postnummer: d.postnummer, postdistrikt: d.postdistrikt } });
    state.query = d.vejnavn + " ";
    reconcileState(state.query);
    poolKey = "";
    emit();
    await ensurePool();
    applyFilter();
  }

  async function enterAdrOrFinish(s) {
    const my = ++seq;
    set({ loading: true });
    let units;
    try {
      units = mapUnits(await client.search(searchParams({ resource: "addresses", street: committed.vejnavn, postalCode: committed.postnummer, houseNumber: s.husnummer, maxResults: 200 })));
    } catch { if (my === seq) set({ loading: false }); return; }
    if (my !== seq) return;
    const real = units.filter((u) => u.hasFloor);

    if (real.length <= 1) {                  // single-family / no floor choice
      state.loading = false;
      const only = real[0] || units[0];
      return finish(only ? { id: only.id, type: "adresse", titel: only.label }
                         : { id: s.adgangsId, type: "adgangsadresse", titel: s.label });
    }

    commits.push({ stage: "HUS", anchor: `${committed.vejnavn} ${s.husnummer}, `, data: { husnummer: s.husnummer, adgangsId: s.adgangsId } });
    state.query = `${committed.vejnavn} ${s.husnummer}, `;
    reconcileState(state.query);
    pool = real; poolKey = poolKeyFor();
    set({ suggestions: real, activeIdx: 0, loading: false });
  }

  function finish(v) {
    const t = parseTail(v.titel);
    state.query = t.head;                    // clean editable text (no zip/town)
    state.ghost = { zip: t.zip, city: t.city };
    state.value = { id: v.id, type: v.type, label: v.titel };
    set({ suggestions: [], activeIdx: -1 });
  }

  /* ----------------------------- misc ----------------------------- */
  function moveActive(d) {
    const n = state.suggestions.length;
    if (!n) return;
    set({ activeIdx: (state.activeIdx + d + n) % n });
  }

  function clear() {
    clearTimeout(debounceTimer);
    commits = []; committed = {}; suffix = ""; pendingName = null; pool = []; poolKey = ""; seq++;
    set({ stage: "VEJ", query: "", ghost: { zip: null, city: null }, suggestions: [], activeIdx: -1, loading: false, value: null });
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(getState());
    return () => listeners.delete(fn);
  }

  function destroy() { clearTimeout(debounceTimer); listeners.clear(); }

  return { setQuery, moveActive, choose, clear, getState, subscribe, destroy };
}
