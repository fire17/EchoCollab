/**
 * A Yjs provider with no server behind it.
 *
 * Speaks the same two-message protocol as the WebSocket relay — sync and
 * awareness — but over a mesh of direct DataChannels instead of through a
 * middle. Interface-compatible with y-websocket's provider where this app uses
 * it, so the rest of the editor does not know or care which one it has.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Observable } from 'lib0/observable';
import { createMesh } from './mesh.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export class P2pProvider extends Observable {
  constructor(room, doc, { awareness = new awarenessProtocol.Awareness(doc), connect = true } = {}) {
    super();
    this.room = room;
    this.doc = doc;
    this.awareness = awareness;
    this.mesh = null;
    // Windows of the same browser sync directly, without waiting on a tracker
    // round trip or an ICE handshake — the two-window demo is instant, and it
    // still works with the network unplugged.
    this.bc = null;
    // Which windows we can still reach over the browser channel. A peer may be
    // reachable both ways; losing one path is not losing the peer.
    this.bcPeers = new Set();
    this.synced = false;
    this.shouldConnect = connect;

    this._onUpdate = (update, origin) => {
      // Anything that arrived from a peer is already on its way to the others.
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this._broadcast(encoding.toUint8Array(encoder));
    };

    this._onAwareness = ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      this._broadcast(encoding.toUint8Array(encoder));
    };

    this._onUnload = () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'unload');
      try { this.bc?.postMessage(JSON.stringify({ echo: 'bye', id: this.doc.clientID })); } catch { /* closed */ }
    };

    this.doc.on('update', this._onUpdate);
    this.awareness.on('update', this._onAwareness);
    addEventListener('beforeunload', this._onUnload);

    if (connect) this.connect();
  }

  /** Out to every direct peer, and to the other windows of this browser. */
  _broadcast(bytes) {
    this.mesh?.broadcast(bytes);
    try { this.bc?.postMessage(bytes); } catch { /* channel closed */ }
  }

  _handle(peer, bytes) {
    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const type = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        // A step-2 reply means this peer has answered our state vector: whatever
        // it knew that we did not is now applied, which is what "synced" means
        // in a mesh with no authority to ask.
        if (type === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.emit('sync', [true]);
        }
        if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
    }
  }

  async connect() {
    if (this.mesh) return;
    this.shouldConnect = true;
    this.emit('status', [{ status: 'connecting' }]);

    // Same-browser windows first: no signalling, no ICE, no internet.
    this.bc = new BroadcastChannel(`echo:${this.room}`);
    const local = {
      send: (bytes) => { try { this.bc?.postMessage(bytes); } catch { /* closed */ } },
    };
    const hello = () => local.send(JSON.stringify({ echo: 'hello', id: this.doc.clientID }));

    this.bc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let note;
        try { note = JSON.parse(event.data); } catch { return; }
        if (note.echo === 'hello') {
          // A window that just opened does not know us yet; answer so the path
          // is known in both directions, then sync.
          if (!this.bcPeers.has(note.id)) { this.bcPeers.add(note.id); hello(); this._greet(local); }
          this.emit('status', [{ status: 'connected' }]);
        } else if (note.echo === 'bye') {
          this.bcPeers.delete(note.id);
        }
        return;
      }
      try { this._handle(local, new Uint8Array(event.data)); } catch (err) { this.emit('connection-error', [err]); }
    };

    hello();
    this._greet(local);

    try {
      this.mesh = await createMesh({
        room: this.room,
        selfId: this.doc.clientID,
        onPeer: (peer) => {
          peer.onMessage = (bytes) => {
            try { this._handle(peer, bytes); } catch (err) { this.emit('connection-error', [err]); }
          };
          this._greet(peer);
          this.emit('status', [{ status: 'connected' }]);
        },
        onLeave: (id) => {
          // Presence is per-connection here: no server holds it for us. But only
          // forget a peer we have genuinely lost — a window reachable over the
          // browser channel is still in the room even if its WebRTC leg died.
          if (!this.bcPeers.has(id)) {
            awarenessProtocol.removeAwarenessStates(this.awareness, [id], 'peer-left');
          }
          const reachable = (this.mesh?.size ?? 0) + this.bcPeers.size;
          this.emit('status', [{ status: reachable ? 'connected' : 'connecting' }]);
        },
        onStatus: ({ peers }) => this.emit('peers', [{ peers: peers + this.bcPeers.size }]),
      });
    } catch (err) {
      this.emit('connection-error', [err]);
      return;
    }

    if (!this.shouldConnect) { this.mesh.close(); this.mesh = null; }
  }

  /** Opening move to anyone new: our state vector, then our presence. */
  _greet(peer) {
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, this.doc);
    peer.send(encoding.toUint8Array(sync));

    if (!this.awareness.getLocalState()) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    peer.send(encoding.toUint8Array(encoder));
  }

  disconnect() {
    this.shouldConnect = false;
    try {
      this.bc?.postMessage(JSON.stringify({ echo: 'bye', id: this.doc.clientID }));
      this.bc?.close();
    } catch { /* already closed */ }
    this.bc = null;
    this.bcPeers.clear();
    if (!this.mesh) { this.emit('status', [{ status: 'disconnected' }]); return; }
    this.mesh.close();
    this.mesh = null;
    this.synced = false;
    // Everyone else's presence came over channels that are now gone.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, others, 'disconnect');
    this.emit('status', [{ status: 'disconnected' }]);
  }

  destroy() {
    this.disconnect();
    removeEventListener('beforeunload', this._onUnload);
    this.doc.off('update', this._onUpdate);
    this.awareness.off('update', this._onAwareness);
    super.destroy();
  }
}
