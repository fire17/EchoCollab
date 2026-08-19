/**
 * Where this page gets its realtime transport.
 *
 * Resolved once, deterministically, with no probing:
 *
 *   1. ?relay=wss://…    an explicit relay, for pointing the hosted app at your own
 *   2. VITE_RELAY        baked in at build time (how the published site reaches a relay)
 *   3. same origin       the page was served by the relay itself (npm start)
 *
 * A relay we do not own is shared with everyone else using it, so rooms get a
 * namespace prefix and the hosted build hands out an unguessable room by default.
 */
const PREFIX = 'echo.';

export const resolveTransport = () => {
  const params = new URLSearchParams(location.search);
  const override = params.get('relay');
  const baked = import.meta.env.VITE_RELAY;
  const sameOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const url = override || baked || sameOrigin;
  const ours = url === sameOrigin;
  return {
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
