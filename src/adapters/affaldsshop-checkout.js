/**
 * Affaldsshop WooCommerce checkout adapter (vanilla DOM, self-mounting).
 * Bundled to an IIFE and hosted at https://widgets.genbrugscms.cloud/affaldsshop-checkout.<ver>.js,
 * enqueued by the theme. Reads window.AFFALDSSHOP_ADDRESS_CONFIG (set per site) and mounts the shared
 * headless controller onto the existing checkout fields. Drop-in replacement for the old dawa-autocomplete2
 * integration; reuses the same dropdown CSS classes so the theme styling keeps working.
 *
 * Per-site config (only municipalityCode normally varies). English option names; Danish/official KDS
 * names (kommuneKode, stopAtAdgang/adgangsadresserOnly, maksimum, medtagForeloebige, apiUrl) accepted as aliases:
 *   window.AFFALDSSHOP_ADDRESS_CONFIG = { token, municipalityCode, accessAddressOnly, minLength, debounce, selectors };
 *   - municipalityCode: '621' | ['661','665','671','779'] | ''  (whole country)
 *   - the municipality-name field is filled for ANY municipality IF its element exists; ignored otherwise.
 */
import { createClient } from "../adressevaelger/client.js";
import { createAutocomplete } from "../adressevaelger/autocomplete.js";

const DEFAULTS = {
  token: "adressevaelger123",   // install-wide token (injected by the theme from a wp-config constant)
  baseUrl: undefined,           // override the API host (e.g. a staging URL); default adressevaelger.dk
  municipalityCode: "",         // '' = whole country | '621' | ['661','665','671','779'] (comma-union)
  accessAddressOnly: false,     // true = stop at the access address (no floor/door)
  minLength: 2,                 // chars before street search starts
  debounce: 200,                // ms between keystrokes -> street search
  maxResults: 12,               // suggestions shown (API cap 200)
  includeProvisional: true,     // include provisional (foreløbige) addresses (KDS-aligned; set false to opt out)
  lockCityZip: true,            // block manual edits to the city/zip fields
  debug: false,                 // log each (redacted) API request to the console
  selectors: {
    address: "#billing_address_1",
    city: "#billing_city",
    zip: "#billing_postcode",
    municipalityName: "#order_municipality_name", // filled for ANY municipality IF this element exists
  },
};

