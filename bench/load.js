#!/usr/bin/env node
/**
 * Load + propagation benchmark.
 *
 * Fills a room with N headless clients, has one of them type, and measures how
 * long each edit takes to reach a sampled observer. Reports the distribution
 * (p50/p95/p99/max) rather than an average, because an average hides exactly
 * the stalls you care about.
 *
 *   node bench/load.js --clients 200 --edits 300 --url ws://localhost:1234/ws
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocketImpl from 'ws';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const CLIENTS = Number(arg('clients', 100));
const EDITS = Number(arg('edits', 200));
const GAP_MS = Number(arg('gap', 10));
const URL_WS = arg('url', 'ws://localhost:1234/ws');
const ROOM = arg('room', `bench-${process.pid}`);
const OBSERVERS = Math.min(Number(arg('observers', 5)), CLIENTS - 1);

// y-websocket registers a process 'exit' listener per provider; at bench scale
// that is expected, not a leak.
process.setMaxListeners(0);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const ms = (n) => `${n.toFixed(2)} ms`;

const make = (name) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(URL_WS, ROOM, doc, { disableBc: true, WebSocketPolyfill: WebSocketImpl });
  provider.awareness.setLocalStateField('user', { name, color: '#4fd1c5' });
  return { doc, provider, text: doc.getText('content') };
};

const close = (c) => {
  c.provider.awareness.destroy();
  c.provider.destroy();
  c.doc.destroy();
};

console.log(`\n  room ${ROOM} · ${CLIENTS} clients · ${EDITS} edits · ${GAP_MS}ms gap · ${OBSERVERS} observers\n`);

const connectStart = performance.now();
const clients = Array.from({ length: CLIENTS }, (_, i) => make(`bot-${i}`));
await Promise.all(clients.map((c) => new Promise((resolve) => {
  if (c.provider.synced) return resolve();
  c.provider.once('sync', resolve);
})));
const connectMs = performance.now() - connectStart;
console.log(`  connected + synced ${CLIENTS} clients in ${ms(connectMs)} (${ms(connectMs / CLIENTS)} each)`);

const [writer, ...rest] = clients;
const observers = rest.slice(0, OBSERVERS);

// Every edit carries a unique marker and the time it was written. An observer
// samples each marker the first time it sees it, so nothing is missed when two
// edits land inside one update — an average over dropped samples would flatter
// the result.
const samples = [];
const sentAt = new Map();
const MARKER = /\u00ab(\d+)\u00bb/g;

for (const o of observers) {
  const seen = new Set();
  o.text.observe(() => {
    const now = performance.now();
    for (const [, id] of o.text.toString().matchAll(MARKER)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const at = sentAt.get(id);
      if (at !== undefined) samples.push(now - at);
    }
  });
}

const editStart = performance.now();
for (let i = 0; i < EDITS; i += 1) {
  sentAt.set(String(i), performance.now());
  writer.text.insert(writer.text.length, `\u00ab${i}\u00bb`);
  await new Promise((r) => setTimeout(r, GAP_MS));
}
await new Promise((r) => setTimeout(r, 500));
const editMs = performance.now() - editStart;

samples.sort((a, b) => a - b);
const expected = EDITS * observers.length;

console.log(`
  edits            ${EDITS} in ${ms(editMs)} (${(EDITS / (editMs / 1000)).toFixed(0)} edits/s offered)
  samples          ${samples.length} / ${expected} observed
  propagation p50  ${ms(pct(samples, 50))}
             p95  ${ms(pct(samples, 95))}
             p99  ${ms(pct(samples, 99))}
             max  ${ms(samples[samples.length - 1] ?? 0)}
  document         ${writer.text.length} chars`);

const metricsUrl = URL_WS.replace(/^ws/, 'http').replace(/\/ws.*$/, '/metrics');
try {
  const m = await (await fetch(metricsUrl)).json();
  console.log(`  server           ${m.connections} conns · ${m.rooms} rooms · ${m.rssMb} MB rss · ${(m.bytesOut / 1048576).toFixed(1)} MB out · ${m.droppedSlowClients} slow drops\n`);
} catch {
  console.log('');
}

// Converged? A benchmark that silently corrupted the document is worthless.
const reference = writer.text.toString();
const diverged = clients.filter((c) => c.text.toString() !== reference).length;
console.log(diverged === 0
  ? `  ✔ all ${CLIENTS} clients converged on an identical ${reference.length}-char document\n`
  : `  ✖ ${diverged} clients diverged\n`);

clients.forEach(close);
process.exit(diverged === 0 ? 0 : 1);
