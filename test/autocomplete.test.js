import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutocomplete } from "../src/adressevaelger/autocomplete.js";

/* A deterministic mock of the API client. search() uses the library's English param names and matches
   on (resource, street, postalCode, houseNumber). DATA keys keep the normalized API resource names. */
function mockClient(dataset, { trace } = {}) {
  const canon = (s) => String(s || "").replace(/,/g, "").replace(/\s+/g, " ").trim();
  return {
    async search(p = {}) {
      const key = p.text != null
        ? `text|${canon(p.text)}`
        : `${p.resource === "accessAddresses" || p.resource === "husnumre" ? "husnumre" : "adresser"}|${p.street || ""}|${p.postalCode || ""}|${p.houseNumber || ""}`;
      if (trace) trace.push(key);
      return (dataset[key] || []).slice();
    },
    async lookupById() { return null; },
    async resolve() { return null; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 15));

const DATA = {
  // Akseltorv (Kolding) — single district, single-family houses (no floor units)
  "husnumre|Akseltorv||": [
    { type: "husnummer", id: "h1", titel: "Akseltorv 1, 6000 Kolding", vejnavn: "Akseltorv", husnummer: "1" },
    { type: "husnummer", id: "h11", titel: "Akseltorv 11, 6000 Kolding", vejnavn: "Akseltorv", husnummer: "11" },
    { type: "husnummer", id: "h13", titel: "Akseltorv 13, 6000 Kolding", vejnavn: "Akseltorv", husnummer: "13" },
  ],
  "husnumre|Akseltorv|6000|": [
    { type: "husnummer", id: "h1", titel: "Akseltorv 1, 6000 Kolding", vejnavn: "Akseltorv", husnummer: "1" },
    { type: "husnummer", id: "h11", titel: "Akseltorv 11, 6000 Kolding", vejnavn: "Akseltorv", husnummer: "11" },
    { type: "husnummer", id: "h13", titel: "Akseltorv 13, 6000 Kolding", vejnavn: "Akseltorv", husnummer: "13" },
  ],
  "adresser|Akseltorv|6000|1": [
    { type: "adresse", id: "a1", titel: "Akseltorv 1, 6000 Kolding" }, // building only, no floor token
  ],

  // Fredericiagade 16 (Kolding) — multi-unit apartment building
  "husnumre|Fredericiagade||": [
    { type: "husnummer", id: "fh16", titel: "Fredericiagade 16, 6000 Kolding", vejnavn: "Fredericiagade", husnummer: "16" },
  ],
  "husnumre|Fredericiagade|6000|": [
    { type: "husnummer", id: "fh16", titel: "Fredericiagade 16, 6000 Kolding", vejnavn: "Fredericiagade", husnummer: "16" },
  ],
  "adresser|Fredericiagade|6000|16": [
    { type: "adresse", id: "fa0", titel: "Fredericiagade 16, 6000 Kolding" },        // building (no floor)
    { type: "adresse", id: "fa1", titel: "Fredericiagade 16, st., 6000 Kolding" },
    { type: "adresse", id: "fa2", titel: "Fredericiagade 16, 1., 6000 Kolding" },
    { type: "adresse", id: "fa3", titel: "Fredericiagade 16, 2., 6000 Kolding" },
  ],

  // Direct-mode resolution. The controller fires several queries in parallel; both the structured
  // lookup and the normalized free-text return the SAME unit (id fa1th) -> must dedup to one row.
  "text|Fredericiagade 16 1 th": [
    { type: "adresse", id: "fa1th", titel: "Fredericiagade 16, 1. th, 6000 Kolding" },
  ],
  "adresser|Fredericiagade||16": [ // structured (street+house, floor/door ignored by the mock key)
    { type: "adresse", id: "fa1th", titel: "Fredericiagade 16, 1. th, 6000 Kolding" },
  ],

  // Skolegade — exists in two municipalities (multi-district)
  "husnumre|Skolegade||": [
    { type: "navngivenvejpostnummer", id: "s75", vejnavn: "Skolegade", postnr: "7500", postdistrikt: "Holstebro", titel: "Skolegade 7500 Holstebro" },
    { type: "navngivenvejpostnummer", id: "s78", vejnavn: "Skolegade", postnr: "7800", postdistrikt: "Skive", titel: "Skolegade 7800 Skive" },
  ],
};

test("single-family house: street -> auto-commit district -> house -> finish adresse", async () => {
  const ac = createAutocomplete(mockClient(DATA), { debounce: 0 });
  ac.setQuery("Akseltorv");
  await flush();
  let s = ac.getState();
  assert.equal(s.stage, "VEJ");
  assert.deepEqual(s.suggestions.map((x) => x.label), ["Akseltorv"]);

  await ac.choose(0);              // pick the street name -> 1 district -> commits, loads houses
  s = ac.getState();
  assert.equal(s.stage, "HUS");
  assert.equal(s.query, "Akseltorv ");
  assert.deepEqual(s.ghost, { zip: "6000", city: "Kolding" });
  assert.deepEqual(s.suggestions.map((x) => x.husnummer), ["1", "11", "13"]);

  ac.setQuery("Akseltorv 1");      // filter houses client-side (prefix match: 1 -> 1, 11, 13)
  await flush();
  s = ac.getState();
  assert.deepEqual(s.suggestions.map((x) => x.husnummer), ["1", "11", "13"]);

  ac.setQuery("Akseltorv 13");     // narrower prefix
  await flush();
  assert.deepEqual(ac.getState().suggestions.map((x) => x.husnummer), ["13"]);

  ac.setQuery("Akseltorv 1");      // back to the broader prefix; choose house 1 (sorted first)
  await flush();
  await ac.choose(0);              // house 1 -> no floor units -> finish
  s = ac.getState();
  assert.equal(s.value.type, "adresse");
  assert.equal(s.value.label, "Akseltorv 1, 6000 Kolding");
  assert.equal(s.query, "Akseltorv 1");        // clean head, zip/city stripped
  assert.deepEqual(s.ghost, { zip: "6000", city: "Kolding" });
});

test("apartment: house -> floor/door units -> finish specific unit", async () => {
  const ac = createAutocomplete(mockClient(DATA), { debounce: 0 });
  ac.setQuery("Fredericiagade");
  await flush();
  await ac.choose(0);              // street -> 1 district -> houses [16]
  let s = ac.getState();
  assert.deepEqual(s.suggestions.map((x) => x.husnummer), ["16"]);

  await ac.choose(0);              // house 16 -> multiple units -> ADR stage
  s = ac.getState();
  assert.equal(s.stage, "ADR");
  assert.deepEqual(s.suggestions.map((x) => x.label), [
    "Fredericiagade 16, st., 6000 Kolding",
    "Fredericiagade 16, 1., 6000 Kolding",
    "Fredericiagade 16, 2., 6000 Kolding",
  ]);

  await ac.choose(1);              // pick "1."
  s = ac.getState();
  assert.equal(s.value.type, "adresse");
  assert.equal(s.value.label, "Fredericiagade 16, 1., 6000 Kolding");
});

test("accessAddressOnly: house selection finishes at access address (no floor/door)", async () => {
  const ac = createAutocomplete(mockClient(DATA), { debounce: 0, accessAddressOnly: true });
  ac.setQuery("Fredericiagade");
  await flush();
  await ac.choose(0);
  await ac.choose(0);              // house 16 -> finish as adgangsadresse
  const s = ac.getState();
  assert.equal(s.value.type, "adgangsadresse");
  assert.equal(s.value.label, "Fredericiagade 16, 6000 Kolding");
});

test("Danish/official aliases still work (adgangsadresserOnly, kommuneKode, maksimum)", async () => {
  const trace = [];
  const ac = createAutocomplete(mockClient(DATA, { trace }), { debounce: 0, adgangsadresserOnly: true, kommuneKode: "621", maksimum: 5 });
  ac.setQuery("Fredericiagade");
  await flush();
  await ac.choose(0);
  await ac.choose(0);
  assert.equal(ac.getState().value.type, "adgangsadresse"); // adgangsadresserOnly honored
});

test("multi-district street shows a district picker (no auto-commit)", async () => {
  const ac = createAutocomplete(mockClient(DATA), { debounce: 0 });
  ac.setQuery("Skolegade");
  await flush();
  await ac.choose(0);              // street name -> 2 districts
  let s = ac.getState();
  assert.equal(s.stage, "VEJ");    // not committed yet
  assert.deepEqual(s.suggestions.map((x) => x.kind), ["DIST", "DIST"]);
  assert.deepEqual(s.suggestions.map((x) => x.postnummer), ["7500", "7800"]);

  await ac.choose(1);              // choose Skive
  s = ac.getState();
  assert.equal(s.stage, "HUS");
  assert.deepEqual(s.ghost, { zip: "7800", city: "Skive" });
});

test("bulletproof partial deletion: backspacing past a committed separator pops the level", async () => {
  const ac = createAutocomplete(mockClient(DATA), { debounce: 0 });
  ac.setQuery("Akseltorv");
  await flush();
  await ac.choose(0);              // commit street -> HUS, query "Akseltorv "
  assert.equal(ac.getState().stage, "HUS");

  ac.setQuery("Aksel");            // delete past the committed "Akseltorv " anchor
  await flush();
  const s = ac.getState();
  assert.equal(s.stage, "VEJ");
  assert.deepEqual(s.ghost, { zip: null, city: null });
});

test("direct mode: glued floor+door full address ('16, 1th') resolves via free-text", async () => {
  const trace = [];
  const ac = createAutocomplete(mockClient(DATA, { trace }), { debounce: 0 });
  ac.setQuery("Fredericiagade 16, 1th");   // glued "1th" + comma — the kind of input the raw API fails on
  await flush();
  let s = ac.getState();
  assert.equal(s.stage, "VEJ");            // no commit — resolved directly
  assert.equal(s.suggestions.length, 1);   // structured + normalized both return fa1th -> deduped to one
  assert.equal(s.suggestions[0].kind, "FINAL");
  assert.equal(s.suggestions[0].label, "Fredericiagade 16, 1. th, 6000 Kolding");
  // parallel strategies: structured (non-text key) + normalized free-text + raw free-text (raw != normalized)
  assert.ok(trace.length >= 3, `expected parallel queries, got ${trace.length}: ${trace}`);
  assert.ok(trace.some((k) => !k.startsWith("text|")), "should include a structured query");
  assert.ok(trace.some((k) => k.startsWith("text|")), "should include a free-text query");

  await ac.choose(0);
  s = ac.getState();
  assert.equal(s.value.type, "adresse");
  assert.equal(s.value.label, "Fredericiagade 16, 1. th, 6000 Kolding");
  assert.equal(s.query, "Fredericiagade 16, 1. th");   // clean head, zip/city stripped
  assert.deepEqual(s.ghost, { zip: "6000", city: "Kolding" });
});

test("clear() resets everything", async () => {
  const ac = createAutocomplete(mockClient(DATA), { debounce: 0 });
  ac.setQuery("Akseltorv");
  await flush();
  await ac.choose(0);
  ac.clear();
  const s = ac.getState();
  assert.deepEqual(s, {
    stage: "VEJ", query: "", ghost: { zip: null, city: null },
    suggestions: [], activeIdx: -1, loading: false, value: null,
  });
});
