/**
 * Quotes `value` the way Python's `repr()` would: single-quoted, unless the
 * string contains a single quote and no double quote (then double-quoted
 * instead), with backslashes and control characters escaped.
 *
 * The backslash escaping matters most on Windows, where a real file path is
 * full of them: `C:\Users\me\a.root` has to come out as
 * `'C:\\Users\\me\\a.root'`, exactly as Python would print it. Emitting the
 * raw path instead wouldn't just look different - `'C:\Users\...'` isn't
 * valid Python at all, since `\U` starts a unicode escape.
 */
export function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    if (ch === '\\' || ch === quote) {
      out += `\\${ch}`;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else {
      out += ch;
    }
  }
  return out + quote;
}

/**
 * Renders one sample's file list exactly the way it would print if you'd
 * gotten it back from `deliver()` yourself: `deliver()` returns a dict
 * mapping each Sample's title to a `GuardList` of its files, and
 * `GuardList.__repr__` is just `repr()` of that underlying list - see
 * `_output_handler` and `GuardList` in the servicex Python client's
 * `servicex_client.py`. Pasteable straight into a Python script.
 */
export function pythonFileListLiteral(title: string, files: string[]): string {
  return `{${pythonRepr(title)}: [${files.map(pythonRepr).join(', ')}]}`;
}
