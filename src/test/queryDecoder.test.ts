import * as assert from 'assert';
import {
  classifySelection,
  decodeSelection,
  prettyPrintQastle,
  renderQueryDocument,
} from '../queryDecoder';

// A real qastle selection, as produced by
// FuncADLQuery().Where(lambda e: e.Electrons.Count() > 2)
//               .Select(lambda e: {"pt": e.Electrons.Select(lambda el: el.pt / 1000.0)})
const QASTLE =
  "(call Select (call Where (call EventDataset 'bogus.root' 'CollectionTree') " +
  "(lambda (list e) (> (call (attr (attr e 'Electrons') 'Count')) 2))) " +
  "(lambda (list e) (dict (list 'pt') (list (call (attr (attr e 'Electrons') 'Select') " +
  "(lambda (list el) (/ (attr el 'pt') 1000.0)))))))";

const PYTHON_SOURCE = [
  'def run_query(input_filenames=None):',
  '    import uproot',
  '    with uproot.open({input_filenames: "Events"}) as o:',
  '        return {"met": o["MET_pt"].array()}',
].join('\n');

suite('queryDecoder.ts - classifySelection', () => {
  test('recognizes each of the four selection encodings', () => {
    assert.strictEqual(classifySelection(QASTLE), 'qastle');
    // UprootRawQuery serializes a JSON array, TopCPQuery a JSON object.
    assert.strictEqual(classifySelection('[{"treename": "Events"}]'), 'json');
    assert.strictEqual(classifySelection('{"reco": "...", "max_events": 10}'), 'json');
    assert.strictEqual(
      classifySelection(Buffer.from(PYTHON_SOURCE).toString('base64')),
      'python'
    );
  });

  test('tolerates surrounding whitespace', () => {
    assert.strictEqual(classifySelection(`  \n${QASTLE}\n `), 'qastle');
  });

  test('reports anything that fits no encoding as unknown', () => {
    // Right alphabet, wrong length - not base64, so not Python source.
    assert.strictEqual(classifySelection('abcde'), 'unknown');
    assert.strictEqual(classifySelection('not a selection at all'), 'unknown');
    assert.strictEqual(classifySelection(''), 'unknown');
  });
});

suite('queryDecoder.ts - decodeSelection', () => {
  test('pretty-prints a JSON selection', () => {
    const decoded = decodeSelection('[{"treename":"Events","filter_name":["MET_pt"]}]');

    assert.strictEqual(decoded?.kind, 'json');
    assert.strictEqual(decoded?.language, 'jsonc');
    assert.strictEqual(
      decoded?.body,
      ['[', '  {', '    "treename": "Events",', '    "filter_name": [', '      "MET_pt"', '    ]', '  }', ']'].join(
        '\n'
      )
    );
  });

  test('recovers the literal source of a python-function query', () => {
    const decoded = decodeSelection(Buffer.from(PYTHON_SOURCE).toString('base64'));

    assert.strictEqual(decoded?.kind, 'python');
    assert.strictEqual(decoded?.language, 'python');
    assert.strictEqual(decoded?.body, PYTHON_SOURCE);
  });

  test('leaves qastle alone - only a Python interpreter can decode it', () => {
    assert.strictEqual(decodeSelection(QASTLE), undefined);
  });

  test('rejects a base64-shaped string that decodes to binary', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');

    assert.strictEqual(decodeSelection(binary), undefined);
  });

  test('rejects malformed JSON rather than showing half a query', () => {
    assert.strictEqual(decodeSelection('[{"treename": '), undefined);
  });
});

suite('queryDecoder.ts - prettyPrintQastle', () => {
  test('breaks a long selection across indented lines', () => {
    const lines = prettyPrintQastle(QASTLE).split('\n');

    assert.ok(lines.length > 1, 'expected the selection to be split over several lines');
    // The node type and function name stay together on the opening line.
    assert.strictEqual(lines[0], '(call Select');
    // Continuation lines are indented under their parent form.
    assert.ok(lines.slice(1).every((l) => l.startsWith('  ')));
  });

  test('keeps short forms on one line', () => {
    assert.strictEqual(prettyPrintQastle("(call EventDataset 'bogus.root')"), "(call EventDataset 'bogus.root')");
  });

  test('round-trips the tokens: nothing is dropped or duplicated', () => {
    const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

    assert.strictEqual(squash(prettyPrintQastle(QASTLE)), squash(QASTLE));
  });

  test('keeps quoted strings intact, including parens and spaces inside them', () => {
    const selection = "(call EventDataset 'a (weird) name' 'CollectionTree')";

    assert.strictEqual(prettyPrintQastle(selection), selection);
  });

  test("doesn't throw on an unbalanced selection", () => {
    assert.doesNotThrow(() => prettyPrintQastle('(call Select (call Where'));
    assert.doesNotThrow(() => prettyPrintQastle('(call Select))))'));
  });
});

suite('queryDecoder.ts - renderQueryDocument', () => {
  const info = {
    requestId: 'req-1',
    title: 'My Sample',
    backend: 'uchicago',
    codegen: 'atlasr22',
    did: 'rucio://mc23_13p6TeV.601229',
    resultFormat: 'root-ttree',
  };

  test('heads the document with the request the query came from', () => {
    const doc = renderQueryDocument(info, { kind: 'python', body: 'x = 1', language: 'python' });

    assert.ok(doc.startsWith('# Request: req-1\n'), doc);
    assert.ok(doc.includes('# Title:   My Sample\n'));
    assert.ok(doc.includes('# Backend: uchicago\n'));
    assert.ok(doc.includes('# Dataset: rucio://mc23_13p6TeV.601229\n'));
    assert.ok(doc.includes('# Codegen: atlasr22\n'));
    assert.ok(doc.includes('# Format:  root-ttree\n'));
    assert.ok(doc.endsWith('\nx = 1\n'));
  });

  test('omits header fields that are unknown', () => {
    const doc = renderQueryDocument(
      { requestId: 'req-1' },
      { kind: 'python', body: 'x = 1', language: 'python' }
    );

    assert.ok(doc.includes('# Request: req-1\n'));
    for (const label of ['Title', 'Backend', 'Dataset', 'Codegen', 'Format']) {
      assert.ok(!doc.includes(`# ${label}:`), `expected no ${label} line in:\n${doc}`);
    }
  });

  test('comments the header with // for a JSON selection', () => {
    const doc = renderQueryDocument(info, { kind: 'json', body: '[]', language: 'jsonc' });

    assert.ok(doc.startsWith('// Request: req-1\n'), doc);
    assert.ok(!doc.includes('# '));
  });

  test('warns instead of describing the kind when the body is a fallback', () => {
    const doc = renderQueryDocument(info, {
      kind: 'qastle',
      body: '(call Select)',
      language: 'plaintext',
      warning: 'Showing the raw qastle: no interpreter found.',
    });

    assert.ok(doc.includes('# Showing the raw qastle: no interpreter found.'));
    // The "recovered from qastle" blurb would be a lie here.
    assert.ok(!doc.includes('Recovered from the qastle'));
  });
});
