/**
 * Where this page gets its realtime transport.
 *
 * Resolved once, deterministically, with no probing:
 *
 *   1. ?relay=wss://…    an explicit relay, for pointing the app at your own
 *   2. VITE_RELAY        a relay baked in at build time
 *   3. same origin       the page was served by a relay (npm start)
 *   4. peer to peer      no server at all — the published default
 *
 * The last one is not a fallback for want of a server; it is the point. Peers
 * meet over public BitTorrent trackers and then talk directly, so the published
 * site has no backend to run, pay for, or trust with the document.
 */
const PREFIX = 'echo.';

export const resolveTransport = () => {
  const params = new URLSearchParams(location.search);
  const override = params.get('relay');
  const baked = import.meta.env.VITE_RELAY;
  const sameOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // A page served by our own relay uses it; anything else is peer to peer unless
  // a relay was named explicitly.
  const servedByRelay = Boolean(import.meta.env.DEV) || Boolean(import.meta.env.VITE_SELF_HOSTED);

  if (!override && !baked && !servedByRelay) {
    return {
      kind: 'p2p',
      ours: true,
      host: 'peer-to-peer',
      docName: (room) => room,
      defaultRoom: () => `r-${Math.random().toString(36).slice(2, 10)}`,
      useBroadcastChannel: true,
    };
  }

  const url = override || baked || sameOrigin;
  const ours = url === sameOrigin;
  return {
    kind: 'relay',
    url,
    ours,
    host: new URL(url).host,
    // Our own relay keeps room names verbatim; a shared one gets namespaced so
    // "lobby" here cannot collide with someone else's "lobby".
    docName: (room) => (ours ? room : PREFIX + room),
    // On a shared relay a guessable default room is a stranger's document, so
    // fresh visits get their own; the link is how you invite people in.
    defaultRoom: () => (ours ? 'lobby' : `r-${Math.random().toString(36).slice(2, 10)}`),
    // Same-browser windows sync directly as well as through the relay, so the
    // demo still works when the relay is unreachable. disconnect() drops this
    // channel too, which keeps the offline button honest.
    useBroadcastChannel: !ours,
  };
};
