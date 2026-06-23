# @coignite/danish-addresses-kds-js

Reusable JS for **Klimadatastyrelsen Adressevælger** (the DAWA replacement, `adressevaelger.dk`).
Two layers, no framework, no DOM in the core. Used by the Vue `demo/` and the WordPress affaldsshop
checkout — one staged machine, no drift.

```
src/adressevaelger/
  client.js        Layer A — API client: search, lookupById/resolve, mapAddress (pure, isomorphic)
  autocomplete.js  Layer B — headless staged controller (VEJ→HUS→ADR), no DOM
  util.js          normKommune, normKommuneList, parseTail, utm32ToWgs84
  kommuner.js      canonical kommunekode→name table (fills a municipality field for ANY kommune)
  index.js         barrel (ESM entry)
src/adapters/
  affaldsshop-checkout.js   vanilla-DOM, self-mounting WooCommerce adapter (built to the IIFE widget)
```

## Use — API client
```js
import { createClient } from '@coignite/danish-addresses-kds-js';
const client = createClient({ token: ADRESSEVAELGER_TOKEN });
await client.search({ resource: 'accessAddresses', street: 'Akseltorv', municipalityCode: '621' });
const addr = await client.resolve(darId);   // id -> normalized {street, zip, city, municipality_name, position:[lon,lat], …}
```

## Use — headless autocomplete
```js
import { createClient, createAutocomplete } from '@coignite/danish-addresses-kds-js';
const ac = createAutocomplete(createClient({ token }), { municipalityCode: '621', accessAddressOnly: false });
const unsub = ac.subscribe(state => render(state));   // {stage,query,ghost,suggestions,activeIdx,loading,value}
ac.setQuery('Akseltorv'); ac.moveActive(1); ac.choose(0); ac.clear();
```
The controller owns `query`; the view renders from `state` and forwards input/keys. See `demo/AddressAutocomplete.vue`
(Vue view) and `src/adapters/affaldsshop-checkout.js` (vanilla view) for the two reference bindings.

## Configuration reference

Every documented Adressevælger API parameter is reachable. Cross-checked against the official KDS docs
(Confluence "Adressevælger - Fonetisk søgning" / "Opslag med ID"); search is phonetic/case-insensitive with
an implicit wildcard (no `fuzzy` toggle exists — it is always on).

**`createClient(opts)`**

| option | default | purpose |
|---|---|---|
| `token` | — (required) | API token, sent on every call |
| `baseUrl` | `https://adressevaelger.dk` | override the host (e.g. staging) |
| `fetch` | `globalThis.fetch` | inject fetch (old Node) |
| `onRequest` | — | `(redactedUrl) => void` hook for logging/debug |

`client.search(params)` accepts English option names (Danish API names accepted as aliases): `resource`
(`'addresses'`/`'accessAddresses'`), `text` OR `street`, `houseNumber`, `postalCode`, `floor`, `door`,
`municipalityCode` (single/array/comma), `maxResults` (≤200), `includeProvisional`. `client.lookupById(id,{type})`
/ `client.resolve(id)` cover the id-lookup endpoints.

**`createAutocomplete(client, opts)`**

| option | default | purpose |
|---|---|---|
| `municipalityCode` | `''` | municipality filter — `''` (all), `'621'`, or `['661','665',…]` (comma-union) |
| `accessAddressOnly` | `false` | `true` = finish at the access address (no floor/door) |
| `minLength` | `1` | chars before street search |
| `debounce` | `180` | ms between keystrokes → street search |
| `maxResults` | `10` | suggestions shown |
| `includeProvisional` | `false` | include provisional addresses |

**Option naming.** Public options are **English**; the Danish API/KDS-component names are accepted as
**aliases** so existing configs work unchanged:

| English (canonical) | accepted aliases |
|---|---|
| `baseUrl` | `apiUrl` |
| `municipalityCode` | `kommuneKode`, `kommunekode` |
| `accessAddressOnly` | `stopAtAdgang`, `adgangsadresserOnly` |
| `maxResults` | `maksimum` |
| `includeProvisional` | `medtagForeloebige` |
| `street` / `text` / `houseNumber` / `postalCode` / `floor` / `door` (search) | `vejnavn` / `tekst` / `husnummer` / `postnummer` / `etage` / `doer` |

Only the raw HTTP query sent to `adressevaelger.dk` uses the Danish names (required by the API).

