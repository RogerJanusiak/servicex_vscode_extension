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

function expandCachePath(rawPath: string | undefined): string {
  const username = os.userInfo().username;
  let p = rawPath ?? `/tmp/servicex_\${USER}`;
  p = p.replace('${USER}', username);
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return p;
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
