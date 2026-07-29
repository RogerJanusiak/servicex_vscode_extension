import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, selectEndpoint, orderedEndpoints } from '../config';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-config-test-'));
}

/** TS's `import * as os` types homedir() as read-only even though the
 *  underlying CommonJS module object is a plain mutable object at runtime -
 *  hence the cast. Returns a function that restores the original. */
function stubHomedir(dir: string): () => void {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
}

const sampleYaml = `
api_endpoints:
  - name: alpha
    endpoint: https://alpha.example.org
    token: alpha-token
  - name: beta
    endpoint: https://beta.example.org
    token: beta-token
default-endpoint: alpha
cache-path: \${cachePath}
`;

/** Writes a servicex.yaml with a substituted cache path, at the given dir. */
function writeConfig(dir: string, cachePath: string, filename = 'servicex.yaml'): void {
  fs.writeFileSync(path.join(dir, filename), sampleYaml.replace('${cachePath}', cachePath));
}

suite('config.ts', () => {
  let root: string;

  setup(() => {
    root = mkTmpDir();
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loadConfig finds servicex.yaml by walking up from a nested directory', () => {
    const cachePath = path.join(root, 'cache');
    writeConfig(root, cachePath);
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });

    const config = loadConfig(undefined, nested);

    assert.strictEqual(config.configFile, path.join(root, 'servicex.yaml'));
    assert.strictEqual(config.defaultEndpoint, 'alpha');
    assert.deepStrictEqual(
      config.endpoints.map((e) => e.name),
      ['alpha', 'beta']
    );
    assert.strictEqual(config.cachePath, cachePath);
  });

  test('loadConfig skips a same-named .servicex directory and keeps walking up', () => {
    // Reproduces the real-world collision: the servicex Python client creates
    // a .servicex/ *directory* inside cache_path to hold its TinyDB cache.
    // A naive existence check would try to read that directory as YAML and
    // crash with EISDIR.
    const cachePath = path.join(root, 'downloads');
    fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
    writeConfig(root, cachePath);

    const config = loadConfig(undefined, cachePath);

    assert.strictEqual(config.configFile, path.join(root, 'servicex.yaml'));
  });

  test('loadConfig prefers .servicex over servicex.yaml in the same directory', () => {
    const cachePath = path.join(root, 'cache');
    writeConfig(root, cachePath, '.servicex');
    writeConfig(root, cachePath, 'servicex.yaml');

    const config = loadConfig(undefined, root);

    assert.strictEqual(config.configFile, path.join(root, '.servicex'));
  });

  test('loadConfig uses an explicit path when given, ignoring startDir entirely', () => {
    const cachePath = path.join(root, 'cache');
    const explicitDir = path.join(root, 'explicit');
    fs.mkdirSync(explicitDir, { recursive: true });
    writeConfig(explicitDir, cachePath, 'my-config.yaml');

    const config = loadConfig(path.join(explicitDir, 'my-config.yaml'), root);

    assert.strictEqual(config.configFile, path.join(explicitDir, 'my-config.yaml'));
  });

  test('loadConfig falls back to the home directory when nothing is found walking up', () => {
    const homeDir = mkTmpDir();
    const cachePath = path.join(homeDir, 'cache');
    writeConfig(homeDir, cachePath);

    const restoreHomedir = stubHomedir(homeDir);
    try {
      const searchDir = path.join(root, 'unrelated', 'nested');
      fs.mkdirSync(searchDir, { recursive: true });

      const config = loadConfig(undefined, searchDir);

      assert.strictEqual(config.configFile, path.join(homeDir, 'servicex.yaml'));
    } finally {
      restoreHomedir();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('loadConfig throws a clear error when no config file exists anywhere', () => {
    const homeDir = mkTmpDir();
    const restoreHomedir = stubHomedir(homeDir);
    try {
      assert.throws(() => loadConfig(undefined, root), /Can't find a \.servicex or servicex\.yaml config file/);
    } finally {
      restoreHomedir();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('loadConfig expands ${USER} and ~ in cache_path', () => {
    fs.writeFileSync(
      path.join(root, 'servicex.yaml'),
      'api_endpoints:\n  - name: alpha\n    endpoint: https://alpha.example.org\ncache-path: ~/servicex-test-${USER}\n'
    );

    const config = loadConfig(undefined, root);

    assert.strictEqual(config.cachePath, path.join(os.homedir(), `servicex-test-${os.userInfo().username}`));
  });

  test('selectEndpoint picks the explicitly requested backend', () => {
    writeConfig(root, path.join(root, 'cache'));
    const config = loadConfig(undefined, root);

    const endpoint = selectEndpoint(config, 'beta');

    assert.strictEqual(endpoint.name, 'beta');
    assert.strictEqual(endpoint.endpoint, 'https://beta.example.org');
  });

  test('selectEndpoint falls back to default-endpoint when none requested', () => {
    writeConfig(root, path.join(root, 'cache'));
    const config = loadConfig(undefined, root);

    assert.strictEqual(selectEndpoint(config).name, 'alpha');
  });

  test('selectEndpoint throws for an unknown backend name', () => {
    writeConfig(root, path.join(root, 'cache'));
    const config = loadConfig(undefined, root);

    assert.throws(() => selectEndpoint(config, 'nonexistent'), /Backend 'nonexistent' not defined/);
  });

  test('orderedEndpoints puts the default/selected backend first, others after', () => {
    writeConfig(root, path.join(root, 'cache'));
    const config = loadConfig(undefined, root);

    assert.deepStrictEqual(
      orderedEndpoints(config).map((e) => e.name),
      ['alpha', 'beta']
    );
    assert.deepStrictEqual(
      orderedEndpoints(config, 'beta').map((e) => e.name),
      ['beta', 'alpha']
    );
  });
});
