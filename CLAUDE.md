# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start local dev server (Wrangler)
- `npm run deploy` — deploy to Cloudflare Workers
- `npm run check` — TypeScript type-check (`tsc --noEmit`)

No test framework, linter, or build step is configured.

## Architecture

Multiplayer Battleship game running entirely on Cloudflare Workers + Durable Objects.
Server-authoritative: all game logic is validated server-side, clients are views.

### Backend (TypeScript)

- `src/index.ts` — Stateless Worker. Thin HTTP router that:
  - `GET /api/create` / `/api/create-bot` — generates a 6-char room code
  - `GET /api/room/:code/ws` — resolves DO via `idFromName(code)`, forwards WebSocket upgrade
  - Everything else → static assets
- `src/battleship-room.ts` — `BattleshipRoom` Durable Object. Single class per game room:
  - Manages 2 WebSocket connections (Hibernation API with `webSocketMessage`/`webSocketClose`)
  - Holds full game state in DO storage (`ctx.storage`)
  - Phases: `waiting` → `placement` → `playing` → `finished`
  - Bot opponent logic (hunt/target AI with checkerboard pattern)
  - 10-minute inactivity alarm auto-cleans rooms
  - Supports reconnect via `?rejoin=<playerIndex>` query param
- `src/room-code.ts` — room code generation (ambiguity-reduced alphabet)

### Frontend (vanilla JS, no build step)

Static files in `client/`, served via Cloudflare Workers Assets (`run_worker_first = true`
in wrangler.toml so the Worker handles API routes before falling through to assets).

- `client/index.html` — single-page app with lobby, placement, playing, and finished views
- `client/game.js` — all client logic: WebSocket management, state machine
  (LOBBY → CONNECTING → WAITING → PLACING → MY_TURN/OPPONENT_TURN → GAME_OVER),
  grid rendering, ship placement with drag preview
- `client/style.css` — styles

### Key patterns

- Game state is a single `GameState` object persisted to DO storage under key `"game"`
- Client receives filtered state: opponent's ship positions are hidden (`filterBoardForOpponent`)
- Ship adjacency rule: ships cannot touch each other (including diagonals), enforced in both
  `validateShips` (server) and `isValidPlacement` (client)
- WebSocket messages: `{ type: "placeShips", ships }` and `{ type: "fire", row, col }`
- Server broadcasts `{ type: "state", ... }` with per-player views after every action