**Affaldsshop widget — `window.AFFALDSSHOP_ADDRESS_CONFIG`** (set per site before the IIFE loads): all of the
above (`token`, `baseUrl`, `municipalityCode`, `accessAddressOnly`, `minLength`, `debounce`, `maxResults`,
`includeProvisional`) plus `lockCityZip` (default `true`), `debug` (default `false`), and `selectors`
(`address`/`city`/`zip`/`municipalityName`, defaulting to the WooCommerce ids). Normally a site only sets
`{ municipalityCode }`.

## Build & test
```bash
npm install
npm run build       # dist/index.mjs (ESM)  +  dist/affaldsshop-checkout.<ver>.js (IIFE for WP)
npm test            # deterministic: pure helpers + controller (mocked client, no network)
npm run test:live   # smoke test against the live API (network)
```

## Affaldsshop checkout behaviour
On the WooCommerce checkout the adapter:
- mounts the picker on `#billing_address_1`; the dropdown reuses the old `dawa-autocomplete-*` CSS classes.
- on selection writes the **address head** (street + no. [+ floor/door], zip/city stripped) into the address
  field, and the resolved **zip → `#billing_postcode`**, **city → `#billing_city`** (derived from the API, not
  from any pasted text).
- **locks** city/zip (blocks manual typing, `autocomplete=off`).
- fills `#order_municipality_name` for **any** municipality **iff** that element exists (one id-lookup).
- **clears the derived fields the moment the address is edited away from a resolved selection** — so a failed
  paste or further typing can never submit stale city/zip/kommune. They only repopulate on a fresh pick.

## Affaldsshop deployment
The IIFE `dist/affaldsshop-checkout.<ver>.js` is published to `https://widgets.genbrugscms.cloud/`
(via Buddy CI; versioned filename = cache-busting) and enqueued by the theme. It self-mounts from
`window.AFFALDSSHOP_ADDRESS_CONFIG` (set per site, normally just `{ municipalityCode }`). Live replica:
`examples/affaldsshop-checkout.html`.

## Verified API behaviour (live, 2026-06)
- `token=` required; CORS open (browser-direct).
- `kommuneKode` filters in **both** `tekst` and `vejnavn` modes; 4-digit zero-padded; **multiple = comma**
  (pipe → HTTP 400). (Corrects the older `Adressevaelger-API-Guide.md` claim.)
- Apartments drill via `/adresser/soeg?...&husnummer=`; coordinates are EPSG:25832 (reprojected by `utm32ToWgs84`).

## Smarter than the raw API

The service is format-strict; live testing found inputs it silently fails on. The library compensates:

| User types | Raw API | Library |
|---|---|---|
| `Edvard Thomsens Vej 87, 5th` (glued floor+door) | 16 hits, floor/door ignored | normalized to `… 5 th` → **resolves to 5. th** |
| `Vej87` / `Akseltorv2` (no space) | 0 hits | space inserted → resolves |
| `5.th` / `5TH` / `5. t.h.` | miss / ignored | all normalized to `5 th` |
| whole address / paste incl. zip+city | only works if perfectly formatted | parsed + free-text resolved |
| `etage=05` / `doer=TH` (structured) | ignored | n/a (we use free-text + client-side filtering) |

How it works — we **don't trust a single rewrite**; when we detect a unit-level input we ask the API several
authoritative ways in parallel and merge, so a lossy guess can't hide a valid result:

- **`parseAddress` / `normalizeQuery`** (`util.js`, pure-tested) decompose the input into street/house/floor/door
  and produce a normalized string.
- **Direct mode** (only when a house number is detected — paste / whole address / odd floor-door; never during
  plain street browsing, and debounced) fires up to three queries **in parallel** and merges most-specific-first,
  deduped by id:
  1. **structured** `vejnavn+husnummer+etage+doer` from the parsed parts — exact, no string-guess (only when a
     floor/door is present, since `husnummer` is a prefix match);
  2. **free-text on the normalized string** (fixes glued tokens / missing spaces);
  3. **free-text on the raw string** — only when normalization changed it, so the original is still consulted.
  If everything is empty it escalates to the staged street picker.
- Plain street names use the staged street→house→floor/door picker (single search per step). Phonetic typo
  tolerance (e.g. `Edvar Tomsens Vej`) is handled by the API itself.

So extra requests happen only for genuine unit-level input, not on every keystroke — and the precise (structured)
match leads the list while broader matches are still surfaced below.

## Planned: Adressevask (address validation)
KDS ships a sibling **Adressevask** service (validation / "address wash", the DAWA datavask replacement).
It is **not yet released**, so there is no `adressevask/` module here. When available it will add
`createValidator(...)` to validate/clean a typed or pre-filled address (e.g. clear the checkout fields on a
no-match — the old Nomi4s blur/load behaviour). Tracked, not built.
