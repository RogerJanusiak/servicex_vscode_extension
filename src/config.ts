import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';

export interface EndpointConfig {
  name: string;
  endpoint: string;
  token?: string;
}

export interface ServiceXConfig {
  endpoints: EndpointConfig[];
  defaultEndpoint?: string;
  cachePath: string;
  configFile: string;
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Search for a `.servicex` or `servicex.yaml` file, walking up from `startDir`
 * and finally falling back to the home directory. Mirrors
 * `Configuration._add_from_path` in the servicex Python client.
 *
 * Must check `isFile()`, not just existence: the servicex client creates a
 * `.servicex/` *directory* inside `cache_path` to hold its local TinyDB
 * cache, so a same-named directory can shadow the real config file if the
 * search starts at or below the cache directory.
 */
function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  while (true) {
    const dotFile = path.join(dir, '.servicex');
    if (isRegularFile(dotFile)) return dotFile;
    const yamlFile = path.join(dir, 'servicex.yaml');
    if (isRegularFile(yamlFile)) return yamlFile;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const home = os.homedir();
  for (const name of ['.servicex', 'servicex.yaml']) {
    const candidate = path.join(home, name);
    if (isRegularFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Split `p` into its root (a drive letter like `C:`, a bare POSIX-style `/`,
 * or undefined for a relative path) and its remaining segments - the pieces
 * `remapTmpSegment` needs to reproduce Python's `PurePath(p).parts`, which
 * treats a leading `/` as its own part distinct from what follows it
 * regardless of platform.
 */
function splitRoot(p: string): { root: string | undefined; segments: string[] } {
  const drive = /^([A-Za-z]:)[\\/]/.exec(p);
  if (drive) {
    return { root: drive[1], segments: p.slice(drive[0].length).split(/[\\/]+/).filter(Boolean) };
  }
  if (/^[\\/]/.test(p)) {
    return { root: '/', segments: p.replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean) };
  }
  return { root: undefined, segments: p.split(/[\\/]+/).filter(Boolean) };
}

/**
 * Mirrors `Configuration.expand_cache_path` in the servicex Python client:
 * a path whose first segment past the root is literally `tmp` gets rehomed
 * under the OS temp directory instead of being treated as a literal path.
 *
 * The client's default cache-path is `/tmp/servicex_${USER}` on every
 * platform. On POSIX that's a no-op - the real tmpdir usually is `/tmp` -
 * but on Windows there is no such literal path, so the client actually
 * creates (and later reads) its cache under `%TEMP%\servicex_<user>`. Without
 * this remap the extension computes a cache path the Python client never
 * wrote to, so every request looks uncached - this is the whole reason a
 * fresh Windows install can show "No cached transform requests found" for a
 * user who has plenty of requests.
 */
function remapTmpSegment(p: string): string {
  const { root, segments } = splitRoot(p);
  // Python indexes `parts[1]` unconditionally: for an absolute path that's
  // the first segment past the root; for a relative path `parts[0]` is
  // itself a real segment, so it's the *second* one that has to be "tmp".
  const tmpIndex = root === undefined ? 1 : 0;
  if (segments[tmpIndex] !== 'tmp') {
    return p;
  }
  return path.join(os.tmpdir(), ...segments.slice(tmpIndex + 1));
}

function expandCachePath(rawPath: string | undefined): string {
  const username = os.userInfo().username;
  let p = rawPath ?? `/tmp/servicex_\${USER}`;
  p = p.replace('${USER}', username);
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return remapTmpSegment(p);
}

export function loadConfig(explicitConfigPath?: string, startDir?: string): ServiceXConfig {
  const configFile = explicitConfigPath ?? findConfigFile(startDir ?? process.cwd());
  if (!configFile || !fs.existsSync(configFile)) {
    throw new Error(
      "Can't find a .servicex or servicex.yaml config file" +
        (explicitConfigPath ? ` at ${explicitConfigPath}` : '')
    );
  }

  const doc = YAML.parse(fs.readFileSync(configFile, 'utf8')) ?? {};
  const endpoints: EndpointConfig[] = (doc.api_endpoints ?? []).map((e: any) => ({
    name: e.name,
    endpoint: e.endpoint,
    token: e.token,
  }));

  return {
    endpoints,
    defaultEndpoint: doc['default-endpoint'] ?? doc.default_endpoint,
    cachePath: expandCachePath(doc['cache-path'] ?? doc.cache_path),
    configFile,
  };
}

export function selectEndpoint(config: ServiceXConfig, backendName?: string): EndpointConfig {
  const name = backendName ?? config.defaultEndpoint ?? config.endpoints[0]?.name;
  const found = config.endpoints.find((e) => e.name === name);
  if (!found) {
    const valid = config.endpoints.map((e) => e.name).join(', ');
    throw new Error(`Backend '${name}' not defined in ${config.configFile}. Valid backends: ${valid}`);
  }
  return found;
}

/**
 * All configured endpoints, ordered with the selected/default one first and
 * every other configured backend after it (in whatever order they appear in
 * the config file). Used to fall back to other backends when a request
 * can't be found on the default one.
 */
export function orderedEndpoints(config: ServiceXConfig, backendName?: string): EndpointConfig[] {
  const selected = selectEndpoint(config, backendName);
  const others = config.endpoints.filter((e) => e.name !== selected.name);
  return [selected, ...others];
}
