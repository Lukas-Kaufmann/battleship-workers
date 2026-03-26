---
title: "feat: Computer opponent + sunk ship visual indicator"
type: feat
status: completed
date: 2026-03-26
origin: docs/brainstorms/2026-03-26-computer-opponent-brainstorm.md
---

# Computer Opponent + Sunk Ship Visual Indicator

Two features:
1. **Bot mode** — "Play vs Computer" with a server-side virtual player
2. **Sunk ship indicator** — visually distinguish sunk cells from regular hits (all games)

## Feature A: Computer Opponent

### Overview

Add a "Play vs Computer" button to the lobby. The Durable Object hosts a virtual
player 1 (no WebSocket) with medium-difficulty AI. Human always plays as player 0.

Key decisions from brainstorm (`docs/brainstorms/2026-03-26-computer-opponent-brainstorm.md`):
- Server-side virtual player in the DO (not client-side, not a WS bot)
- Single difficulty: hunt-around-hits + random targeting
- ~1s delay before bot fires
- Reuse existing room code system
- "Play Again" button for quick rematches

### API Contract

**New endpoint:** `GET /api/create-bot` in `src/index.ts`
- Returns `{ code }` (same as `/api/create`)
- Routes to a DO with the room code as ID

**WebSocket URL:** `/api/room/:code/ws?bot=1`
- The `?bot=1` param tells the DO this is a bot game on first connect
- On reconnect (`?rejoin=0`), the DO already knows from stored state

### Server Changes (`src/battleship-room.ts`)

#### State Model

```typescript
// Add to GameState
isBot: boolean;          // persisted — survives hibernation
botTargets: number[][];  // hunt queue: [[row,col], ...] — persisted
```

`isBot` gates all bot-specific behavior. `botTargets` stores the AI's pending
hunt cells (populated when a hit occurs, consumed on subsequent turns).

#### Bot Game Creation (in `fetch`)

When `?bot=1` and `sessions.size === 0`:
1. Set `state.isBot = true`
2. Generate and place bot ships via `generateRandomShips()`
3. Set `state.ships[1] = botShips`, place on `state.boards[1]`
4. Transition directly to `placement` (skip `waiting`)
5. Human connects as player 0, places their ships normally
6. When human confirms ships → `playing` phase (bot ships already placed)

#### Room Protection

When `isBot === true` and `sessions.size >= 1`, reject additional WebSocket
connections. Prevents a random user from joining a bot room by guessing the code.

#### Bot Turn Logic (in `handleFire`, after human's shot)

After processing the human's fire (and it's a bot game and game isn't finished):

```
1. Set currentTurn = 1 (bot)
2. Save state + broadcast (human sees "Opponent's turn")
3. await new Promise(r => setTimeout(r, 1000))
4. Pick bot's target cell (see AI section)
5. Process bot's shot using same fire logic
6. Set currentTurn = 0 (human)
7. Save state + broadcast
8. Reset inactivity alarm
```

Using `setTimeout` inside the DO handler (not the alarm API) avoids the
single-alarm conflict. DOs are single-threaded; the 1s wait holds the
handler open, which is fine for a short delay.

#### Bot AI: Target Selection

Medium difficulty — two modes:

**Hunt mode** (when `botTargets` is non-empty):
- Pop the next cell from `botTargets`
- Skip if already fired upon
- If empty targets remain but all are fired, fall through to random

**Random mode** (when `botTargets` is empty):
- Pick a random unfired cell from the human's board
- Use checkerboard pattern bias (row + col is even) for better coverage

