/**
 * The universal transport floor: room traffic over public MQTT-over-WSS brokers.
 *
 * WebRTC fails for a symmetric-NAT pair, and a browser cannot hole-punch its way
 * out — which is exactly the case that leaves two windows on different networks
 * unable to see each other. Both sides can always dial OUT to a public broker,
 * so this traverses every NAT with no STUN, no TURN, and no server of ours.
 *
 * The design, the relay list and the topic derivation are p2p's
 * (`@fire17/p2p/src/transport-wss.js`), imported rather than reimplemented. What
 * differs: p2p carries its Noise IK ciphertext over this pipe, while ECHO's
 * rooms have no per-peer identities yet, so frames are sealed with AES-GCM under
 * a key derived from the room name. The broker is a blind pipe either way — it
 * sees an opaque topic and ciphertext — but this is room-secret encryption, not
 * p2p's authenticated handshake. See README for what that does and does not buy.
 */
// p2p's shared source expects the Buffer global its own client installs first —
// same load-bearing order as src/browser/p2p.js. Must stay the first import.
import '@fire17/p2p/src/browser/shim/globals.js';
import { RELAYS, topicFor, epochStr } from '@fire17/p2p/transport-wss';
import { encodeKey } from '@fire17/p2p/key';
import { createHash } from 'node:crypto';

const enc = new TextEncoder();

/**
 * A room's rendezvous handle, as a canonical p2p contact key.
 *
 * p2p derives every topic from a 26-char S (`topicFor` → `deriveRid`), so a room
 * needs one. This mints it with p2p's own encodeKey over room-derived bytes: a
 * valid S whose "identity" nobody holds — purely a shared handle, which is all
 * deriveRid ever uses S for (it is HKDF input, never a trusted party).
 */
const roomS = (room) => encodeKey(
  createHash('sha256').update(`echo-collab:ed:${room}`).digest(),
  createHash('sha256').update(`echo-collab:x:${room}`).digest(),
);

/** MQTT 3.1.1 QoS 0, the subset a browser needs — mirrors p2p's own packer. */
const remlen = (n) => {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return out;
};
const packet = (type, flags, body) => Uint8Array.from([(type << 4) | flags, ...remlen(body.length), ...body]);
const mstr = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };

const parse = (buf) => {
  if (buf.length < 2) return null;
  const type = buf[0] >> 4;
  let multiplier = 1;
  let value = 0;
  let i = 1;
  let digit;
  do {
    if (i >= buf.length) return null;
    digit = buf[i++];
    value += (digit & 127) * multiplier;
    multiplier *= 128;
  } while ((digit & 128) !== 0);
  return { type, body: buf.subarray(i, i + value) };
};

/** Room key: the room name is the secret, so the broker never sees plaintext. */
const roomKey = async (room) => {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`echo-collab:floor:${room}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const seal = async (key, bytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return out;
};

const open = async (key, bytes) => {
  if (bytes.length <= 12) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return new Uint8Array(plain);
  } catch {
    return null; // another room, or a corrupt frame — ignore it
  }
};

/**
 * Join a room's floor. `onFrame` receives decrypted payloads from other windows;
 * the returned `send` publishes to everyone subscribed to the room's topic.
 */
export const joinFloor = async ({ room, selfId, onFrame, onStatus }) => {
  const key = await roomKey(room);
  // p2p rotates the topic daily; subscribe the neighbouring epochs so a window
  // open across midnight does not silently fall out of the room.
  const now = Date.now();
  const DAY = 86_400_000;
  const S = roomS(room);
  const topics = [...new Set([epochStr(now - DAY), epochStr(now), epochStr(now + DAY)]
    .map((epoch) => topicFor(S, epoch)))];
  const publishTopic = topics[1] ?? topics[0];

  const sockets = [];
  let closed = false;
  let live = 0;

  const connect = (url, attempt = 0) => {
    if (closed) return;
    let ws;
    let ping;
    try { ws = new WebSocket(url, 'mqtt'); } catch { return; }
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);

    ws.onopen = () => {
      attempt = 0;
      const clientId = `echo${selfId}${Math.random().toString(36).slice(2, 8)}`.slice(0, 22);
      ws.send(packet(1, 0, [...mstr('MQTT'), 4, 2, 0, 60, ...mstr(clientId)]));
      let id = 1;
      for (const topic of topics) ws.send(packet(8, 2, [0, id++, ...mstr(topic), 0]));
      live += 1;
      onStatus?.({ relays: live });
      ping = setInterval(() => { try { ws.send(packet(12, 0, [])); } catch { /* gone */ } }, 30_000);
    };

    ws.onmessage = async (event) => {
      const frame = parse(new Uint8Array(event.data));
      if (!frame || frame.type !== 3) return; // PUBLISH only
      const topicLen = (frame.body[0] << 8) | frame.body[1];
      const payload = frame.body.subarray(2 + topicLen);
      const plain = await open(key, payload);
      if (!plain || plain.length < 4) return;
      const from = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
      if (from === selfId) return; // our own frame, echoed by the broker
      onFrame(from, plain.subarray(4));
    };

    const down = () => {
      clearInterval(ping);
      live = Math.max(0, live - 1);
      onStatus?.({ relays: live });
      // Jittered ladder, same shape as p2p's backoff: a public broker that is
      // down stays down for a while, and a flat retry just spams the console.
      const wait = Math.min(120_000, 3000 * 2 ** Math.min(attempt, 5));
      if (!closed) setTimeout(() => connect(url, attempt + 1), wait * (0.7 + Math.random() * 0.6));
    };
    ws.onclose = down;
    ws.onerror = () => { try { ws.close(); } catch { /* gone */ } };
  };

  RELAYS.forEach(connect);

  return {
    get relays() { return live; },
    send: async (bytes) => {
      // Stamp the sender so a broker echo can be told from a peer's frame.
      const stamped = new Uint8Array(4 + bytes.length);
      new DataView(stamped.buffer).setUint32(0, selfId);
      stamped.set(bytes, 4);
      const sealed = await seal(key, stamped);
      const body = Uint8Array.from([...mstr(publishTopic), ...sealed]);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.send(packet(3, 0, body)); } catch { /* gone */ } }
      }
    },
    close: () => {
      closed = true;
      for (const ws of sockets) { try { ws.close(); } catch { /* gone */ } }
    },
  };
};
