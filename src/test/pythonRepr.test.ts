import * as assert from 'assert';
import { pythonRepr, pythonFileListLiteral } from '../pythonRepr';

suite('pythonRepr.ts - pythonRepr', () => {
  test('single-quotes a plain string', () => {
    assert.strictEqual(pythonRepr('hello'), "'hello'");
  });

  test('escapes backslashes, so a Windows path round-trips as valid Python', () => {
    // The whole point: 'C:\Users\...' isn't just cosmetically wrong, it
    // isn't valid Python - \U starts a unicode escape and raises a
    // SyntaxError. Hard-coded rather than built from path.join() so this
    // holds on every platform, not just Windows.
    assert.strictEqual(
      pythonRepr('C:\\Users\\me\\a.root'),
      "'C:\\\\Users\\\\me\\\\a.root'"
    );
  });

  test('switches to double quotes when the value contains a single quote but no double quote', () => {
    assert.strictEqual(pythonRepr("it's"), '"it\'s"');
  });

  test('stays single-quoted and escapes the quote when the value contains both quote kinds', () => {
    assert.strictEqual(pythonRepr(`it's a "test"`), `'it\\'s a "test"'`);
  });

  test('leaves a double quote alone inside a single-quoted string', () => {
    assert.strictEqual(pythonRepr('say "hi"'), `'say "hi"'`);
  });

  test('escapes newlines, carriage returns and tabs', () => {
    assert.strictEqual(pythonRepr('a\nb\rc\td'), "'a\\nb\\rc\\td'");
  });

  test('renders an empty string', () => {
    assert.strictEqual(pythonRepr(''), "''");
  });
});

suite('pythonRepr.ts - pythonFileListLiteral', () => {
  test('renders a title and its files as a Python dict literal', () => {
    assert.strictEqual(
      pythonFileListLiteral('MySample', ['/a/one.root', '/a/two.root']),
      "{'MySample': ['/a/one.root', '/a/two.root']}"
    );
  });

  test('escapes Windows paths in the file list', () => {
    assert.strictEqual(
      pythonFileListLiteral('MySample', ['C:\\tmp\\one.root']),
      "{'MySample': ['C:\\\\tmp\\\\one.root']}"
    );
  });

  test('escapes a title containing a quote', () => {
    assert.strictEqual(pythonFileListLiteral("Roger's run", []), `{"Roger's run": []}`);
  });

  test('renders an empty file list', () => {
    assert.strictEqual(pythonFileListLiteral('MySample', []), "{'MySample': []}");
  });
});
