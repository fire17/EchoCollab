import { defineConfig } from 'vite';

// In dev, Vite serves the app and proxies the realtime paths to the relay, so
// the client can always talk to its own origin and never needs a port baked in.
const RELAY = process.env.RELAY || 'localhost:1234';

export default defineConfig({
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
