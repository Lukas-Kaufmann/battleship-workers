---
title: "feat: Multiplayer Battleship Game"
type: feat
status: active
date: 2026-03-25
deepened: 2026-03-25
origin: docs/brainstorms/2026-03-25-battleship-multiplayer-brainstorm.md
---

# feat: Multiplayer Battleship Game

## Enhancement Summary

**Deepened on:** 2026-03-25
**Sections enhanced:** 12
**Review agents used:** TypeScript reviewer, Architecture strategist, Security sentinel,
Performance oracle, Code simplicity reviewer, Frontend races reviewer, Pattern recognition

### Key Improvements

1. **Single-page app** — merged `index.html` + `game.html` into one page to avoid
   WebSocket loss on navigation (frontend races review)
2. **6-char room codes** — increased from 4 to resist brute-force (security review)
3. **Simplified message protocol** — state-push model reduces server→client messages
   from 9 types to 3 (simplicity review)
4. **Discriminated union types** — full TypeScript type safety for all messages (TS review)
5. **Client state machine** — explicit states gate all interactions, prevent race
   conditions (frontend races review)
6. **Single inactivity alarm** — replaced 4 phase-specific timeouts with one 10-min
   inactivity timer (simplicity + performance reviews)

### Corrections from Original Plan

- Dropped `IDLE` state — DO starts at `waiting` on first connection
- Fixed player indexing — 0-based everywhere, display as 1-based at client boundary
- Renamed `game-room.ts` → `battleship-room.ts` to match class name
- Switched from `new_sqlite_classes` to `new_classes` (KV storage, not SQLite)
- Changed to single HTML page (SPA) instead of two separate pages

---

## Overview

2-player, room-based Battleship game running entirely on Cloudflare.
Single Worker deployment with static assets (frontend) + Durable Objects (game rooms).
Repo under `Lukas-Kaufmann` GitHub account.

(see brainstorm: docs/brainstorms/2026-03-25-battleship-multiplayer-brainstorm.md)

## Architecture

### Single Worker with Static Assets

CF recommends Workers with static assets over separate Pages projects.
One `wrangler deploy` ships both Worker code and static frontend. Static asset
requests are free and served from the edge without invoking the Worker.

```
battleship-workers/
├── src/
│   ├── index.ts                # Worker entry — routes /api/* requests
│   ├── battleship-room.ts      # BattleshipRoom Durable Object + types
│   └── room-code.ts            # Room code generation
├── client/
│   ├── index.html              # Single-page app (lobby + game board)
│   ├── style.css               # Styles
│   └── game.js                 # Client state machine + WebSocket + UI
├── wrangler.toml
├── package.json
└── tsconfig.json
```

### Research Insights

- **Types co-located**: Inline types in `battleship-room.ts` instead of separate
  `types.ts`. For a project this size, one fewer file with no loss of clarity.
- **Single HTML page**: Avoids WebSocket loss on page navigation. Lobby and game
  board are DOM sections toggled via JS — no router needed.
- **No build step**: Vanilla JS frontend, static files served directly. Zero tooling
  beyond wrangler.

### Data Flow

```
Browser ──WebSocket──→ Worker (router) ──fetch()──→ BattleshipRoom DO
                                                    ├── state.storage (KV persistence)
                                                    ├── WebSocket connections (2 max)
                                                    └── game logic + validation
```

### wrangler.toml

```toml
name = "battleship-workers"
main = "src/index.ts"
compatibility_date = "2025-12-01"

[assets]
directory = "./client"
run_worker_first = ["/api/*"]

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "BattleshipRoom"

[[migrations]]
tag = "v1"
new_classes = ["BattleshipRoom"]
```

### Research Insights

- **`new_classes` not `new_sqlite_classes`**: Game state is a single JSON blob.
  KV-style `storage.put("state", obj)` is simpler — no schema, no migrations,
  no query language. SQLite is overkill for one key.
- **`run_worker_first = ["/api/*"]`**: Only API routes invoke the Worker.
  All other requests serve static assets from the edge at zero compute cost.
- **`not_found_handling`**: Omitted — not needed since we use a single `index.html`
  and don't have client-side routing with different URL paths.

## Worker Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/create` | Generate room code, return `{code}` |
| GET | `/api/room/:code/ws` | WebSocket upgrade → forward to DO |
| GET | `/*` | Static assets (automatic, no Worker code) |