function mount(rawCfg) {
  const r = rawCfg || {};
  const cfg = { ...DEFAULTS, ...r, selectors: { ...DEFAULTS.selectors, ...(r.selectors || {}) } };
  // English option names are canonical; accept Danish/official KDS names as aliases.
  cfg.baseUrl = r.baseUrl ?? r.apiUrl ?? DEFAULTS.baseUrl;
  cfg.municipalityCode = r.municipalityCode ?? r.kommuneKode ?? r.kommunekode ?? DEFAULTS.municipalityCode;
  cfg.accessAddressOnly = r.accessAddressOnly ?? r.stopAtAdgang ?? r.adgangsadresserOnly ?? DEFAULTS.accessAddressOnly;
  cfg.maxResults = r.maxResults ?? r.maksimum ?? DEFAULTS.maxResults;
  cfg.includeProvisional = r.includeProvisional ?? r.medtagForeloebige ?? DEFAULTS.includeProvisional;
  const sel = cfg.selectors;
  const input = document.querySelector(sel.address);
  if (!input) return; // not a checkout page
  const cityEl = sel.city ? document.querySelector(sel.city) : null;
  const zipEl = sel.zip ? document.querySelector(sel.zip) : null;
  const muniEl = sel.municipalityName ? document.querySelector(sel.municipalityName) : null;

  const client = createClient({
    token: cfg.token,
    baseUrl: cfg.baseUrl,
    onRequest: cfg.debug ? (u) => console.debug("[adressevaelger]", u) : undefined,
  });
  const ac = createAutocomplete(client, {
    municipalityCode: cfg.municipalityCode,
    accessAddressOnly: cfg.accessAddressOnly,
    minLength: cfg.minLength,
    debounce: cfg.debounce,
    maxResults: cfg.maxResults,
    includeProvisional: cfg.includeProvisional,
  });

  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-autocomplete", "list");
  if (cfg.lockCityZip) lockFields([cityEl, zipEl, muniEl], onClearAll);

  // dropdown container (reuses the old dawa-autocomplete2 class names for styling)
  let box = null;
  let lastValueId = null;
  let filled = false;     // whether city/zip currently hold a resolved value
  let hasFocus = false;

  ac.subscribe((s) => {
    if (input.value !== s.query) { input.value = s.query; caretEnd(input); }
    render(s);
    if (s.value && s.value.id !== lastValueId) {
      lastValueId = s.value.id; filled = true; onSelect(s);
    } else if (!s.value) {
      lastValueId = null;
      // address was edited away from a resolved selection -> drop the now-stale city/zip/kommune
      // so a failed paste or further typing can never submit mismatched values.
      if (filled) { clearDependents(); filled = false; }
    }
  });

  input.addEventListener("input", () => ac.setQuery(input.value));
  input.addEventListener("keydown", onKey);
  input.addEventListener("focus", () => { hasFocus = true; render(ac.getState()); });
  input.addEventListener("blur", () => { hasFocus = false; setTimeout(hide, 150); });

  function onKey(e) {
    if (!box || box.style.display === "none") return;
    if (e.key === "ArrowDown") { e.preventDefault(); ac.moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); ac.moveActive(-1); }
    else if (e.key === "Enter") { const i = ac.getState().activeIdx; if (i >= 0) { e.preventDefault(); ac.choose(i); } }
    else if (e.key === "Escape") { hide(); }
  }

  function render(s) {
    if (!hasFocus || !s.suggestions.length) { hide(); return; }
    if (!box) {
      box = document.createElement("ul");
      box.className = "dawa-autocomplete-suggestions";
      input.parentNode.insertBefore(box, input.nextSibling);
    }
    box.innerHTML = "";
    s.suggestions.forEach((row, i) => {
      const li = document.createElement("li");
      li.className = "dawa-autocomplete-suggestion" + (i === s.activeIdx ? " dawa-selected" : "");
      li.textContent = row.label;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); ac.choose(i); });
      box.appendChild(li);
    });
    box.style.display = "block";
  }
  function hide() { if (box) box.style.display = "none"; }

  function onSelect(s) {
    // address head is already in `input` (controller owns query). Fill + lock city/zip from the ghost.
    if (cityEl) setLocked(cityEl, s.ghost.city || "");
    if (zipEl) setLocked(zipEl, s.ghost.zip || "");
    // municipality name: fill for ANY municipality only if the field exists; one id-lookup for the code.
    if (muniEl) {
      client.lookupById(s.value.id, { type: s.value.type })
        .then((m) => { if (m) setLocked(muniEl, m.municipality_name || ""); })
        .catch(() => {});
    }
    hide();
  }

  function clearDependents() {  // blank the derived fields (NOT the address input) without firing change
    [cityEl, zipEl, muniEl].forEach((el) => { if (el) setLocked(el, ""); });
  }

  function onClearAll() {
    ac.clear();                 // resets controller; subscribe will blank the input
    clearDependents();
  }
}

/* ----------------------------- DOM helpers ----------------------------- */
function setLocked(el, val) { el.value = val; } // assign WITHOUT firing change (lock-clear listens to change)
function caretEnd(el) { try { const n = el.value.length; el.setSelectionRange(n, n); } catch { /* noop */ } }

function lockFields(fields, onClear) {
  fields.forEach((el) => {
    if (!el) return;
    el.setAttribute("autocomplete", "off");
    el.setAttribute("aria-autocomplete", "none");
    el.addEventListener("keydown", (e) => e.preventDefault()); // block manual typing
    el.addEventListener("change", onClear);                    // genuine user change -> reset everything
  });
}

/* ----------------------------- self-mount ----------------------------- */
function boot() { mount(window.AFFALDSSHOP_ADDRESS_CONFIG || {}); }
if (document.readyState !== "loading") boot();
else document.addEventListener("DOMContentLoaded", boot);

export { mount }; // also exported for testing / manual mounting
