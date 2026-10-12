# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-12

### Added
- `mapAddress` (and so `lookupById` / `resolve`) returns `status`: the DAR status of the adresse resp. husnummer
  as a number (2 foreløbig, 3 gældende, 4 nedlagt, 5 henlagt), or `null` when absent. Appended as the last key;
  every existing key, value and key order is unchanged.
- Golden test suite on recorded KDS responses (`test/fixtures/kds`), pinned to the 0.2.1 output.

### Notes
- `search` already returned the raw KDS rows; a `status` on a hit would pass through untouched. KDS does not send
  one today (verified 2026-10-12).

## [0.2.1] - 2026-08-14

### Changed
- Package metadata: repository, homepage, bugs.

## [0.2.0] - 2026-06-23

### Added
- Initial release: KDS Adressevælger client (`search`, `lookupById`/`resolve`, `mapAddress`) and the
  framework-agnostic staged autocomplete controller.
