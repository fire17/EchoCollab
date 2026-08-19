/**
 * A full mesh of WebRTC DataChannels between everyone in a room.
 *
 * Signalling is the public-tracker matchmaker in ./tracker.js; NAT traversal is
 * ICE against free public STUN. Once a channel opens, nothing else is in the
 * path — the document travels browser to browser.
 *
 * Chunking follows fire17/p2p (src/browser/webrtc.js): 16 KB frames with an
 * 8-byte header, because a DataChannel message has a hard size ceiling and a Yjs
 * update for a large document sails past it.
 */
import { infoHashFor, openSignalling, randomId20 } from './tracker.js';

// p2p's vetted list: two independent operators, no TURN (we never relay).
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const ICE_GATHER_MS = 1500;
const OFFERS_PER_ANNOUNCE = 3;
const OFFER_TTL_MS = 90_000;
const CHUNK_HDR = 8;
const CHUNK_MAX = 16_000;
const CHUNK_PAYLOAD = CHUNK_MAX - CHUNK_HDR;
const MAX_CHUNKS = 4096;

/** Resolve once ICE has gathered, or when the cap says ship what we have. */
const gathered = (pc) => new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') return resolve();
  const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
  const check = () => { if (pc.iceGatheringState === 'complete') done(); };
  const timer = setTimeout(done, ICE_GATHER_MS);
  pc.addEventListener('icegatheringstatechange', check);
});

/**
 * @param {object} options
 * @param {string} options.room          room name, hashed into the tracker info-hash
 * @param {number|string} options.selfId stable id for this window; decides glare
 * @param {(peer) => void} options.onPeer     called once per peer when its channel opens
 * @param {(id) => void} options.onLeave      called when a peer's channel drops
 * @param {(state) => void} [options.onStatus]
 */
