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
- **Show Query** - opens the query that produced the request in a scratch
  editor. See below.

## Show Query

The local cache doesn't keep your query - only the hash it was reduced to -
so **Show Query** asks the backend for the transform's `selection` string and
decodes it. What comes back depends on how you submitted the request:

| Query type | Stored as | You get back |
| --- | --- | --- |
| `FuncADLQuery` | qastle (an s-expression form of the Python AST) | Equivalent func_adl source |
| `PythonFunction` | base64 of the function's source | That source, exactly |
| `UprootRawQuery` | JSON | That JSON, exactly |
| `TopCPQuery` | JSON with the YAML inlined | That JSON, exactly |

Only func_adl queries are approximate: qastle preserves the query's
structure, its lambda parameter names, and every literal, so the recovered
source runs the same way - but comments, formatting, and the names of any
intermediate variables you built the query out of aren't in there to recover.

Two things happen to a func_adl query on the way out. The generated
`MetaData(...)` wrappers are removed: the backend packages
(`func_adl_servicex_xaodr25` and friends) add one for every C++ type and
method the query touches - include files, link libraries, injected code - and
a query with a couple of dozen `.pt()` calls can end up under seventy of
them, which buries the Selects you actually wrote. Set
`servicex.showQueryMetadata` to keep them. The result is then laid out over
several lines, using [black](https://black.readthedocs.io) if the interpreter
has it and a built-in fallback formatter otherwise.

Decoding qastle needs a Python interpreter with the `qastle` package, since
there's no JavaScript implementation of it. Anyone who has submitted a
func_adl query already has one (`servicex` depends on `func_adl`, which
depends on `qastle`), and the extension looks for it in this order:

1. `servicex.pythonPath`, if you set it.
2. The interpreter the Python extension has selected for the workspace.
3. `python3`, then `python`, from `PATH`.

If none of those work out, the raw qastle is shown instead, indented for
readability, with a note explaining what to fix. Over Remote-SSH all of this
runs on the remote, alongside the environment you submit queries from.

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