### Research Insights

- **Room code in URL**: Worker parses `:code`, normalizes to uppercase, validates
  format (6 alphanumeric chars), then calls `env.GAME_ROOM.idFromName(code)`.
- **WebSocket upgrade check**: Worker must verify `Upgrade: websocket` header
  before forwarding to DO. Return 426 if missing.

## Game State Machine

```
              P1 connects
                ──────────→ WAITING
                                │ P2 connects
                                ▼
                            PLACEMENT
                                │ both players submit ships
                                ▼
                             PLAYING
                                │ all ships sunk OR disconnect
                                ▼
                            FINISHED
```

No `IDLE` state. The DO starts at `waiting` when the first player connects.
If the DO has no state (fresh or cleaned up), it initializes on first connection.

### Phase Transition Table

| From | To | Trigger |
|------|----|---------|
| (none) | `waiting` | First WebSocket connection |
| `waiting` | `placement` | Second player connects |
| `waiting` | (destroyed) | Inactivity alarm fires |
| `placement` | `playing` | Both players submit valid ships |
| `placement` | `finished` | Player disconnects |
| `playing` | `finished` | All ships sunk OR player disconnects |
| `finished` | (destroyed) | Inactivity alarm fires |

### Research Insights

- **Guard transitions**: Reject messages invalid for the current phase.
  `fire` during `placement` → error. `place_ships` during `playing` → error.
- **Single inactivity alarm**: One 10-minute timeout, reset on every WebSocket
  message. No phase-specific timeouts — simpler, fewer storage writes.
  If both players are active, the alarm never fires. If abandoned, cleanup
  happens within 10 minutes regardless of phase.

## WebSocket Message Protocol

JSON messages with `{type: string, ...payload}`. All field names use `camelCase`
(idiomatic for JS/TS). Player IDs are **0-indexed** everywhere — display as
1-based on the client if needed.

### Client → Server (2 message types)

```typescript
// Submit ship placement (all 5 ships at once)
{ type: "placeShips", ships: ShipPlacement[] }

// Fire at a cell
{ type: "fire", row: number, col: number }
```

### Server → Client (3 message types)

```typescript
// Full game state — sent after every mutation
// Client derives everything from this: phase, turn, hits, sunk ships, errors
{
  type: "state",
  phase: "waiting" | "placement" | "playing" | "finished",
  player: 0 | 1,                           // which player you are
  currentTurn: 0 | 1,                      // whose turn (during playing)
  myBoard: CellState[][],                  // your 10x10 board (ships visible)
  opponentBoard: CellState[][],            // opponent's board (ships hidden, hits/misses visible)
  myShipsPlaced: boolean,                  // have you placed ships?
  opponentReady: boolean,                  // has opponent placed ships?
  winner: 0 | 1 | null,                   // null until game over
  lastShot: { row: number, col: number, result: "hit" | "miss" | "sunk" } | null
}

// Error (invalid action, malformed message, etc.)
{ type: "error", message: string }

// Opponent disconnected — sent before transitioning to finished state
{ type: "opponentDisconnected" }
```

### Research Insights

- **State-push model**: Instead of 9+ specific server messages, the server
  broadcasts a `state` message after every mutation. The client is a pure
  function of state — no tracking of individual events, no reconciliation logic.
  This eliminates entire categories of race conditions.
- **Discriminated unions**: Define as TypeScript types for exhaustive switch checking:

```typescript
type GamePhase = "waiting" | "placement" | "playing" | "finished";
type PlayerIndex = 0 | 1;
type ShotResult = "hit" | "miss" | "sunk";
type CellState = "empty" | "ship" | "hit" | "miss";

type ShipName = "carrier" | "battleship" | "cruiser" | "submarine" | "destroyer";

interface ShipPlacement {
  name: ShipName;
  cells: readonly [row: number, col: number][];
}

// Client → Server
type ClientMessage =
  | { type: "placeShips"; ships: ShipPlacement[] }
  | { type: "fire"; row: number; col: number };

// Server → Client
type ServerMessage =
  | { type: "state"; /* ... full state fields */ }
  | { type: "error"; message: string }
  | { type: "opponentDisconnected" };
```

