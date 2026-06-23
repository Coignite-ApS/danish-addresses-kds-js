/**
 * @coignite/danish-addresses-kds-js — Klimadatastyrelsen Adressevælger (DAWA replacement).
 *
 * Two layers:
 *   - createClient   : pure API client (search + id lookup + mapAddress), isomorphic, no DOM
 *   - createAutocomplete : framework-agnostic staged autocomplete controller (no DOM)
 *
 * Address VALIDATION (KDS "Adressevask") is a planned sibling module — not yet implemented
 * because the KDS API is not released. It will live under ./adressevask when available.
 */
export { createClient, mapAddress } from "./client.js";
export { createAutocomplete } from "./autocomplete.js";
export { normKommune, normKommuneList, utm32ToWgs84, parseTail } from "./util.js";
export { KOMMUNER, kommuneNavn } from "./kommuner.js";
