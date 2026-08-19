/**
 * WebRTC signalling over public BitTorrent WSS trackers.
 *
 * No signalling server of ours, and none to run: peers in a room meet on a
 * shared info-hash at trackers that already exist for everyone. The message
 * shapes, the tracker pool and the announce cadence are taken from fire17/p2p
 * (src/rendezvous/tracker.js), which live-verified them against these trackers.
 *
 * The tracker learns an opaque info-hash and relays two SDP blobs. It never sees
 * document traffic — that goes peer to peer once the DataChannel is up.
 */

// Independent operators, so one going down is a slower rendezvous rather than no
// rendezvous. Re-probed live 2026-08-19: p2p's third pick, tracker.btorrent.xyz,
// now refuses connections and was dropped. openwebtorrent.com is deliberately
// absent — it answers announce but relays no offers, which is worse than being
// down because it looks healthy.
export const TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://open.ftorrent.com',
];

const ANNOUNCE_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 3000;
const NUMWANT = 10;

/** 20 printable-ASCII characters — the id shape trackers accept without mangling. */
export const randomId20 = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (const b of bytes) out += String.fromCharCode(0x21 + (b % 0x5d));
  return out;
};

/**
 * Room name to info-hash. SHA-1 of a namespaced label, mapped into the same
 * printable range p2p uses, so the tracker sees an opaque handle and rooms from
 * other apps cannot collide with ours.
 */
export const infoHashFor = async (room) => {
  const data = new TextEncoder().encode(`echo-collab:room:${room}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  let out = '';
  for (let i = 0; i < 20; i += 1) out += String.fromCharCode(0x21 + (digest[i] % 0x5d));
  return out;
};

/**
 * Hold connections to the tracker pool for one room.
 *
 * `makeOffers` is asked for fresh offers on every announce; `onOffer` must
 * return an answer SDP (or null to ignore); `onAnswer` receives answers to
 * offers we published.
 */
export const openSignalling = ({ infoHash, peerId, makeOffers, onOffer, onAnswer, onStatus }) => {
  const sockets = [];
  let closed = false;

  const connect = (url) => {
    if (closed) return;
    let ws;
    let timer;
    let attempt = 0;

    const send = (obj) => {
      try { ws.send(JSON.stringify(obj)); } catch { /* socket not open */ }
    };

    const announce = async () => {
      const offers = await makeOffers();
      if (!offers.length || closed) return;
      send({
        action: 'announce',
        info_hash: infoHash,
        peer_id: peerId,
        numwant: NUMWANT,
        uploaded: 0,
        downloaded: 0,
        left: 0,
        offers,
      });
    };

    const retry = () => {
      clearInterval(timer);
      if (closed) return;
      attempt += 1;
      // Jittered ladder: a flat retry makes every client of a bounced tracker
      // redial in the same slot forever.
      const wait = Math.min(30_000, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 4));
      setTimeout(() => connect(url), wait * (0.7 + Math.random() * 0.6));
    };

    try { ws = new WebSocket(url); } catch { return retry(); }
    sockets.push(ws);

    ws.onopen = () => {
      attempt = 0;
      onStatus?.({ url, up: true });
      announce();
      timer = setInterval(announce, ANNOUNCE_INTERVAL_MS * (0.8 + Math.random() * 0.4));
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.info_hash !== infoHash || msg.peer_id === peerId) return;

      if (msg.offer && msg.offer_id) {
        const answer = await onOffer(msg.peer_id, msg.offer);
        if (!answer || closed) return;
        send({
          action: 'announce',
          info_hash: infoHash,
          peer_id: peerId,
          to_peer_id: msg.peer_id,
          offer_id: msg.offer_id,
          answer: { type: 'answer', sdp: answer },
        });
      } else if (msg.answer && msg.offer_id) {
        onAnswer(msg.peer_id, msg.offer_id, msg.answer);
      }
    };

    ws.onclose = () => { onStatus?.({ url, up: false }); retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
  };

  TRACKERS.forEach(connect);

  return () => {
    closed = true;
    for (const ws of sockets) { try { ws.close(); } catch { /* already gone */ } }
  };
};
