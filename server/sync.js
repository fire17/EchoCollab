/**
 * Server side of the Yjs websocket protocol.
 *
 * Deliberately hand-rolled rather than pulled from y-websocket's server helper:
 * that package ships its own Yjs major, and running two CRDT versions on one
 * wire is not a risk worth a saved file. This shares the exact yjs/y-protocols
 * build the browser uses.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export const docs = new Map();

/** One shared document, plus the sockets currently watching it. */
export class SharedDoc extends Y.Doc {
  constructor(name, hooks) {
    super({ gc: true });
    this.name = name;
    this.hooks = hooks;
    /** @type {Map<import('ws').WebSocket, Set<number>>} */
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (origin !== null && this.conns.has(origin)) {
        const ids = this.conns.get(origin);
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      this.broadcast(encoding.toUint8Array(encoder));
    });

    this.on('update', (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin);
    });
  }

  /** Fan out one pre-encoded frame; `except` skips the socket it came from. */
  broadcast(message, except) {
    for (const conn of this.conns.keys()) {
      if (conn === except) continue;
      send(this, conn, message);
    }
  }
}

const send = (doc, conn, message) => {
  if (conn.readyState !== conn.OPEN) return closeConn(doc, conn);
  try {
    conn.send(message, {}, (err) => err && closeConn(doc, conn));
  } catch {
    closeConn(doc, conn);
  }
};

export const closeConn = (doc, conn) => {
  const ids = doc.conns.get(conn);
  if (ids) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(ids), null);
    if (doc.conns.size === 0) doc.hooks?.onEmpty?.(doc);
  }
  try { conn.close(); } catch { /* already gone */ }
};

export const getDoc = (name, hooks) => {
  let doc = docs.get(name);
  if (!doc) {
    doc = new SharedDoc(name, hooks);
    docs.set(name, doc);
    hooks?.onCreate?.(doc);
  }
  return doc;
};

/** Wire one socket into a room: handshake, then relay until it goes away. */
export const attach = (conn, room, hooks) => {
  conn.binaryType = 'arraybuffer';
  const doc = getDoc(room, hooks);
  doc.conns.set(conn, new Set());

  conn.on('message', (data) => {
    try {
      const message = new Uint8Array(data);
      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      switch (decoding.readVarUint(decoder)) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
          // Length 1 means the reply is a bare header with nothing to say.
          if (encoding.length(encoder) > 1) send(doc, conn, encoding.toUint8Array(encoder));
          break;
        }
        case MESSAGE_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(
            doc.awareness,
            decoding.readVarUint8Array(decoder),
            conn,
          );
          break;
      }
    } catch (err) {
      doc.emit('error', [err]);
    }
  });

  conn.on('close', () => closeConn(doc, conn));

  // Handshake: offer our state vector, then the current presence set.
  const sync = encoding.createEncoder();
  encoding.writeVarUint(sync, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(sync, doc);
  send(doc, conn, encoding.toUint8Array(sync));

  const states = doc.awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys())),
    );
    send(doc, conn, encoding.toUint8Array(encoder));
  }
  return doc;
};