export const createMesh = async ({ room, selfId, onPeer, onLeave, onStatus }) => {
  const infoHash = await infoHashFor(room);
  const peerId = randomId20();

  const parked = new Map();   // offer_id -> { pc, channel, at }
  const peers = new Map();    // remote selfId -> { pc, channel, send, close }
  let closed = false;

  const reportStatus = () => onStatus?.({ peers: peers.size, room });

  /**
   * Wrap a DataChannel: chunk on the way out, reassemble on the way in, and
   * announce who we are first so both sides can settle glare by id rather than
   * by tracker pseudonym (one peer reaches us on several trackers under
   * different pseudonyms — without this we would hold three channels to it).
   */
  const wire = (pc, channel, initiator) => {
    const inbox = new Map();
    let nextMsgId = 1;
    let remote = null;
    // Set when we deliberately drop a duplicate channel, so its close does not
    // get reported as the peer leaving — it is still there on the other channel.
    let superseded = false;

    const sendBytes = (bytes) => {
      if (channel.readyState !== 'open') return;
      const msgId = nextMsgId++;
      const total = Math.max(1, Math.ceil(bytes.length / CHUNK_PAYLOAD));
      for (let i = 0; i < total; i += 1) {
        const part = bytes.subarray(i * CHUNK_PAYLOAD, (i + 1) * CHUNK_PAYLOAD);
        const frame = new Uint8Array(CHUNK_HDR + part.length);
        const view = new DataView(frame.buffer);
        view.setUint32(0, msgId);
        view.setUint16(4, i);
        view.setUint16(6, total);
        frame.set(part, CHUNK_HDR);
        try { channel.send(frame); } catch { return; }
      }
    };

    const peer = {
      get id() { return remote; },
      get initiator() { return initiator; },
      send: sendBytes,
      onMessage: null,
      /**
       * What this connection actually is, read from the live PeerConnection —
       * which candidate pair won, whether it is a direct hop or went through a
       * relay, and how much has crossed it.
       */
      stats: async () => {
        const out = {
          path: 'webrtc',
          channel: channel.readyState,
          connection: pc.connectionState,
          ice: pc.iceConnectionState,
          initiator,
        };
        try {
          const report = await pc.getStats();
          let pair = null;
          const candidates = new Map();
          report.forEach((entry) => {
            if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') candidates.set(entry.id, entry);
            if (entry.type === 'candidate-pair' && (entry.selected || entry.state === 'succeeded' && entry.nominated)) pair = entry;
          });
          if (pair) {
            const local = candidates.get(pair.localCandidateId);
            const remoteCandidate = candidates.get(pair.remoteCandidateId);
            out.protocol = local?.protocol;
            out.localType = local?.candidateType;
            out.remoteType = remoteCandidate?.candidateType;
            out.remoteAddress = remoteCandidate?.address;
            out.bytesSent = pair.bytesSent;
            out.bytesReceived = pair.bytesReceived;
            if (typeof pair.currentRoundTripTime === 'number') out.iceRttMs = pair.currentRoundTripTime * 1000;
            // A "relay" candidate on either end means TURN. We run none, so this
            // should never be true — worth showing rather than assuming.
            out.direct = local?.candidateType !== 'relay' && remoteCandidate?.candidateType !== 'relay';
          }
        } catch { /* stats unavailable on this connection */ }
        return out;
      },
      close: () => { try { channel.close(); } catch { /* gone */ } try { pc.close(); } catch { /* gone */ } },
      supersede: () => { superseded = true; peer.close(); },
    };

    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      // Identify first, in plain JSON, before any CRDT bytes flow.
      try { channel.send(JSON.stringify({ echo: 'hello', id: selfId })); } catch { /* gone */ }
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let hello;
        try { hello = JSON.parse(event.data); } catch { return; }
        if (hello?.echo !== 'hello') return;
        remote = hello.id;

        // Glare: a pair usually completes a channel in each direction. The rule
        // has to name the same physical channel on both sides — deciding from
        // "am I the lower id" does not, because that is inverted across the pair
        // and each side then closes the one the other kept, killing both.
        // The lower id's offer wins, which both sides evaluate identically.
        peer.preferred = String(selfId) < String(remote) ? initiator : !initiator;

        const existing = peers.get(remote);
        if (existing && existing !== peer) {
          if (existing.preferred || !peer.preferred) { superseded = true; peer.close(); return; }
          existing.supersede();
        }
        peers.set(remote, peer);
        reportStatus();
        onPeer(peer);
        return;
      }

      const bytes = new Uint8Array(event.data);
      if (bytes.length < CHUNK_HDR) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const msgId = view.getUint32(0);
      const index = view.getUint16(4);
      const total = view.getUint16(6);
      if (total < 1 || total > MAX_CHUNKS || index >= total) return;
      const body = bytes.subarray(CHUNK_HDR);

      if (total === 1) return peer.onMessage?.(body);

      let slots = inbox.get(msgId);
      if (!slots) { slots = { parts: new Array(total), left: total }; inbox.set(msgId, slots); }
      if (slots.parts[index]) return;
      slots.parts[index] = body;
      slots.left -= 1;
      if (slots.left > 0) return;

      inbox.delete(msgId);
      const size = slots.parts.reduce((n, p) => n + p.length, 0);
      const whole = new Uint8Array(size);
      let at = 0;
      for (const part of slots.parts) { whole.set(part, at); at += part.length; }
      peer.onMessage?.(whole);
    };

    const drop = () => {
      if (superseded) return;
      if (remote && peers.get(remote) === peer) {
        peers.delete(remote);
        onLeave?.(remote);
        reportStatus();
      }
    };
    channel.onclose = drop;
    channel.onerror = drop;
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) drop();
    });

    return peer;
  };

  const makeOffers = async () => {
    if (closed) return [];
    // Expire offers nobody answered, so parked connections cannot pile up — a
    // browser limits how many peer connections a page may hold at once.
    const now = Date.now();
    for (const [id, entry] of parked) {
      if (now - entry.at > OFFER_TTL_MS) { try { entry.pc.close(); } catch { /* gone */ } parked.delete(id); }
    }

    const offers = [];
    for (let i = 0; i < OFFERS_PER_ANNOUNCE; i += 1) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const channel = pc.createDataChannel('echo', { ordered: true });
      wire(pc, channel, true);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const offerId = randomId20();
      parked.set(offerId, { pc, at: Date.now() });
      offers.push({ offer_id: offerId, offer: { type: 'offer', sdp: pc.localDescription.sdp } });
    }
    return offers;
  };

  const onOffer = async (_from, offer) => {
    if (closed) return null;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.ondatachannel = (event) => wire(pc, event.channel, false);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return pc.localDescription.sdp;
  };

  const onAnswer = async (_from, offerId, answer) => {
    const entry = parked.get(offerId);
    if (!entry || closed) return;
    parked.delete(offerId);
    try {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch { try { entry.pc.close(); } catch { /* gone */ } }
  };

  const stopSignalling = openSignalling({
    infoHash, peerId, makeOffers, onOffer, onAnswer,
    onStatus: () => reportStatus(),
  });

  return {
    get peers() { return [...peers.values()]; },
    get size() { return peers.size; },
    get(id) { return peers.get(id); },
    broadcast: (bytes, except) => {
      for (const peer of peers.values()) if (peer !== except) peer.send(bytes);
    },
    close: () => {
      closed = true;
      stopSignalling();
      for (const entry of parked.values()) { try { entry.pc.close(); } catch { /* gone */ } }
      parked.clear();
      for (const peer of peers.values()) peer.close();
      peers.clear();
    },
  };
};
