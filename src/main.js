/**
 * ECHO — realtime collaborative editing.
 *
 * One Yjs document per room. Every window edits its own local copy instantly
 * and the CRDT reconciles; nothing waits on a server round-trip, which is why
 * typing stays instant even when the network is not. Presence (name, colour,
 * cursor, selection) rides the awareness channel and is never persisted.
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { yCollab, yUndoManagerKeymap, ySyncFacet } from 'y-codemirror.next';

import { EditorState } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
  crosshairCursor, placeholder,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';

import { loadIdentity, saveIdentity, pickIdentity } from './identity.js';
import { resolveTransport } from './transport.js';
import { startPulse } from './pulse.js';
import { editorTheme } from './theme.js';

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

// ---------------------------------------------------------------------- setup

const transport = resolveTransport();
const room = (location.hash.slice(1) || new URLSearchParams(location.search).get('room') || transport.defaultRoom())
  .replace(/[^\w.:-]/g, '')
  .slice(0, 128) || 'lobby';
if (location.hash.slice(1) !== room) history.replaceState(null, '', `#${room}`);

const identity = loadIdentity();

const doc = new Y.Doc();
const text = doc.getText('content');

// Local-first: the last known text paints before the socket even opens.
new IndexeddbPersistence(`echo:${room}`, doc);

const provider = new WebsocketProvider(transport.url, transport.docName(room), doc, {
  maxBackoffTime: 2500,
  // Against our own relay the browser gossip channel is switched off, so the
  // demo always shows the real network path. On a relay we do not own it is
  // switched on, so two windows on one machine stay instant even if that relay
  // is unreachable. disconnect() drops it too, so "Go offline" stays honest.
  disableBc: transport.ours,
});
const { awareness } = provider;
awareness.setLocalStateField('user', identity);

// Origins are wired up after the view exists: y-codemirror stamps its local
// edits with its own config object, so that is what undo has to track.
const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set() });

// --------------------------------------------------------------------- editor

const view = new EditorView({
  parent: document.getElementById('editor'),
  state: EditorState.create({
    doc: text.toString(),
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown(),
      EditorView.lineWrapping,
      placeholder('Start typing — every window sees it instantly.'),
      EditorState.allowMultipleSelections.of(true),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...completionKeymap,
        ...foldKeymap,
        // Must come before the default history keymap: undo is shared, so it
        // has to walk the CRDT's stack and not the local editor's.
        ...yUndoManagerKeymap,
        indentWithTab,
      ]),
      // Binds the document, the remote carets and the shared undo stack.
      yCollab(text, awareness, { undoManager }),
      editorTheme,
    ],
  }),
});
view.focus();

const syncConfig = view.state.facet(ySyncFacet);
undoManager.addTrackedOrigin(syncConfig);
undoManager.addTrackedOrigin(syncConfig.constructor);

// ------------------------------------------------------------------ presence

const peersEl = document.getElementById('peers');
const peerCountEl = document.getElementById('peer-count');

// Chips are diffed in place, never rebuilt. Awareness fires on every keystroke
// (cursor, typing flag, latency ping), and replacing the nodes each time
// restarts their entry animation — which reads as the whole row flickering.
const chips = new Map();

const renderPeers = () => {
  const states = [...awareness.getStates().entries()].filter(([, state]) => state.user);
  const order = states
    .map(([id]) => id)
    .sort((a, b) => (a === awareness.clientID ? -1 : b === awareness.clientID ? 1 : a - b));

  for (const [id, chip] of chips) {
    if (!states.some(([other]) => other === id)) {
      chip.remove();
      chips.delete(id);
    }
  }

  for (const clientId of order) {
    const state = awareness.getStates().get(clientId);
    const me = clientId === awareness.clientID;
    let chip = chips.get(clientId);

    if (!chip) {
      chip = document.createElement('button');
      chip.className = 'peer';
      chip.append(document.createElement('i'), document.createElement('span'));
      chip.addEventListener('click', () => {
        if (clientId === awareness.clientID) return rename();
        jumpTo(awareness.getStates().get(clientId));
      });
      chips.set(clientId, chip);
      peersEl.append(chip);
    }

    const label = me ? `${state.user.name} (you)` : state.user.name;
    if (chip.lastChild.textContent !== label) chip.lastChild.textContent = label;
    if (chip.style.getPropertyValue('--peer') !== state.user.color) {
      chip.style.setProperty('--peer', state.user.color);
    }
    chip.classList.toggle('me', me);
    chip.classList.toggle('typing', Boolean(state.typing));
    const title = me ? 'Click to rename yourself' : `Jump to ${state.user.name}'s cursor`;
    if (chip.title !== title) chip.title = title;
  }

  // Reorder only when the order actually changed, so nothing is detached for free.
  order.forEach((clientId, index) => {
    const chip = chips.get(clientId);
    if (peersEl.children[index] !== chip) peersEl.insertBefore(chip, peersEl.children[index] ?? null);
  });

  peerCountEl.textContent = states.length === 1 ? '1 here' : `${states.length} here`;
};

const rename = () => {
  const next = prompt('Your display name', identity.name)?.trim();
  if (!next) return;
  identity.name = next.slice(0, 40);
  identity.custom = true;
  saveIdentity(identity);
  awareness.setLocalStateField('user', identity);
  renderPeers();
};

/**
 * Give up a colour someone else already had.
 *
 * The window with the higher client id yields, so both sides agree on who moves
 * and the room settles after one hop instead of trading colours forever.
 */
