/**
 * LIVE smoke test against adressevaelger.dk — network required. Run sparingly:
 *   npm run test:live
 * Asserts the behaviours we verified by hand (2026-06) and depend on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/adressevaelger/client.js";
import { createAutocomplete } from "../src/adressevaelger/autocomplete.js";

const client = createClient({ token: process.env.ADRESSEVAELGER_TOKEN || "adressevaelger123" });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("municipalityCode filters in structured street mode", async () => {
  const restricted = await client.search({ resource: "accessAddresses", street: "skolegade", municipalityCode: "0661", maxResults: 50 });
  const nationwide = await client.search({ resource: "accessAddresses", street: "skolegade", maxResults: 50 });
  assert.ok(restricted.length > 0 && restricted.length < nationwide.length, `${restricted.length} vs ${nationwide.length}`);
});

test("multiple municipalities union via comma", async () => {
  const a = await client.search({ resource: "accessAddresses", street: "Nørregade", municipalityCode: "0661", maxResults: 200 });
  const b = await client.search({ resource: "accessAddresses", street: "Nørregade", municipalityCode: "0779", maxResults: 200 });
  const union = await client.search({ resource: "accessAddresses", street: "Nørregade", municipalityCode: ["661", "779"], maxResults: 200 });
  assert.equal(union.length, a.length + b.length);
});

test("apartment drill returns floor/door units", async () => {
  const units = await client.search({ resource: "addresses", street: "Fredericiagade", postalCode: "6000", houseNumber: "16", municipalityCode: "0621" });
  assert.ok(units.some((u) => /,\s*(st|kl|\d{1,3})\./i.test(u.titel)), "expected at least one floor unit");
});

test("direct mode resolves a glued full address ('…87, 5th') live, via parallel strategies", async () => {
  const ac = createAutocomplete(client, { debounce: 0 });
  ac.setQuery("Edvard Thomsens Vej 87, 5th"); // the raw API returns 16 loose hits for this
  await delay(1500);
  const labels = ac.getState().suggestions.map((x) => x.label);
  assert.ok(labels.some((l) => /\b5\.\s*th\b/.test(l)), `expected a "5. th" suggestion, got: ${labels.slice(0, 3)}`);
});

test("resolve(id) round-trips a husnummer id to a normalized address", async () => {
  const houses = await client.search({ resource: "accessAddresses", street: "Akseltorv", postalCode: "6000", municipalityCode: "0621", maxResults: 5 });
  assert.ok(houses.length, "no houses found");
  const m = await client.resolve(houses[0].id);
  assert.ok(m, "resolve returned null");
  assert.equal(m.city, "Kolding");
  assert.equal(m.municipality_code, 621);
  assert.equal(m.municipality_name, "Kolding");
  assert.ok(m.position && m.position.coordinates[0] > 7 && m.position.coordinates[0] < 16);
});