- **Message validation**: Incoming WebSocket JSON is `unknown`. Wrap
  `webSocketMessage` in try/catch. Validate `type` field against allowlist.
  Reject messages > 4KB. Check `typeof` on all expected fields.
- **Board filtering**: Server holds the full truth for both boards. When
  sending `state` to a player, strip ship positions from `opponentBoard`
  — only reveal `hit`, `miss`, and `empty` cells. Never send opponent's
  ship locations.

## Ship Placement Validation (Server-Side)

Single validation function, ~20 lines. Place ships on a 10x10 boolean grid:
for each ship, check bounds, check all cells are `false`, mark them `true`.

Rules:
- Ships must be horizontal or vertical (no diagonal)
- Ships must be within 10x10 grid bounds (0-9)
- Ships must not overlap
- Touching is allowed
- Exactly 5 ships: carrier(5), battleship(4), cruiser(3), submarine(3), destroyer(2)
- Cells must be contiguous and in a straight line
- Single submission — all ships in one message

### Research Insights

- **Constrain ship names**: Use `ShipName` union type, not free-form `string`.
  Validate name + expected length as a lookup:
  `{ carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 }`.
- **Reject duplicate placements**: If a player has already placed ships
  (in `placement` phase), reject subsequent `placeShips` messages.

## Disconnect Handling

**Decision: disconnect = forfeit.** No reconnect support.
(Simplest approach — no session tokens, no state replay needed.)

- Player disconnects → `webSocketClose` fires → send `opponentDisconnected`
  to remaining player → transition to `finished` with remaining player as winner
- Both disconnect → alarm fires → DO cleans up via `storage.deleteAll()`
- During `waiting`: P1 disconnects → alarm fires → room destroyed
- During `placement`: other player notified, game ends

### Research Insights

- **Handle `webSocketError` too**: Implement `webSocketError(ws, error)` —
  treat the same as `webSocketClose`. Call `ws.close(1011, "error")`.
- **Hibernation wake edge case**: If the DO wakes from hibernation and a
  player's WS is gone, the DO won't get a `webSocketClose` event for it.
  The alarm handles this — if no messages arrive within 10 minutes, cleanup.
- **Clear UX on disconnect**: Client shows an overlay immediately on
  `ws.onclose` with "Connection lost — game over" and a button to return
  to lobby. Disable all board interactions. Don't silently fail.

## Room Code Design

- **6 characters** from unambiguous alphabet:
  `ABCDEFGHJKMNPQRTUVWXY2346789` (28 chars, 28^6 ≈ 480M combinations)
- Generated server-side with `crypto.getRandomValues()`
- Input normalized: `code.toUpperCase().trim()`
- No collision detection needed at this scale (<100 concurrent rooms).
  `idFromName(code)` is deterministic. If the DO has stale state from
  a finished game, it resets on new connection.

### Research Insights

- **6 chars, not 4**: Security review flagged 4-char codes (614k combinations)
  as trivially brute-forceable. 6 chars (480M) makes enumeration impractical
  while remaining easy to type and read aloud.
- **Reset logic**: On new WebSocket connection, if `phase === "finished"` or
  no state exists, call `storage.deleteAll()` and start fresh. If
  `phase === "waiting" | "placement" | "playing"`, the room is occupied —
  handle as join attempt or reject if full.

## Room Lifecycle (Alarms)

```typescript
// Single inactivity alarm — 10 minutes
private async resetAlarm() {
  await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
}

async alarm() {
  await this.ctx.storage.deleteAll();
  for (const ws of this.ctx.getWebSockets()) {
    ws.close(1000, "Room expired");
  }
}
```

Alarm reset on every incoming WebSocket message (in `webSocketMessage` handler).
One timeout value for all phases. No alarm management in `webSocketClose` or
phase transitions — the message handler covers it.

### Research Insights

- **Alarm on messages, not transitions**: Resetting only on `webSocketMessage`
  is cleaner and fewer storage writes than resetting on every phase change.
  Active games naturally reset the alarm. Abandoned games expire.
- **`storage.setAlarm()` replaces any existing alarm**: No need to delete
  before setting. Single call per reset.
- **Cost**: Sub-millisecond storage write, negligible at 50-80 moves per game.

## Client State Machine

The frontend uses a single state variable that gates all user interactions.
No optimistic UI. No concurrent in-flight operations. Synchronous DOM
transitions before processing further WebSocket messages.