const resolveColourClash = () => {
  const states = [...awareness.getStates().entries()];
  const clash = states.some(([id, s]) => id < awareness.clientID && s.user?.color === identity.color);
  if (!clash) return;
  const taken = new Set(states.filter(([id]) => id !== awareness.clientID).map(([, s]) => s.user?.color));
  const next = pickIdentity(taken);
  identity.color = next.color;
  identity.colorLight = next.colorLight;
  if (!identity.custom) identity.name = next.name;
  saveIdentity(identity);
  awareness.setLocalStateField('user', identity);
};

awareness.on('change', () => {
  resolveColourClash();
  renderPeers();
});
renderPeers();

// A short-lived flag, not a timestamp: clocks across machines do not agree.
let typingTimer;
const markTyping = () => {
  if (!awareness.getLocalState()?.typing) awareness.setLocalStateField('typing', true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => awareness.setLocalStateField('typing', false), 900);
};

// -------------------------------------------------------------------- status

const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const countsEl = document.getElementById('counts');
const latencyEl = document.getElementById('latency');
const toastEl = document.getElementById('toast');

let toastTimer;
const toast = (message) => {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
};

// ---------------------------------------------------------------- error strip

const alertEl = document.getElementById('alert');
const alertText = document.getElementById('alert-text');
let alertRetry = null;

// Failures here are the ones a user cannot diagnose from an editor that simply
// stops updating, so they get said out loud instead of only in the console.
const showAlert = (message, retry = null) => {
  alertText.textContent = message;
  alertRetry = retry;
  document.getElementById('alert-retry').hidden = !retry;
  alertEl.hidden = false;
};

const hideAlert = () => { alertEl.hidden = true; alertRetry = null; };

document.getElementById('alert-retry').addEventListener('click', () => {
  const retry = alertRetry;
  hideAlert();
  retry?.();
});
document.getElementById('alert-close').addEventListener('click', hideAlert);

let failures = 0;
const reconnect = () => { provider.disconnect(); provider.connect(); };

provider.on('connection-error', () => {
  failures += 1;
  // One dropped socket is normal; a pattern of them is worth interrupting for.
  if (failures >= 2 && !offline) {
    showAlert(`Can't reach the relay at ${transport.host} — still retrying. Your edits are safe locally and will merge when it returns.`, reconnect);
  }
});
provider.on('status', ({ status }) => {
  if (status === 'connected') { failures = 0; hideAlert(); }
});

