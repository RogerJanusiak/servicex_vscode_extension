# Change Log

All notable changes to the "ServiceX Helper" extension will be documented in this file.

## [0.6.0] - 2026-08-04

### Added

- **Set Label**: right-click a cached request to attach a free-text label to
  it, shown at the front of its row and in its tooltip. Stored in the
  extension's own `.servicex/labels.json` inside the cache folder -
  independent of anything the servicex Python client's own `db.json` knows
  about - so it survives refreshes and multi-backend fallbacks alike.
  Leaving the label blank clears it, and deleting a request clears its label
  too.

## [0.5.0] - 2026-08-01

### Added

- **Dashboard Transforms** panel: a second view listing every transform the
  configured token can see on each backend, not just what's been downloaded
  locally. Shares the same grouping, filtering and sorting as the cache
  panel. With more than one backend configured, transforms are split into a
  tab per facility - one that returned nothing still gets a tab showing an
  empty state, and one that failed to load shows the actual error rather
  than silently disappearing. Capped at the 30 most recent transforms per
  backend so a busy facility can't crowd out a quieter one.
- **Cancel Transform**: an inline button on any still-running request in the
  Dashboard panel, with a confirmation. Note it stops the transform
  server-side only - files already downloaded stay on disk, and can now be
  removed from the cache panel.
- **Live progress**: expanding a still-running request shows a progress bar
  and refreshes it every few seconds until it finishes or the row is
  collapsed. Only expanded rows are polled.
- The Cached Transforms panel now shows the current size of a running
  transform's output, where the backend supports reporting it.
- **Delete All Cached Transforms** and **Clean All Groups** commands, both
  showing how many requests and how much disk they'll free before asking to
  confirm.

### Fixed

- The cache panel now lists every request directory on disk, not just those
  still recorded in `db.json`. The servicex client creates a download
  directory as soon as a transform starts but only records it on success -
  so cancelled, failed, and re-run transforms left directories behind that
  were invisible to the panel and impossible to delete from it. These now
  appear with their real title and status, and can be deleted individually,
  by group, or all at once.
- **Delete Entire Group** deleted nothing when a group contained cancelled
  requests, because it matched records by title in `db.json` and those
  requests have no record at all. It now deletes by request ID, and covers
  the whole group rather than only the rows a filter leaves visible.
- Downloaded-file counts and sizes are read from disk, so they're shown for
  requests whose cache record no longer exists.
- An expanded request's details stayed frozen at whatever was true when it
  was first expanded, even after a manual refresh.
- Fewer redundant network calls: one API connection is now shared per
  backend for the whole session instead of being rebuilt on every fetch and
  expansion, which was forcing a token refresh and capability check each
  time. A finished transform's size is only looked up once.

## [0.4.1] - 2026-07-31

### Added

- Published to [Open VSX](https://open-vsx.org) in addition to the VS Code
  Marketplace, so editors that don't use the Microsoft Marketplace
  (VSCodium, code-server, Coder, Theia, Gitpod, and similar) can install it
  directly from their extensions panel.

### Fixed

- A cache path that resolves to the servicex Python client's default
  `/tmp/servicex_$USER` (or any other `tmp`-rooted path) is now rehomed
  under the OS temp directory the same way the Python client does. This was
  the cause of the cache always appearing empty on Windows, where no literal
  `/tmp` exists.
- A corrupted local cache database (`db.json`) - e.g. left truncated by a
  process killed mid-write - no longer wipes out the whole Cached Transforms
  view. Every record that's still intact loads normally; only the genuinely
  unreadable ones are skipped, with a warning instead of an error.
- An empty `db.json` (a fresh cache that hasn't been written to yet) is no
  longer mistaken for a corrupted one.
- Packaged `.vsix` no longer bundles the `coverage/` test-report folder.

## [0.4.0] - 2026-07-30

### Added

- **Show Query**: a per-request right-click action that opens the query the
  transform was submitted with in a scratch editor. The query isn't kept in
  the local cache, so it's fetched from the backend as the transform's
  `selection` string and decoded: JSON (uproot-raw, TopCP) and base64'd
  Python function sources come back exactly, and func_adl queries are turned
  back into equivalent func_adl source from their qastle, with the generated
  `MetaData(...)` wrappers removed and the result formatted over several
  lines (via `black` when it's installed).
- `servicex.pythonPath` setting, naming the interpreter used to decode
  func_adl queries. Defaults to the Python extension's selected interpreter,
  then `python3`/`python` from `PATH`; when none of them has the `qastle`
  package, the raw qastle is shown indented instead, with a note saying why.
- `servicex.showQueryMetadata` setting, to keep the generated `MetaData(...)`
  wrappers in the query instead of dropping them.

## [0.2.0] - 2026-07-29

### Added

- Multi-backend fallback: if a cached request isn't found on the default
  backend, every other configured backend is tried in order. Once any
  request needed a fallback, every row shows which backend it actually came
  from (rows are left unlabeled when everything resolves on the default).
- **Clean Old Requests** now also removes failed ("Fatal") requests, not
  just cancelled ones.
- Per-request right-click actions: **Copy Request ID** and **Copy File
  List** (newline-joined paths of that request's downloaded files).
- File counts now show as `Complete`/`Failed`/`Total`, using the backend's
  real completed-file count rather than an approximation.
- Full automated test suite (`npm test`, running inside a real VS Code
  instance via `@vscode/test-cli`) and a GitHub Actions workflow that runs
  it on every push and pull request.

### Changed

- Renamed the extension from "ServiceX" to "ServiceX Helper".

## [0.1.0] - 2026-07-28

### Added

- "ServiceX Helper" Activity Bar view container with a "Cached Transforms" panel,
  listing every transform request in your local ServiceX cache. Requests are
  grouped by title (newest group first, newest request within a group
  first), with each row's status, submit/finish time, and file counts
  refreshed live from the configured backend.
- Refresh button on the Cached Transforms view.
- Per-request action: **Delete from Cache** - removes a single request's
  downloaded files and local cache record.
- Per-group actions:
  - **Clean Old Requests** - keeps only the most recently submitted
    completed request for a title, deleting older completed runs and any
    cancelled runs.
  - **Delete Entire Group** - removes every locally cached request under a
    title, completed or still submitted.
- `servicex.configPath` and `servicex.backend` settings to override how the
  `servicex.yaml`/`.servicex` config file and backend endpoint are resolved
  (defaults to the same directory-walking search the `servicex` Python CLI
  uses).