```
LOBBY → CONNECTING → WAITING_FOR_OPPONENT → PLACING →
PLACEMENT_SUBMITTED → MY_TURN → FIRING → OPPONENT_TURN →
(back to MY_TURN or GAME_OVER) → DISCONNECTED
```

### Key Implementation Patterns

```javascript
// State gates all interactions
let state = "LOBBY";

function transition(newState) {
  state = newState;
  renderForState(state);  // synchronous DOM update
}

// Every click handler checks state first
function handleCellClick(row, col) {
  if (state !== "MY_TURN") return;
  if (alreadyFiredAt(row, col)) return;
  transition("FIRING");
  ws.send(JSON.stringify({ type: "fire", row, col }));
}

// Every server message transitions state before updating DOM
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "state") {
    updateBoardsFromState(msg);  // synchronous DOM work
    updatePhaseFromState(msg);   // transition state
  }
};

// Connection loss — immediate, clear feedback
ws.onclose = () => {
  transition("DISCONNECTED");
  // Shows overlay: "Connection lost" + "Back to lobby" button
};
```

### Research Insights

- **No optimistic UI for fire**: Wait for server confirmation before
  showing hit/miss. The round-trip is <100ms — imperceptible for
  turn-based play. Optimistic UI creates rollback complexity.
- **Synchronous DOM transitions**: Phase changes must swap the DOM
  synchronously in the message handler. `onmessage` runs to completion
  before the next message dispatches (single-threaded event loop).
  No `await`, no `setTimeout` between phase change and DOM update.
- **Heartbeat via Hibernation API**: Use `setWebSocketAutoResponse()`
  for ping/pong without waking the DO. Client sends `"ping"`, gets
  `"pong"` automatically. If 3 pongs are missed, client considers
  connection dead and shows disconnect overlay.
- **SPA navigation**: Toggle `display` on `#lobby` and `#game` divs.
  One WebSocket connection lives for the entire session.

## Durable Object Implementation Pattern

Based on CF docs and the cursor-tracking example from Context7:

```typescript
import { DurableObject } from "cloudflare:workers";

export class BattleshipRoom extends DurableObject {
  sessions: Map<WebSocket, { player: PlayerIndex }>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Rehydrate sessions from surviving WebSocket attachments (post-hibernation)
    this.sessions = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const data = ws.deserializeAttachment();
      if (data) this.sessions.set(ws, data);
    }
    // Auto ping/pong without waking the DO
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Assign player slot, accept WebSocket
    const playerIndex = this.sessions.size as PlayerIndex; // 0 or 1
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ player: playerIndex });
    this.sessions.set(server, { player: playerIndex });
    // ... initialize or load game state, send initial state message
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.resetAlarm();
    try {
      if (typeof message !== "string" || message.length > 4096) return;
      const msg = JSON.parse(message) as unknown;
      // validate and dispatch based on msg.type...
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions.delete(ws);
    ws.close(code, reason);
    // Notify opponent, transition to finished if in active game
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.sessions.delete(ws);
    ws.close(1011, "Unexpected error");
  }
}
```

### Research Insights

- **`serializeAttachment`**: Store player index on the WebSocket itself.
  Survives hibernation (max 2048 bytes). Reconstructed in constructor
  via `deserializeAttachment()`.
- **Game state in storage**: `storage.put("game", gameState)` and
  `storage.get("game")` — single key, full state blob. Sub-ms reads/writes.
  Persist after every mutation for crash recovery.
- **Message size guard**: Reject messages > 4KB before parsing. CF has a
  1MB WebSocket limit, but parsing large JSON burns CPU unnecessarily.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| 3rd player connects | DO rejects, sends error, closes WS |
| Invalid room code format | Worker returns 400 before hitting DO |
| Fire out of turn | `{type: "error", message: "Not your turn"}` |
| Fire on already-hit cell | `{type: "error", message: "Already fired here"}` |
| Fire out of bounds | `{type: "error", message: "Out of bounds"}` |
| Invalid ship placement | `{type: "error", message: "...reason"}` |
| Malformed JSON | `{type: "error", message: "Invalid message"}` |
| Stale room (finished game) | DO resets state, starts new game |
| `placeShips` during `playing` | `{type: "error", message: "Wrong phase"}` |

