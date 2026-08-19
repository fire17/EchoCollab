#!/usr/bin/env node
/**
 * Lean realtime relay for the collaborative editor.
 *
 * One process serves three things on a single port:
 *   - the built static app (dist/)
 *   - /ws  : Yjs sync + awareness, one shared document per room
 *
 * Scale notes: compression is off (it costs more CPU than it saves on CRDT
 * deltas, and adds latency), fan-out is a single pre-encoded binary frame per
 * room, idle rooms are evicted from memory, and a client that stops draining
 * its socket is dropped rather than allowed to grow an unbounded send buffer.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attach, docs, closeConn } from './sync.js';
import * as persistence from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const PORT = Number(process.env.PORT || 1234);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 10000);
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD || 4 * 1024 * 1024);
const MAX_BUFFERED = Number(process.env.MAX_BUFFERED || 4 * 1024 * 1024);
const PING_INTERVAL = Number(process.env.PING_INTERVAL || 25000);
const PERSIST = process.env.PERSIST !== '0';

const stats = {
  started: Date.now(),
  connections: 0,
  peak: 0,
  totalConnections: 0,
  messagesIn: 0,
  messagesOut: 0,
  bytesIn: 0,
  bytesOut: 0,
  droppedSlow: 0,
  rejected: 0,
};

// Seeded here, not in the browser: the relay is the only single writer in the
// system, so a fresh room cannot end up with two merged copies of the welcome
// text when two windows open at the same instant.
const SEED = `# Two windows, one document

Type anywhere. Every other window sees it as you type — no save button, no
locking, no "someone else is editing this file".

- Hit **Open 2nd window** and put the windows side by side.
- Each window is a separate person, with its own colour and caret label.
- Select some text and watch the highlight appear in the other window.
- Press **Go offline**, keep typing in both, then come back online. Nothing is
  lost and nothing conflicts — the edits merge.

Undo (Cmd/Ctrl+Z) is shared and only ever undoes *your* own edits.
`;

const hooks = {
  onCreate: (doc) => {
    if (PERSIST) {
      persistence.load(doc);
      doc.on('update', (_u, origin) => { if (origin !== 'persistence') persistence.schedule(doc); });
    }
    const text = doc.getText('content');
    if (text.length === 0) text.insert(0, SEED);
  },
  onEmpty: (doc) => {
    // Nobody left in the room: snapshot it and let the memory go.
    if (PERSIST) persistence.flush(doc);
    docs.delete(doc.name);
    doc.destroy();
  },
};

// ------------------------------------------------------------------ http side

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
};

const snapshot = () => {
  const rooms = [];
  for (const [name, doc] of docs) {
    rooms.push({
      room: name,
      clients: doc.conns.size,
      presence: doc.awareness.getStates().size,
      chars: doc.getText('content').length,
    });
  }
  rooms.sort((a, b) => b.clients - a.clients);
  const mem = process.memoryUsage();
  return {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - stats.started) / 1000),
    connections: stats.connections,
    peakConnections: stats.peak,
    totalConnections: stats.totalConnections,
    rooms: rooms.length,
    messagesIn: stats.messagesIn,
    messagesOut: stats.messagesOut,
    bytesIn: stats.bytesIn,
    bytesOut: stats.bytesOut,
    droppedSlowClients: stats.droppedSlow,
    rejectedConnections: stats.rejected,
    rssMb: +(mem.rss / 1048576).toFixed(1),
    heapMb: +(mem.heapUsed / 1048576).toFixed(1),
    topRooms: rooms.slice(0, 20),
  };
};

const serveStatic = (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = path.join(DIST, decodeURIComponent(pathname));
  if (!file.startsWith(DIST)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('No build yet. Run `npm start` (build + serve) or `npm run dev` for the Vite dev server.');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return json(res, 200, { ok: true });
  if (pathname === '/metrics') return json(res, 200, snapshot());
  serveStatic(req, res);
});

// -------------------------------------------------------------- realtime side

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req, room) => {
  stats.connections += 1;
  stats.totalConnections += 1;
  stats.peak = Math.max(stats.peak, stats.connections);
  ws.isAlive = true;

  const doc = attach(ws, room, hooks);

  const send = ws.send.bind(ws);
  ws.send = (data, ...rest) => {
    stats.messagesOut += 1;
    stats.bytesOut += data?.length ?? data?.byteLength ?? 0;
    return send(data, ...rest);
  };

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    stats.messagesIn += 1;
    stats.bytesIn += data.length ?? data.byteLength ?? 0;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      stats.droppedSlow += 1;
      closeConn(doc, ws);
    }
  });
  ws.on('close', () => { stats.connections -= 1; });
  ws.on('error', () => {});
});

const roomOf = (req) => {
  const url = new URL(req.url, 'http://localhost');
  const raw = url.searchParams.get('room') || url.pathname.replace(/^\/ws\/?/, '') || 'default';
  return raw.slice(0, 128).replace(/[^\w.:-]/g, '') || 'default';
};

server.on('upgrade', (req, socket, head) => {
  if (stats.connections >= MAX_CONNECTIONS) {
    stats.rejected += 1;
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return socket.destroy();
  }
  const room = roomOf(req);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, room));
});

// Reap sockets that died without a close frame (closed laptop, dropped wifi).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL);

const shutdown = () => {
  clearInterval(heartbeat);
  if (PERSIST) for (const doc of docs.values()) persistence.flush(doc);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  ▲ app      http://${shown}:${PORT}`);
  console.log(`  ▲ relay    ws://${shown}:${PORT}/ws?room=<name>`);
  console.log(`  ▲ metrics  http://${shown}:${PORT}/metrics\n`);
});
