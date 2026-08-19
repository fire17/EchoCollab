import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };

// Four segments so a running page names its exact deploy: the semver from
// package.json, then the CI run number (0 for a local build). The commit is
// carried alongside it, because a version alone cannot tell two builds of the
// same commit apart.
const BUILD = process.env.GITHUB_RUN_NUMBER || '0';
const SHA = (() => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try { return execSync('git rev-parse --short=7 HEAD').toString().trim(); } catch { return 'local'; }
})();

// In dev, Vite serves the app and proxies the realtime paths to the relay, so
// the client can always talk to its own origin and never needs a port baked in.
const RELAY = process.env.RELAY || 'localhost:1234';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}.${BUILD}`),
    __APP_SHA__: JSON.stringify(SHA),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://${RELAY}`, ws: true },
      '/rtt': { target: `ws://${RELAY}`, ws: true },
      '/metrics': { target: `http://${RELAY}` },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