### Research Insights

- **Don't echo internal errors**: Never include stack traces or internal
  state in error messages. Generic messages only.
- **Phase guards**: Every message handler checks `phase` first. This is
  the state machine enforcing valid transitions.

## Security Considerations

Proportionate to a no-auth, no-data, personal project.

| Concern | Mitigation | Priority |
|---------|-----------|----------|
| Room code brute-force | 6-char codes (480M combinations) | Done (in design) |
| WS message flooding | Per-connection rate: ignore if >10 msg/sec | Nice-to-have |
| Room creation spam | Cloudflare Rate Limiting Rules (dashboard) | Nice-to-have |
| Malformed input | try/catch + type validation in DO | Must-have |
| Message size | Reject > 4KB before JSON.parse | Must-have |
| Error info leakage | Generic error messages only | Must-have |

Rate limiting via CF dashboard (no code) can be added post-launch if needed.
For a fun project with friends, input validation and 6-char codes are sufficient.

## Implementation Phases

### Phase 1: Everything Works End-to-End

- [ ] Init git repo, `gh repo create Lukas-Kaufmann/battleship-workers --public`
- [ ] `package.json` with `wrangler` dependency
- [ ] `wrangler.toml` with DO binding and static assets config
- [ ] `tsconfig.json`
- [ ] Worker entry point (`src/index.ts`) — route `/api/create` and `/api/room/:code/ws`
- [ ] Room code generator (`src/room-code.ts`) — 6-char unambiguous codes
- [ ] `BattleshipRoom` DO (`src/battleship-room.ts`):
  - WebSocket Hibernation API (accept, message, close, error handlers)
  - State machine (waiting → placement → playing → finished)
  - Player connection/assignment via `serializeAttachment`
  - Ship placement validation
  - Fire logic (hit/miss/sunk, turn management)
  - Win condition
  - Disconnect = forfeit
  - Alarm-based inactivity cleanup
  - State-push broadcast after every mutation
- [ ] Single-page frontend (`client/index.html` + `client/game.js` + `client/style.css`):
  - Lobby: create room / enter code
  - Game board: two 10x10 grids, ship placement, fire interaction
  - Client state machine gating all interactions
  - WebSocket connection + message handling
  - Phase indicators, game over screen, disconnect overlay
- [ ] Verify with `wrangler dev` locally

### Phase 2: Deploy + Polish

- [ ] `wrangler login` (OAuth — not local API token)
- [ ] `wrangler deploy`
- [ ] End-to-end test in production (two browser tabs)
- [ ] Fix any bugs found during testing
- [ ] Add Cloudflare Rate Limiting Rules (dashboard) if deploying publicly

## Deployment Notes

- Local `CLOUDFLARE_API_TOKEN` is **not** the personal token — use `wrangler login` (OAuth)
- `gh repo create Lukas-Kaufmann/battleship-workers --public`
- Single deploy: `wrangler deploy` ships Worker + static assets together
- Static assets served from edge at zero compute cost
- Worker cold start: ~5-10ms (V8 isolate). DO instantiation: ~5-10ms additional.
  Total worst-case first-request: ~20-30ms. Not perceptible.

## Acceptance Criteria

- [ ] Two players can create and join a room via shareable 6-char code
- [ ] Both players can place 5 ships on a 10x10 grid
- [ ] Players take alternating turns firing at opponent's board
- [ ] Hit/miss/sunk feedback displayed in real-time via state-push
- [ ] Game ends when all ships of one player are sunk
- [ ] Disconnect results in forfeit for disconnecting player
- [ ] Inactive rooms are cleaned up within 10 minutes
- [ ] Entire app deployed via single `wrangler deploy`
- [ ] Code hosted on `Lukas-Kaufmann/battleship-workers` GitHub repo

## Sources

- **Origin brainstorm:**
  [docs/brainstorms/2026-03-25-battleship-multiplayer-brainstorm.md](../brainstorms/2026-03-25-battleship-multiplayer-brainstorm.md)
  — key decisions: single DO per room, room-code matchmaking, WebSocket
  Hibernation API, vanilla frontend, server-authoritative, no auth
- [Durable Objects WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Objects Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Durable Objects State API](https://developers.cloudflare.com/durable-objects/api/state/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [WebSocket Hibernation Server Example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
