# ServiceX Helper

A VS Code extension for managing [ServiceX](https://github.com/ssl-hep/ServiceX_frontend)
transform caches and jobs.

It adds a "ServiceX Helper" icon to the Activity Bar with a "Cached Transforms" view,
which lists every transform request in your local ServiceX cache, grouped by
title and refreshed from the backend.

Hovering over a row gives you:
- On a single request: **Delete from Cache** - removes its downloaded files
  and cache record.
- On a title group: **Clean Old Requests** - keeps only the most recently
  submitted completed request under that title, deleting older completed
  runs plus any cancelled or failed ones, or **Delete Entire Group** -
  removes every locally cached request under that title.

Right-clicking a single request also gives you:
- **Copy Request ID** - copies the request ID to the clipboard.
- **Copy File List** - copies the paths of that request's downloaded files
  (one per line) to the clipboard.

## Development

```bash
npm install
```

Then open this folder in VS Code and press `F5` to launch an Extension
Development Host with the extension loaded.

### Testing

```bash
npm test
```

Runs the full test suite inside a real (headless) VS Code instance via
[`@vscode/test-cli`](https://www.npmjs.com/package/@vscode/test-cli). Also
runs automatically on every push and pull request via
[`.github/workflows/test.yml`](.github/workflows/test.yml).

## License

[BSD 3-Clause](LICENSE)