addEventListener('error', (event) => {
  showAlert(`Something broke: ${event.message || 'unknown error'} — reload if the editor stops responding.`);
});
addEventListener('unhandledrejection', (event) => {
  showAlert(`Something broke: ${event.reason?.message || event.reason || 'unknown error'}`);
});

let offline = false;
const setConn = (state) => {
  const label = offline ? 'offline (edits queued)' : state;
  connDot.dataset.state = offline ? 'offline' : state;
  connText.textContent = label;
};

provider.on('status', ({ status }) => setConn(status));
provider.on('sync', (synced) => { if (synced && !offline) setConn('synced'); });
provider.on('connection-close', () => setConn('disconnected'));

const updateCounts = () => {
  const value = text.toString();
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const lines = value ? value.split('\n').length : 0;
  countsEl.textContent = `${value.length} chars · ${words} words · ${lines} lines`;
};

// One repaint per animation frame however fast the updates arrive.
let scheduled = false;
text.observe(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; updateCounts(); });
});
doc.on('afterTransaction', (tr) => { if (tr.local && tr.changed.size) markTyping(); });
updateCounts();

// A median over the recent window, not a running average: a backgrounded window
// gets its timers throttled by the browser, and one such sample would drag an
// average for a minute while the median shrugs it off.
const recentRtt = [];
let bestRtt = Infinity;
startPulse(awareness, (rtt) => {
  if (rtt === null) {
    latencyEl.textContent = awareness.getStates().size > 1 ? 'rtt paused (busy room)' : 'waiting for a peer';
    return;
  }
  recentRtt.push(rtt);
  if (recentRtt.length > 9) recentRtt.shift();
  bestRtt = Math.min(bestRtt, rtt);
  const median = [...recentRtt].sort((a, b) => a - b)[Math.floor(recentRtt.length / 2)];
  latencyEl.textContent = `${median.toFixed(1)} ms rtt · best ${bestRtt.toFixed(1)}`;
});

document.getElementById('transport').textContent = transport.ours
  ? 'own relay'
  : `via ${transport.host}`;
document.getElementById('transport').title = transport.ours
  ? `This page is served by its own relay (${transport.url})`
  : `Shared public relay: ${transport.url} — add ?relay=wss://your-host/ws to use your own`;

// A relay we do not own will not seed a fresh room for us, so the first window
// in does it. The lowest client id wins that job: two windows opening the same
// empty room at once would otherwise both insert the welcome text.
if (!transport.ours) {
  provider.once('sync', () => {
    setTimeout(() => {
      if (text.length > 0) return;
      const ids = [...awareness.getStates().keys()];
      if (Math.min(...ids) !== awareness.clientID) return;
      text.insert(0, SEED);
    }, 400);
  });
}

// ------------------------------------------------------------------- controls

document.getElementById('room-name').textContent = room;
document.getElementById('room-name').addEventListener('click', () => {
  const next = prompt('Room name', room)?.trim();
  if (!next || next === room) return;
  location.hash = next.replace(/[^\w.:-]/g, '');
  location.reload();
});

document.getElementById('open-window').addEventListener('click', () => {
  // A separate window with its own sessionStorage — a genuinely separate person.
  window.open(location.href, '_blank', 'width=900,height=760,noopener');
});

document.getElementById('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Room link copied');
  } catch {
    toast(location.href);
  }
});

const netBtn = document.getElementById('toggle-net');
netBtn.addEventListener('click', () => {
  offline = !offline;
  if (offline) {
    provider.disconnect();
    netBtn.textContent = 'Go online';
    netBtn.classList.add('warn');
    setConn('offline');
    toast('Offline — keep typing, it merges on reconnect');
  } else {
    provider.connect();
    netBtn.textContent = 'Go offline';
    netBtn.classList.remove('warn');
    setConn('connecting');
    toast('Back online — merging');
  }
});

// Presence is torn down explicitly so other windows drop the caret at once
// instead of waiting for a socket timeout.
addEventListener('beforeunload', () => awareness.destroy());
