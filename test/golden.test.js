/**
 * Golden regression suite on REAL KDS responses (test/fixtures/kds/*.json, recorded 2026-10-12, token redacted).
 * `mapAddress.golden-0.2.1.json` is the output of mapAddress from 0.2.1 on every lookup fixture. It is never
 * regenerated: a change that moves any existing key, value or key order fails here.
 * `handcrafted-*` fixtures are real records with only the status edited (KDS lookups returned no retired record).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mapAddress, createClient } from "../src/adressevaelger/client.js";

const DIR = new URL("./fixtures/kds/", import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, DIR)));
const golden = load("mapAddress.golden-0.2.1.json");
const lookupFixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("search-") && !f.startsWith("mapAddress."))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

test("golden covers every lookup fixture (no fixture silently skipped)", () => {
  assert.deepEqual(Object.keys(golden).sort(), lookupFixtures);
  assert.ok(lookupFixtures.length >= 10, `only ${lookupFixtures.length} fixtures`);
});

for (const name of lookupFixtures) {
  test(`mapAddress golden: ${name}`, () => {
    const out = mapAddress(load(`${name}.json`).body);
    // byte-identical, key order included
    assert.equal(JSON.stringify(out), JSON.stringify(golden[name]));
  });
}

/** fetch stub that serves a recorded body for any URL. */
function stubFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => "" });
}

for (const name of ["search-adresser", "search-husnumre", "search-adresser-provisional"]) {
  test(`search returns recorded fund rows untouched: ${name}`, async () => {
    const { body } = load(`${name}.json`);
    const client = createClient({ token: "t", fetch: stubFetch(body) });
    assert.deepEqual(await client.search({ text: "x" }), body.fund);
  });
}

test("lookupById returns the golden output via the client (recorded adresse)", async () => {
  const { body } = load("adresse-floor-door.json");
  const client = createClient({ token: "t", fetch: stubFetch(body) });
  assert.equal(JSON.stringify(await client.lookupById("x", { type: "adresse" })), JSON.stringify(golden["adresse-floor-door"]));
});
