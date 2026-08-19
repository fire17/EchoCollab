<div align="center">

<img src="assets/banner.svg" width="100%" alt="ECHO — two windows, one document, every caret its own colour">

[![pages](https://github.com/fire17/EchoCollab/actions/workflows/pages.yml/badge.svg)](https://github.com/fire17/EchoCollab/actions/workflows/pages.yml)
[![live](https://img.shields.io/badge/live-dxos.akeyo.io-4fd1c5)](https://dxos.akeyo.io)
[![servers](https://img.shields.io/badge/servers%20required-0-4fd1c5)](#-the-part-that-should-stop-you)
[![tests](https://img.shields.io/badge/end--to--end%20tests-9%2F9-4fd1c5)](test/smoke.js)
[![converged](https://img.shields.io/badge/1000%20clients-byte--identical-a78bfa)](#-measured-not-claimed)
[![p50](https://img.shields.io/badge/propagation%20p50-0.44%20ms-a78bfa)](#-measured-not-claimed)
[![relay](https://img.shields.io/badge/relay-144%20lines-f6ad55)](server/sync.js)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/fire17/EchoCollab?style=social)](https://github.com/fire17/EchoCollab/stargazers)

*No save button. No locking. No "someone else is editing this file".*

**[⚡ Try it live](https://dxos.akeyo.io)** · **[🚀 Quickstart](#-quickstart)** · **[🧠 How it works](#-how-it-works)** · **[📊 Measured](#-measured-not-claimed)** · **[🔬 Making of](#-how-this-was-actually-built)**

</div>

---

## 🛑 The part that should stop you

**Open [dxos.akeyo.io](https://dxos.akeyo.io) in two windows and type. There is no server in the path. Not ours, not anyone's.**

- The page is **static** — GitHub Pages, nothing running, no bill, nothing to keep awake.
- Browsers find each other through **public BitTorrent trackers** — infrastructure that already exists for everyone — then talk **directly over WebRTC**. The tracker relays two SDP blobs and never sees a keystroke. Rendezvous approach, tracker pool and wire format come from [fire17/p2p](https://github.com/fire17/p2p), which verified them live.
- Two windows of one browser skip even that, meeting over **BroadcastChannel in [138 ms](#-measured-not-claimed)** — the demo works with the network unplugged.
- Once connected, a round trip is **1.3 ms**, because the shortest path between two windows is a straight line.
- A relay is still there if you want one — `npm start` runs a **[144-line](server/sync.js)** one where 1000 browsers converge byte-identical at a **median 8.9 ms** — but the published site does not use it, and nothing breaks without it.
- Every number here came out of a command in this repo. The [benchmark](bench/load.js) fails the run if clients disagree by a single character.

> [!IMPORTANT]
> Conflict-free editing is not a hard server problem — it is a *data structure* choice. Pick a CRDT and the server stops being the thing that has to be smart, correct, or even present. Take that seriously enough and it stops being present at all.

<table>
<tr>
<td width="50%"><img src="assets/shot-dark.png" alt="ECHO in dark mode: three peers, two remote carets with name labels"></td>
<td width="50%"><img src="assets/shot-light.png" alt="ECHO in light mode: the same document from another window"></td>
</tr>
</table>

## 🚀 Quickstart

```bash
git clone https://github.com/fire17/EchoCollab && cd EchoCollab
npm install && npm start
```

Open **http://localhost:1234**, press **Open 2nd window**, put the two side by side, and type in either one.

Or skip all of it and open **[dxos.akeyo.io](https://dxos.akeyo.io)** twice.

## ✨ What it does

| | |
|---|---|
| **Live shared text** | Character-level merge. Two people can type on the same word at the same time and nobody's edit is lost. |
| **Coloured carets** | Every window gets a colour and a name; their caret, selection and label render in every other window — and [no two peers ever share a colour](src/identity.js). |
| **Presence** | Header chips for everyone in the room, pulsing while they type. Click a peer to jump to what they are working on. |
| **Shared undo** | Cmd/Ctrl+Z undoes *your* edits only — it never reaches into someone else's work. |
| **Offline tolerant** | Press **Go offline**, keep typing in both windows, come back. The edits merge; nothing conflicts, nothing is lost. |
| **Local-first load** | The last known text paints from IndexedDB before the socket opens. |
| **Honest latency** | The footer shows a real round trip, [measured over whatever transport is in use](src/pulse.js) — no special endpoint, no invented number. |
| **Rooms** | The URL hash is the room. Click the room name to switch, **Copy link** to invite. |
| **Full editor** | CodeMirror 6: markdown highlighting, line numbers, folding, search, bracket matching, multiple cursors, soft wrap. |
| **Survives restarts** | Rooms are [snapshotted to disk](server/persistence.js) and reloaded; empty rooms are evicted from memory. |

## 🧠 How it works

Edits apply to the local CRDT **first** and are broadcast after, so typing never waits on a round trip — the network only carries the merge.

```mermaid
flowchart LR
  subgraph W["each window"]
    CM["CodeMirror 6"] <--> YD["Y.Doc (CRDT)"]
    YD <--> IDB["IndexedDB<br/><i>local-first paint</i>"]
  end
  YD --> T{"transport<br/>resolved once"}
  T -->|"published default"| P2P["peer to peer<br/><i>no server at all</i>"]
  T -->|"same browser"| BC["BroadcastChannel<br/><i>138 ms, works offline</i>"]
  T -->|"?relay=wss://…"| OWN["your relay"]
  T -->|"npm start"| SELF["144-line relay"]
  P2P -.->|"SDP only, once"| TR["public BitTorrent trackers<br/><i>never see the document</i>"]
  P2P --> W2["other windows<br/><i>direct WebRTC, 1.3 ms</i>"]
  BC --> W2
  OWN --> W2
  SELF --> W2

  style YD fill:#1a1030,stroke:#a78bfa,color:#e9deff
  style T fill:#0f2b2a,stroke:#4fd1c5,color:#c8fff8
  style P2P fill:#1a1030,stroke:#e8b84a,color:#f5d67b
  style BC fill:#1a1030,stroke:#e8b84a,color:#f5d67b
```

### Peer to peer, in three files

| | |
|---|---|
| [`src/p2p/tracker.js`](src/p2p/tracker.js) | Signalling over public WSS trackers — announce, offer, answer. The pool and wire format are p2p's, re-probed live (its third tracker had since died and was dropped). |
| [`src/p2p/mesh.js`](src/p2p/mesh.js) | A full mesh of WebRTC DataChannels: ICE against free public STUN, 16 KB chunking, and a glare rule both sides evaluate identically. |
| [`src/p2p/provider.js`](src/p2p/provider.js) | The same sync + awareness protocol the relay speaks, over the mesh instead of through a middle — so the editor cannot tell which transport it has. |

### And a relay, if you want one

Three deliberate choices, all in [`server/`](server):

- **Own the protocol** ([`server/sync.js`](server/sync.js)). The obvious dependency resolves its own Yjs major while the browser build runs another; two CRDT versions on one wire is not a risk worth saving a file.
- **No compression.** `perMessageDeflate` costs more CPU per message than it saves on a few hundred bytes of delta, and adds latency to every keystroke.
- **Drop slow clients, never buffer them.** A socket that stops draining is closed once its send buffer passes `MAX_BUFFERED`, so one stalled tab cannot grow the server's memory.

## 📊 Measured, not claimed

[`npm run bench`](bench/load.js) drives real headless clients through the real relay and reports the distribution, not an average. One MacBook runs the server **and** every client at once — a hostile setup, since the load generator competes with the thing it measures.

### Peer to peer — the published path, driven by real browsers

| | observed |
|---|---|
| Two windows of one browser meet | **138 ms** (BroadcastChannel, no network involved) |
| A separate browser profile meets | **5.2 s** (tracker rendezvous + ICE, first contact) |
| Round trip once connected | **1.3 ms** |
| Three peers, all typing | converged on an identical document |
| One peer offline, both typing, back online | isolated while offline, merged on return, nothing lost |

### With a relay — how far one process goes

| clients (one room) | connect + sync | propagation p50 | p95 | p99 | max | server RSS |
|---|---|---|---|---|---|---|
| 200 | 555 ms (2.8 ms each) | **0.44 ms** | 2.6 ms | 8.7 ms | 11 ms | 169 MB |
| 1000 | 9.1 s (9.1 ms each) | **8.9 ms** | 23 ms | 130 ms | 281 ms | 224 MB |

Every run asserts all clients ended byte-identical; a fast benchmark that quietly corrupted the text would be worthless.

```bash
npm run bench -- --clients 500 --edits 300 --gap 5
```

The client is 237 kB of gzipped JS plus 1.8 kB of CSS.

## 🔬 How this was actually built

One session, start to finish, with a browser driving the real thing at every step.

```mermaid
flowchart TD
  A["reproduce the DXOS demo<br/><i>the brief</i>"] --> B["Yjs + CodeMirror 6<br/><i>reuse, don't invent</i>"]
  B --> C["hand-write the relay<br/><i>dependency shipped a different CRDT major</i>"]
  C --> D["9 end-to-end tests<br/><i>real sockets, real restart</i>"]
  D --> E["headless Chromium<br/><i>5 windows, real carets</i>"]
  E --> F["benchmark to 1000 clients<br/><i>convergence asserted</i>"]
  F --> G["publish static<br/><i>no backend to run</i>"]

  style C fill:#1a1030,stroke:#e8b84a,color:#f5d67b
  style E fill:#0f2b2a,stroke:#4fd1c5,color:#c8fff8
  style F fill:#0f2b2a,stroke:#4fd1c5,color:#c8fff8
```

<details>
<summary><b>Five defects the process caught — each found by running it, not by reading it</b></summary>

<br>

| # | Defect | How it surfaced | Fix |
|---|---|---|---|
| 1 | Server and browser would have run **two different Yjs majors** | `npm ls yjs` after adding the obvious server dependency | Dropped it; wrote [`server/sync.js`](server/sync.js) against one pinned Yjs |
| 2 | `provider.destroy()` leaks the awareness heartbeat — **the test process never exits** | Test suite hung for 45 s and was killed | Tear down awareness first ([`test/smoke.js`](test/smoke.js)) |
| 3 | Two peers drew the **same colour** (5 windows → 3 colours) | Five-window browser run counted distinct caret colours | Higher client id yields and repicks the least-used hue ([`src/identity.js`](src/identity.js)) |
| 4 | Caret name labels **buried the line above** when peers stacked | Screenshot of four peers on consecutive lines | Labels fade after 2.4 s, return on hover ([`src/theme.js`](src/theme.js)) |
| 5 | The latency readout **re-timed already-answered pings**, reporting 144 ms where the truth was 2 ms | Median stayed far above the observed best | Sample each ping exactly once ([`src/pulse.js`](src/pulse.js)) |
| 6 | The presence row **flickered on every keystroke** | Reported by a human using it; a MutationObserver confirmed the chips were being replaced several times a second | Diff chips in place instead of rebuilding them ([`src/main.js`](src/main.js)) |
| 7 | Peers connected, synced, then **vanished** | Three-browser run: peer count fell back to 1 with no errors | A glare rule computed from each side's own id named *different* channels on the two sides, so both closed the one the other kept. The lower id's offer now wins, which both sides evaluate identically ([`src/p2p/mesh.js`](src/p2p/mesh.js)) |
| 8 | A dying duplicate channel **evicted a peer that was still connected** | Same run: presence dropped while the other path was healthy | Only forget a peer no path can reach ([`src/p2p/provider.js`](src/p2p/provider.js)) |

Three more were found in the plan rather than the code: y-webrtc's public signalling servers are **gone** (both resolve to nothing), which is why signalling rides BitTorrent trackers instead; one of p2p's three vetted trackers had **died since it was vetted**, found by re-probing rather than trusting the list; and a shared room needs an unguessable default name, or a stranger's link drops you into their document.

A fourth was a defect in the *test*, worth naming because it nearly sent a real one to production: two windows appeared not to converge, but the caret widgets inject invisible filler characters into the DOM, so the comparison was reading decoration as content.

</details>

<details>
<summary><b>Relay configuration</b></summary>

<br>

| | default | |
|---|---|---|
| `PORT` / `HOST` | `1234` / `0.0.0.0` | |
| `MAX_CONNECTIONS` | `10000` | upgrades refused with 503 past this |
| `MAX_BUFFERED` | `4 MB` | send-buffer ceiling before a client is dropped |
| `MAX_PAYLOAD` | `4 MB` | largest accepted frame |
| `PING_INTERVAL` | `25000` | heartbeat that reaps half-open sockets |
| `PERSIST` | `1` | `0` disables room snapshots |
| `DATA_DIR` | `./.data` | where snapshots go |
| `PERSIST_DEBOUNCE` | `2000` | ms of quiet before a snapshot is written |

`npm run dev` runs Vite with HMR and proxies the realtime paths to the relay, so the client always talks to its own origin.

**Scaling past one process:** rooms are already independent, so shard them across processes by room name behind a hash-routing proxy — a room's clients only need to reach the same process, and no cross-process coordination is required until one room outgrows one core. A shared Redis or Postgres behind [`persistence.js`](server/persistence.js) replaces the local snapshot at that point.

</details>

## 🔒 What it touches, and how to undo it

| | |
|---|---|
| Writes on your machine | `.data/` (room snapshots, relay only) and `node_modules/`, both inside the clone |
| Writes in your browser | IndexedDB, one entry per room, for local-first paint |
| Sends anywhere | The document goes **directly to the other windows**. Trackers get an opaque info-hash and two SDP blobs, once |
| Accounts, keys, telemetry | None |
| Uninstall | `rm -rf EchoCollab` — nothing lives outside the clone |
| Run it fully private | `npm start` and share nothing; or `PERSIST=0` to keep rooms in memory only |

> [!WARNING]
> **This is not end-to-end encrypted by us.** WebRTC gives the channel DTLS, and a tracker sees only an info-hash and SDP — but the room name is the whole access control, so treat a room link as the secret it is. [fire17/p2p](https://github.com/fire17/p2p) runs its own Noise IK handshake over exactly this kind of untrusted pipe; adopting that layer is the next step, not a shipped claim.

> [!NOTE]
> Peer to peer needs the peers to be reachable. ~85–90% of WebRTC pairs connect directly via STUN; a symmetric-NAT pair on both ends may not, and there is no TURN relay here by design. Two windows of one browser always work — that path never leaves the machine.

## 🚨 When something breaks, it says so

An editor that quietly stops updating is the worst failure mode in a collaborative tool —
it looks like it is working. Unreachable relays, dropped sockets and uncaught errors
interrupt with the relay's host, the reassurance that local edits are safe, and a retry:

<img src="assets/shot-error.png" width="100%" alt="ECHO showing a red banner: can't reach the relay, still retrying, edits are safe locally">

The banner clears itself the moment the connection comes back — verified by killing the
relay under a live browser and restarting it.

## ✅ How the claims are enforced

Every push runs [`npm test`](test/smoke.js) in CI: a real relay on its own port, real clients, and the properties this README promises — fresh rooms seeded, concurrent same-position edits converged, presence appearing and disappearing, an offline window losing nothing, a room surviving its last client, rooms isolated from each other, and **a client recovering after the relay is SIGKILLed under it**.

Stated plainly: **CI covers the relay, not the peer-to-peer path.** That path is exercised by driving real browsers against live public trackers — three peers converging, an offline peer merging back, a 1.3 ms round trip — which is a manual gate here, not an automated one. Every peer-to-peer number in this README came from that harness; none of it is asserted on every push, and it would be dishonest to imply otherwise.

## ⭐ If it made you open a second window

That was the whole idea — the demo is the argument. If it landed, a star is how it finds the next person who thinks realtime collaboration needs a big backend.

[![Star History Chart](https://api.star-history.com/svg?repos=fire17/EchoCollab&type=Date)](https://star-history.com/#fire17/EchoCollab&Date)

## 🔗 Related

- [fire17/p2p](https://github.com/fire17/p2p) — zero-dependency P2P chat: one key is your whole contact surface, no coordinator server
- [Yjs](https://github.com/yjs/yjs) · [y-codemirror.next](https://github.com/yjs/y-codemirror.next) · [CodeMirror 6](https://codemirror.net/) — the shoulders this stands on

Independent reproduction of a demo idea popularised by [DXOS](https://dxos.org); not affiliated with or endorsed by the DXOS project.

MIT licensed — see [LICENSE](LICENSE).

<div align="center">
<sub><i>Built in one session, verified by running it. Every number here came out of a command in this repo.</i></sub>
</div>
