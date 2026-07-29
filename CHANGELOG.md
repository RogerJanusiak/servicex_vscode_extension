# Change Log

All notable changes to the "ServiceX Helper" extension will be documented in this file.

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
