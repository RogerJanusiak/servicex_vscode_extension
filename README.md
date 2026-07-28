# ServiceX VS Code Extension

A VS Code extension for managing [ServiceX](https://github.com/ssl-hep/ServiceX_frontend)
transform caches and jobs.

It adds a "ServiceX" icon to the Activity Bar with a "Cached Transforms" view,
which lists every transform request in your local ServiceX cache, grouped by
title and refreshed from the backend.

Hovering over a row gives you:
- On a single request: **Delete from Cache** - removes its downloaded files
  and cache record.
- On a title group: **Clean Old Requests** - keeps only the most recently
  submitted request under that title and deletes the rest, or **Delete
  Entire Group** - removes every locally cached request under that title.

## Development

```bash
npm install
```

Then open this folder in VS Code and press `F5` to launch an Extension
Development Host with the extension loaded.