**On hit:** push the 4 adjacent cells (up/down/left/right) to `botTargets`,
filtered to in-bounds and not already fired. On sunk ship: clear `botTargets`
entries that belong to the sunk ship (they're no longer useful) — but keep
entries from other unsunk hits.

#### Bot Ship Placement (`generateRandomShips`)

New helper function. Algorithm:
1. For each ship (largest first: carrier → patrol boat):
   - Pick random orientation (horizontal/vertical)
   - Pick random starting position
   - Check: in bounds, no overlap with placed ships
   - Retry (up to 100 attempts per ship, restart all if stuck)
2. Validate result with existing `validateShips()` as sanity check
3. Place on board via existing `placeShipsOnBoard()`

Largest-first ordering minimizes placement failures.

#### Disconnect Handling

Bot games do **not** forfeit on human disconnect. In `webSocketClose`:
- If `isBot && phase !== "finished"`: skip the forfeit logic, just remove
  the session. State persists. Human can reconnect via `?rejoin=0`.
- Inactivity alarm still fires after 10 minutes — cleans up abandoned games.

### Client Changes

#### Lobby (`client/index.html`)

Add "Play vs Computer" button in `.lobby-actions`:

```html
<button id="play-bot-btn">Play vs Computer</button>
```

#### Game Logic (`client/game.js`)

- **New state variable:** `let isBotGame = false`
- **Play vs Computer click:** calls `GET /api/create-bot`, stores code,
  sets `isBotGame = true`, calls `connect(code, { bot: true })`
- **`connect` function:** append `?bot=1` to WS URL when bot mode
- **State message handler:** read `msg.isBot` from server, set `isBotGame`
  (for reconnect scenarios where client state is lost)
- **Skip waiting view:** when `msg.phase === "placement"` arrives immediately,
  don't show "Waiting for opponent"
- **Labels:** show "Computer's Board" instead of "Opponent's Board" when
  `isBotGame`
- **"Play Again" button:** on finished view when `isBotGame`, clicking calls
  `/api/create-bot` again and connects to a new room
- **Room code display:** hide "Share this code" text in bot games, show
  "vs Computer" instead

### State Message Shape

Add `isBot: boolean` to the state message sent to clients:

```typescript
{
  type: "state",
  phase, player, currentTurn,
  myBoard, opponentBoard,
  myShipsPlaced, opponentReady,
  winner, lastShot,
  isBot  // NEW
}
```

When `phase === "finished"` and `isBot`: send the bot's full board
(unfiltered) so the human can see where all ships were.

---

## Feature B: Sunk Ship Visual Indicator

### Overview

When a ship is fully destroyed, mark its cells as `"sunk"` instead of
`"hit"`. Applies to both multiplayer and bot games.

### Server Changes (`src/battleship-room.ts`)

#### Type Change

```typescript
type CellState = "empty" | "ship" | "hit" | "miss" | "sunk";  // add "sunk"
```

#### Mark Sunk Cells (in `handleFire`)

After `findSunkShip` returns a sunk ship (around line 413):

```typescript
if (sunkShip) {
  for (const [r, c] of sunkShip.cells) {
    opponentBoard[r][c] = "sunk";
  }
}
```

Order of operations:
1. Set cell to `"hit"` ← existing
2. Call `findSunkShip` ← existing (checks all cells are `"hit"`)
3. If sunk: overwrite ship cells to `"sunk"` ← **new**
4. Check win condition ← existing (`checkAllSunk` checks for no `"ship"` cells — still works)

#### Fix: Already-Fired Guard

`handleFire` line ~403 currently checks `cell === "hit" || cell === "miss"`.
Must also include `"sunk"`:

```typescript
if (cell === "hit" || cell === "miss" || cell === "sunk") {
  // already fired here
}
```

Without this, firing at a `"sunk"` cell falls through and **corrupts state**
by overwriting `"sunk"` with `"miss"`.

#### `filterBoardForOpponent`

No change needed. Currently maps `"ship"` → `"empty"` and passes everything
else through. `"sunk"` cells pass through correctly — the opponent should
see them on their attack board.

### Client Changes (`client/game.js`)

#### `renderBoard` (line ~82)

Add sunk handling:

```javascript
else if (val === "sunk") cell.classList.add("sunk");
```

#### `handleFireClick` (line ~328)

Add sunk to the already-fired guard:

```javascript
if (cell.classList.contains("hit") || cell.classList.contains("miss")
    || cell.classList.contains("sunk")) return;
```

### CSS Changes (`client/style.css`)

`.cell.sunk` exists (line 134) but only sets `background: #b71c1c`.
Enhance for clarity and accessibility:

```css
.cell.sunk {
  background: #b71c1c;
  border: 1px solid #ff5252;  /* red border to distinguish from hit */
}
.cell.sunk::after {
  content: "\2716";           /* same X as .hit */
  color: #ff8a80;             /* lighter red — visually distinct from hit's white X */
  font-size: 1.2em;
}
```

The combination of border + different X color makes sunk cells clearly
distinguishable from regular hits, including for colorblind users.

---

## Implementation Order

### Phase 1: Sunk Ship Indicator (all games)

Small, self-contained, benefits all games immediately.

1. Add `"sunk"` to `CellState` type
2. Mark sunk cells in `handleFire` after `findSunkShip`
3. Fix already-fired guard to include `"sunk"`
4. Update `renderBoard` and `handleFireClick` in client
5. Enhance `.cell.sunk` CSS

Files changed: `src/battleship-room.ts`, `client/game.js`, `client/style.css`

### Phase 2: Bot Mode — Server Foundation

6. Add `isBot` and `botTargets` to `GameState`
7. Add `GET /api/create-bot` endpoint in `src/index.ts`
8. Implement `generateRandomShips()` helper
9. Handle bot game creation in `fetch` (skip waiting, auto-place bot ships)
10. Protect bot rooms from additional joins
11. Implement bot turn logic in `handleFire` (target selection + 1s delay)
12. Skip forfeit for bot games in `webSocketClose`

Files changed: `src/battleship-room.ts`, `src/index.ts`

### Phase 3: Bot Mode — Client

13. Add "Play vs Computer" button to lobby HTML
14. Wire up bot game creation flow in `game.js`
15. Add `isBot` to state messages, handle in client
16. Skip waiting view, update labels for bot games
17. Add "Play Again" flow for bot rematches
18. Reveal bot's full board on finished screen

Files changed: `client/index.html`, `client/game.js`, `client/style.css`

## Acceptance Criteria

### Sunk Ship Indicator

- [x] Sunk ship cells render visually distinct from regular hits
- [x] Sunk cells appear on both player's boards (your ships + opponent's attack)
- [x] Cannot fire at sunk cells (server rejects, client prevents click)
- [x] Works in both multiplayer and bot games
- [x] Accessible — sunk vs hit distinguishable beyond color alone

### Bot Mode

- [x] "Play vs Computer" button in lobby starts a bot game
- [x] Game skips waiting phase — goes directly to ship placement
- [x] Bot places valid ships (passes `validateShips`)
- [x] Bot fires after ~1s delay with medium AI (hunts around hits)
- [x] "Play Again" on finished screen starts a fresh bot game
- [x] Human can disconnect and reconnect without forfeiting
- [x] Bot room rejects additional WebSocket connections
- [x] Bot's full board revealed on game-over screen
- [x] Room code display replaced with "vs Computer" in bot games

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-26-computer-opponent-brainstorm.md](docs/brainstorms/2026-03-26-computer-opponent-brainstorm.md)
  — carried forward: server-side virtual player approach, single medium difficulty,
  lobby button entry point, 1s delay, room code reuse, Play Again button
- Game logic: `src/battleship-room.ts` (all server-side game state and validation)
- Client state machine: `client/game.js` (DOM rendering, WebSocket handling)
- Existing `.cell.sunk` CSS: `client/style.css:134` (defined but unused)
- `findSunkShip`: `src/battleship-room.ts:142-155` (already detects sunk ships)
- `lastShot.sunkShip`: `src/battleship-room.ts:420` (already sent to clients)
