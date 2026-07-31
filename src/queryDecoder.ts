/**
 * Turns a transform's `selection` string - the query as ServiceX actually
 * stored it - back into something readable.
 *
 * How a selection is encoded depends on which query class produced it (see
 * `generate_selection_string` on each of them in the servicex Python client):
 *
 *   FuncADLQuery    qastle, an s-expression encoding of the Python AST
 *   PythonFunction  base64 of the function's literal Python source
 *   UprootRawQuery  JSON array of the sub-query dicts
 *   TopCPQuery      JSON object with the reco/parton/particle YAML inlined
 *
 * The last three decode losslessly right here. qastle needs a Python
 * interpreter with the `qastle` package (there is no JS implementation) -
 * see decodeQastle in pythonBridge.ts; `prettyPrintQastle` is the fallback
 * for when no such interpreter can be found.
 */

export type SelectionKind = 'qastle' | 'json' | 'python' | 'unknown';

export interface DecodedSelection {
  kind: SelectionKind;
  /** Decoded query text to show in the editor. */
  body: string;
  /** Language id to open the document with. */
  language: string;
  /** Set when `body` isn't the fully decoded query, explaining why. */
  warning?: string;
}

/**
 * Which of the four encodings a selection uses, decided by shape rather than
 * by the record's codegen: the shapes are unambiguous, and it keeps this
 * working for a request whose local cache record has gone missing.
 */
export function classifySelection(selection: string): SelectionKind {
  const trimmed = selection.trim();
  if (trimmed.startsWith('(')) {
    return 'qastle';
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return 'json';
  }
  if (isBase64(trimmed)) {
    return 'python';
  }
  return 'unknown';
}

/**
 * Strict enough not to mistake some other encoding for base64: the alphabet
 * has to match exactly and the string has to survive a decode/re-encode
 * round trip (Node's decoder silently ignores anything it doesn't like).
 */
function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

/**
 * Decode everything except qastle. Returns undefined for a qastle selection
 * (the caller has to go through Python for those) and for anything that
 * turns out not to decode after all.
 */
export function decodeSelection(selection: string): DecodedSelection | undefined {
  const trimmed = selection.trim();
  switch (classifySelection(trimmed)) {
    case 'json': {
      try {
        return {
          kind: 'json',
          body: JSON.stringify(JSON.parse(trimmed), null, 2),
          language: 'jsonc',
        };
      } catch {
        return undefined;
      }
    }
    case 'python': {
      const source = Buffer.from(trimmed, 'base64').toString('utf8');
      // A base64-shaped string that decodes to control characters was never
      // Python source - better to show the raw selection than mojibake.
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) {
        return undefined;
      }
      return { kind: 'python', body: source.trim(), language: 'python' };
    }
    default:
      return undefined;
  }
}

type QastleNode = string | QastleNode[];

/**
 * Split a qastle s-expression into parens and atoms. Atoms are identifiers,
 * numeric literals, operator symbols, and quoted strings (either quote
 * character, with backslash escapes) - see qastle's syntax.lark.
 */
function tokenizeQastle(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== c) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i++; // closing quote (or end of input on an unterminated literal)
      tokens.push(text.slice(start, Math.min(i, text.length)));
    } else {
      const start = i;
      while (i < text.length && !/[\s()]/.test(text[i]) && text[i] !== "'" && text[i] !== '"') {
        i++;
      }
      tokens.push(text.slice(start, i));
    }
  }
  return tokens;
}

function parseQastle(tokens: string[]): QastleNode[] {
  const stack: QastleNode[][] = [[]];
  for (const token of tokens) {
    if (token === '(') {
      const child: QastleNode[] = [];
      stack[stack.length - 1].push(child);
      stack.push(child);
    } else if (token === ')') {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      stack[stack.length - 1].push(token);
    }
  }
  return stack[0];
}

function renderInline(node: QastleNode): string {
  return typeof node === 'string' ? node : `(${node.map(renderInline).join(' ')})`;
}

const WRAP_WIDTH = 90;

function renderNode(node: QastleNode, indent: string): string {
  const inline = renderInline(node);
  if (typeof node === 'string' || indent.length + inline.length <= WRAP_WIDTH) {
    return inline;
  }
  // Fill the opening line with the node type and as many whole children as
  // fit - `(call Select` and `(lambda (list e)` read far better than a bare
  // `(call` with everything after it indented underneath. Once a child is
  // too big to sit inline, it and every child after it get their own line.
  const [head, ...rest] = node;
  const childIndent = indent + '  ';
  let line = `(${typeof head === 'string' ? head : renderNode(head, childIndent)}`;
  const broken: QastleNode[] = [];
  for (const child of rest) {
    const candidate = renderInline(child);
    if (broken.length === 0 && indent.length + line.length + 1 + candidate.length <= WRAP_WIDTH) {
      line += ` ${candidate}`;
    } else {
      broken.push(child);
    }
  }
  const children = broken.map((child) => `\n${childIndent}${renderNode(child, childIndent)}`);
  return `${line}${children.join('')})`;
}

/**
 * Indent a qastle s-expression across lines so it can at least be read when
 * no interpreter is available to turn it back into func_adl source. Forms
 * short enough to fit stay on one line.
 */
export function prettyPrintQastle(selection: string): string {
  const nodes = parseQastle(tokenizeQastle(selection));
  return nodes.map((node) => renderNode(node, '')).join('\n');
}

export interface QueryDocumentInfo {
  requestId: string;
  title?: string;
  backend?: string;
  codegen?: string;
  did?: string;
  resultFormat?: string;
}

const COMMENT_PREFIX: Record<string, string> = { jsonc: '//', python: '#', plaintext: '#' };

const KIND_DESCRIPTION: Record<SelectionKind, string> = {
  qastle:
    'Recovered from the qastle the backend stored. Semantically the query you\n' +
    'submitted, but comments and local variable names are not recoverable.',
  python: 'The literal source of the function submitted with this query.',
  json: 'The query exactly as it was submitted.',
  unknown: "This selection didn't match any encoding this extension knows how to decode.",
};

/**
 * Assemble the document shown to the user: a header naming the request the
 * query came from, then the decoded query itself.
 */
export function renderQueryDocument(info: QueryDocumentInfo, decoded: DecodedSelection): string {
  const comment = COMMENT_PREFIX[decoded.language] ?? '#';
  const fields: [string, string | undefined][] = [
    ['Request', info.requestId],
    ['Title', info.title],
    ['Backend', info.backend],
    ['Dataset', info.did],
    ['Codegen', info.codegen],
    ['Format', info.resultFormat],
  ];
  const lines = fields
    .filter((f): f is [string, string] => !!f[1])
    .map(([label, value]) => `${comment} ${`${label}:`.padEnd(9)}${value}`);

  // A warning means the body isn't what the kind description promises (raw
  // qastle rather than func_adl source, say), so it replaces the description
  // rather than following it.
  lines.push(`${comment}`);
  for (const line of (decoded.warning ?? KIND_DESCRIPTION[decoded.kind]).split('\n')) {
    lines.push(`${comment} ${line}`);
  }

  return `${lines.join('\n')}\n\n${decoded.body}\n`;
}
