import { defineConfig } from '@vscode/test-cli';
import * as os from 'os';
import * as path from 'path';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: [
    // GitHub's macOS runners use a long workspace path
    // (/Users/runner/work/<repo>/<repo>/...), which pushes the default
    // --user-data-dir past macOS's ~103-character limit on Unix domain
    // socket paths, causing "EINVAL: invalid argument ... main.sock".
    // Route it somewhere short instead - harmless on Windows/Linux too.
    `--user-data-dir=${path.join(os.tmpdir(), 'sx-vscode-test')}`,
  ],
});
