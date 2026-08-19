/**
 * End-to-end checks against a real relay process.
 *
 * Spawns the server on its own port, drives real y-websocket clients (Node 26
 * has a global WebSocket, so no polyfill), and asserts the properties the demo
 * actually promises: convergence, concurrent-edit merge, presence, and that an
 * offline window loses nothing.
 *
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 41234;
const URL_WS = `ws://localhost:${PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-test-'));

let server;

const client = (room, name) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(URL_WS, room, doc, { disableBc: true });
  provider.awareness.setLocalStateField('user', { name, color: '#4fd1c5' });
  return { doc, provider, text: doc.getText('content') };
};

/**
 * Tear a client down completely.
 *
 * provider.destroy() leaves the awareness instance's own heartbeat interval
 * running, which is enough to keep the test process alive forever, so awareness
 * is closed explicitly first — that also broadcasts the peer's departure.
 */
const close = (c) => {
  c.provider.awareness.destroy();
  c.provider.destroy();
  c.doc.destroy();
};

const synced = (c) => new Promise((resolve) => (c.provider.synced ? resolve() : c.provider.once('sync', resolve)));
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PERSIST_DEBOUNCE: '50' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await settle(50);
  }
  throw new Error('relay did not start');
});

after(() => {
  server?.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('a fresh room arrives seeded, not empty', async () => {
  const a = client('seed-room', 'A');
  await synced(a);
  assert.match(a.text.toString(), /Two windows, one document/);
  close(a);
});

test('two clients converge on concurrent edits at the same position', async () => {
  const a = client('converge', 'A');
  const b = client('converge', 'B');
  await Promise.all([synced(a), synced(b)]);

  a.text.insert(0, 'AAA ');
  b.text.insert(0, 'BBB ');
  await settle();

  assert.equal(a.text.toString(), b.text.toString(), 'documents must be identical');
  assert.match(a.text.toString(), /AAA/);
  assert.match(a.text.toString(), /BBB/);
  close(a);
  close(b);
});

test('presence shows every peer with its colour', async () => {
  const a = client('presence', 'Alice');
  const b = client('presence', 'Bob');
  await Promise.all([synced(a), synced(b)]);
  await settle();

  const names = [...a.provider.awareness.getStates().values()].map((s) => s.user?.name).sort();
  assert.deepEqual(names, ['Alice', 'Bob']);
  close(a);
  close(b);
});

test('a peer that leaves disappears from presence', async () => {
  const a = client('leaving', 'A');
  const b = client('leaving', 'B');
  await Promise.all([synced(a), synced(b)]);
  await settle();
  assert.equal(a.provider.awareness.getStates().size, 2);

  close(b);
  await settle(400);
  assert.equal(a.provider.awareness.getStates().size, 1);
  close(a);
});

test('edits made offline merge on reconnect, losing nothing', async () => {
  const a = client('offline', 'A');
  const b = client('offline', 'B');
  await Promise.all([synced(a), synced(b)]);

  b.provider.disconnect();
  await settle(100);
  a.text.insert(0, 'ONLINE-EDIT ');
  b.text.insert(0, 'OFFLINE-EDIT ');
  await settle(150);
  assert.ok(!a.text.toString().includes('OFFLINE-EDIT'), 'offline edit must not have arrived yet');

  b.provider.connect();
  await settle(600);
  assert.equal(a.text.toString(), b.text.toString());
  assert.match(a.text.toString(), /ONLINE-EDIT/);
  assert.match(a.text.toString(), /OFFLINE-EDIT/);
  close(a);
  close(b);
});

test('a room survives the last client leaving', async () => {
  const a = client('persisted', 'A');
  await synced(a);
  a.text.insert(0, 'SURVIVES-RESTART ');
  await settle(200);
  close(a);
  await settle(400);

  const b = client('persisted', 'B');
  await synced(b);
  assert.match(b.text.toString(), /SURVIVES-RESTART/);
  close(b);
});

test('rooms are isolated from each other', async () => {
  const a = client('room-one', 'A');
  const b = client('room-two', 'B');
  await Promise.all([synced(a), synced(b)]);

  a.text.insert(0, 'ONLY-IN-ROOM-ONE ');
  await settle();
  assert.ok(!b.text.toString().includes('ONLY-IN-ROOM-ONE'));
  assert.equal(a.provider.awareness.getStates().size, 1, 'peers must not leak across rooms');
  close(a);
  close(b);
});

test('a client recovers when the relay restarts under it', async () => {
  const a = client('restart', 'A');
  await synced(a);
  a.text.insert(0, 'BEFORE-RESTART ');
  await settle(200);

  server.kill('SIGKILL');
  await settle(300);
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PERSIST_DEBOUNCE: '50' },
    stdio: 'ignore',
  });

  // y-websocket backs off between attempts, so give it room to come back.
  for (let i = 0; i < 60 && !a.provider.wsconnected; i += 1) await settle(100);
  assert.ok(a.provider.wsconnected, 'client should reconnect on its own');

  a.text.insert(0, 'AFTER-RESTART ');
  await settle(300);
  const b = client('restart', 'B');
  await synced(b);
  await settle(200);
  assert.match(b.text.toString(), /BEFORE-RESTART/);
  assert.match(b.text.toString(), /AFTER-RESTART/);
  close(a);
  close(b);
});

test('metrics report live rooms and connections', async () => {
  const a = client('metrics-room', 'A');
  await synced(a);
  const m = await (await fetch(`http://localhost:${PORT}/metrics`)).json();
  assert.ok(m.ok);
  assert.ok(m.connections >= 1);
  assert.ok(m.rooms >= 1);
  assert.ok(m.topRooms.some((r) => r.room === 'metrics-room'));
  close(a);
});
