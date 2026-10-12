/**
 * Golden regression suite on REAL KDS responses (test/fixtures/kds/*.json, recorded 2026-10-12, token redacted).
 * `mapAddress.golden-0.2.1.json` is the output of mapAddress from 0.2.1 on every lookup fixture. It is never
 * regenerated: a change that moves any existing key, value or key order fails here. 0.3.0 appends `status`
 * (and only that): output minus `status` must still be byte-identical to the 0.2.1 golden.
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

const withoutStatus = ({ status, ...rest }) => rest;

// expected DAR status per fixture, read independently of mapAddress from the raw record
const EXPECTED_STATUS = {
  "adresse-floor-door": 3,
  "adresse-floor-only": 3,
  "adresse-status2-provisional": 2,
  "adresse-status3-plain": 3,
  "adresse-subcity": 3,
  "handcrafted-adresse-status4-retired": 4,
  "handcrafted-husnummer-status5-henlagt": 5,
  "husnummer-status2-provisional": 2,
  "husnummer-status3": 3,
  "husnummer-subcity": 3,
};

test("every fixture has an expected status", () => {
  assert.deepEqual(Object.keys(EXPECTED_STATUS).sort(), lookupFixtures);
});

for (const name of lookupFixtures) {
  test(`mapAddress golden: ${name}`, () => {
    const out = mapAddress(load(`${name}.json`).body);
    // old keys byte-identical to 0.2.1, key order included; `status` appended as the last key
    assert.equal(JSON.stringify(withoutStatus(out)), JSON.stringify(golden[name]));
    assert.deepEqual(Object.keys(out), [...Object.keys(golden[name]), "status"]);
    assert.equal(out.status, EXPECTED_STATUS[name]);
  });
}

test("status comes from the record, never from the response's top-level status \"ok\"", () => {
  const { body } = load("adresse-status2-provisional.json");
  assert.equal(body.status, "ok");
  // adresse and its husnummer may differ: the adresse's own status wins
  const b = structuredClone(body);
  b.adresse.status = "4";
  b.adresse.husnummer.status = "3";
  assert.equal(mapAddress(b).status, 4);
  const h = structuredClone(load("husnummer-status3.json").body);
  h.husnummer.status = "2";
  assert.equal(mapAddress(h).status, 2);
});

test("status is null when the record has none (absent, null, empty, non-numeric)", () => {
  for (const v of [undefined, null, "", "x"]) {
    const b = structuredClone(load("adresse-floor-door.json").body);
    if (v === undefined) delete b.adresse.status; else b.adresse.status = v;
    const out = mapAddress(b);
    assert.equal(out.status, null, `status ${JSON.stringify(v)}`);
    assert.equal(JSON.stringify(withoutStatus(out)), JSON.stringify(golden["adresse-floor-door"]));
    const h = structuredClone(load("husnummer-status3.json").body);
    if (v === undefined) delete h.husnummer.status; else h.husnummer.status = v;
    assert.equal(mapAddress(h).status, null);
  }
});

test("status accepts a numeric status too", () => {
  const b = structuredClone(load("husnummer-status3.json").body);
  b.husnummer.status = 3;
  assert.equal(mapAddress(b).status, 3);
});

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

test("search passes a status on a hit through untouched (KDS sends none today, verified 2026-10-12)", async () => {
  const { body } = load("search-adresser-provisional.json");
  assert.ok(body.fund.every((r) => !("status" in r)), "KDS now sends status on hits: update README");
  const withStatus = structuredClone(body);
  withStatus.fund.forEach((r, i) => { r.status = i % 2 ? "2" : "3"; });
  const client = createClient({ token: "t", fetch: stubFetch(withStatus) });
  assert.deepEqual(await client.search({ text: "x" }), withStatus.fund);
});

test("lookupById returns the golden output + status via the client (recorded adresse and husnummer)", async () => {
  for (const [name, type] of [["adresse-floor-door", "adresse"], ["husnummer-status2-provisional", "husnummer"]]) {
    const client = createClient({ token: "t", fetch: stubFetch(load(`${name}.json`).body) });
    const out = await client.lookupById("x", { type });
    assert.equal(JSON.stringify(withoutStatus(out)), JSON.stringify(golden[name]));
    assert.equal(out.status, EXPECTED_STATUS[name]);
  }
});
