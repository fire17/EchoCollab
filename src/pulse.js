/**
 * Live round-trip time, measured over whatever transport is actually in use.
 *
 * Each window publishes a ping counter on the awareness channel; peers echo it
 * back, and the sender times the loop. That makes the number honest on a relay
 * we own, a relay we do not, and a plain BroadcastChannel alike — no special
 * server endpoint required.
 *
 * It costs awareness traffic proportional to the square of the room size, so it
 * stops measuring in crowded rooms rather than becoming the load it reports on.
 */
const PING_MS = 1500;
const MAX_PEERS = 8;

export const startPulse = (awareness, onSample) => {
  let seq = 0;
  let sentAt = 0;
  let sampled = 0;

  const timer = setInterval(() => {
    const size = awareness.getStates().size;
    if (size < 2 || size > MAX_PEERS) return onSample(null);
    seq += 1;
    sentAt = performance.now();
    awareness.setLocalStateField('ping', seq);
  }, PING_MS);

  const onChange = () => {
    const me = awareness.clientID;
    const states = awareness.getStates();

    // Echo every peer's current ping back to them, in one field.
    const echo = {};
    for (const [id, state] of states) {
      if (id !== me && typeof state.ping === 'number') echo[id] = state.ping;
    }
    const current = awareness.getLocalState()?.pong;
    if (JSON.stringify(current) !== JSON.stringify(echo)) awareness.setLocalStateField('pong', echo);

    // Anyone who echoed our latest ping has closed a full round trip. Sample it
    // once and once only: the echo stays in the peer's state, so any later
    // awareness traffic — a cursor move, someone else's ping — would otherwise
    // be timed against the same send and report a round trip that never happened.
    if (sampled === seq) return;
    let best = Infinity;
    const byPeer = new Map();
    const elapsed = performance.now() - sentAt;
    for (const [id, state] of states) {
      if (id === me || state.pong?.[me] !== seq) continue;
      byPeer.set(id, elapsed);
      best = Math.min(best, elapsed);
    }
    if (best < Infinity) {
      sampled = seq;
      // byPeer is what the peer inspector shows; best is what the status bar shows.
      onSample(best, byPeer);
    }
  };

  awareness.on('change', onChange);
  return () => {
    clearInterval(timer);
    awareness.off('change', onChange);
  };
};
