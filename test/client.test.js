import { test } from "node:test";
import assert from "node:assert/strict";
import { normKommune, normKommuneList, parseTail, utm32ToWgs84, normalizeQuery, parseAddress } from "../src/adressevaelger/util.js";
import { kommuneNavn } from "../src/adressevaelger/kommuner.js";
import { mapAddress, createClient } from "../src/adressevaelger/client.js";

test("normKommune pads to 4 digits, strips leading zeros, handles empty", () => {
  assert.equal(normKommune("561"), "0561");
  assert.equal(normKommune("0561"), "0561");
  assert.equal(normKommune(621), "0621");
  assert.equal(normKommune(""), "");
  assert.equal(normKommune(null), "");
});

test("normKommuneList unions, commas (not pipes), from string or array", () => {
  assert.equal(normKommuneList("621"), "0621");
  assert.equal(normKommuneList(["661", "665", "671", "779"]), "0661,0665,0671,0779");
  assert.equal(normKommuneList("661|665"), "0661,0665"); // pipe input -> comma output (API rejects pipe)
  assert.equal(normKommuneList("661, 665"), "0661,0665");
  assert.equal(normKommuneList(""), "");
});

test("parseTail splits trailing ', zip city' from the head", () => {
  assert.deepEqual(parseTail("Akseltorv 1, 6000 Kolding"), { head: "Akseltorv 1", zip: "6000", city: "Kolding" });
  assert.deepEqual(parseTail("Edvard Thomsens Vej 87, 5. th, 2300 København S"),
    { head: "Edvard Thomsens Vej 87, 5. th", zip: "2300", city: "København S" });
  assert.deepEqual(parseTail("Rudholmvej 4, Søhale, 6715 Esbjerg N"),
    { head: "Rudholmvej 4, Søhale", zip: "6715", city: "Esbjerg N" });
  assert.deepEqual(parseTail("Just a street"), { head: "Just a street", zip: null, city: null });
});

test("normalizeQuery inserts missing spaces and normalizes floor/door", () => {
  assert.equal(normalizeQuery("Vej87"), "Vej 87");                 // glued street+house
  assert.equal(normalizeQuery("Akseltorv2"), "Akseltorv 2");
  assert.equal(normalizeQuery("87, 5th"), "87, 5 th");             // glued floor+door (the failing case)
  assert.equal(normalizeQuery("87, 5.th"), "87, 5 th");
  assert.equal(normalizeQuery("87, 5TH"), "87, 5 th");            // lowercases door
  assert.equal(normalizeQuery("87, 5. t.h."), "87, 5 th");        // dotted door form
  assert.equal(normalizeQuery("Akseltorv 2A"), "Akseltorv 2A");   // house letter preserved
});

test("parseAddress decomposes street / house / floor / door", () => {
  assert.deepEqual(parseAddress("Edvard Thomsens Vej 87, 5th"),
    { street: "Edvard Thomsens Vej", houseNumber: "87", floor: "5", door: "th" });
  assert.deepEqual(parseAddress("Akseltorv"),
    { street: "Akseltorv", houseNumber: null, floor: null, door: null });
  assert.deepEqual(parseAddress("Akseltorv 2A"),
    { street: "Akseltorv", houseNumber: "2A", floor: null, door: null });
  // leading-number street name must not be mistaken for a house number
  assert.equal(parseAddress("5. Junivej").houseNumber, null);
  assert.equal(parseAddress("5. Junivej 10").houseNumber, "10");
});

test("kommuneNavn resolves any municipality code (number / 3-digit / 4-digit)", () => {
  assert.equal(kommuneNavn(621), "Kolding");
  assert.equal(kommuneNavn("0561"), "Esbjerg");
  assert.equal(kommuneNavn("779"), "Skive");
  assert.equal(kommuneNavn(99999), "");
});

test("utm32ToWgs84 reprojects 25832 metres into a plausible DK lon/lat", () => {
  const [lon, lat] = utm32ToWgs84(497000, 6071000); // ~Kolding
  assert.ok(lon > 7 && lon < 16, `lon ${lon}`);
  assert.ok(lat > 54 && lat < 58, `lat ${lat}`);
});

test("createClient accepts the official `apiUrl` as an alias for baseUrl", () => {
  assert.equal(createClient({ token: "x", apiUrl: "https://staging.example.dk/" }).baseUrl, "https://staging.example.dk");
  assert.equal(createClient({ token: "x", baseUrl: "https://b.dk" }).baseUrl, "https://b.dk");
});

test("mapAddress flattens a nested /adresser/{id} response incl. municipality_name", () => {
  const resp = {
    status: "ok",
    adresse: {
      id_lokalid: "a-uuid",
      adressebetegnelse: "Strandby Kirkevej 4, st. th, 6000 Kolding",
      etagebetegnelse: "st",
      doerbetegnelse: "th",
      husnummer: {
        id_lokalid: "h-uuid",
        husnummertekst: "4",
        vejnavn: "Strandby Kirkevej",
        adgangspunkt: { koordinater: { x: 497000, y: 6071000 } },
        postnummer: { postnr: "6000", navn: "Kolding" },
        navngivenvejkommunedel: { kommune: "0621", vejkode: "1234" },
      },
    },
  };
  const m = mapAddress(resp);
  assert.equal(m.id, "a-uuid");
  assert.equal(m.type, "adresse");
  assert.equal(m.street, "Strandby Kirkevej");
  assert.equal(m.house_number, "4");
  assert.equal(m.floor, "st");
  assert.equal(m.door, "th");
  assert.equal(m.zip, "6000");
  assert.equal(m.city, "Kolding");
  assert.equal(m.municipality_code, 621);
  assert.equal(m.municipality_name, "Kolding");
  assert.equal(m.way_code, 1234);
  assert.equal(m.position.type, "Point");
  assert.equal(m.position.coordinates.length, 2);
});

test("mapAddress handles a /husnumre/{id} (access address, no adresse wrapper)", () => {
  const resp = {
    status: "ok",
    husnummer: {
      id_lokalid: "h-uuid",
      husnummertekst: "16",
      vejnavn: "Fredericiagade",
      adgangsadressebetegnelse: "Fredericiagade 16, 6000 Kolding",
      adgangspunkt: { koordinater: { x: 497000, y: 6071000 } },
      postnummer: { postnr: "6000", navn: "Kolding" },
      navngivenvejkommunedel: { kommune: "0621", vejkode: "1234" },
    },
  };
  const m = mapAddress(resp);
  assert.equal(m.id, "h-uuid");
  assert.equal(m.type, "adgangsadresse");
  assert.equal(m.address, "Fredericiagade 16, 6000 Kolding");
  assert.equal(m.floor, null);
  assert.equal(m.municipality_name, "Kolding");
});
