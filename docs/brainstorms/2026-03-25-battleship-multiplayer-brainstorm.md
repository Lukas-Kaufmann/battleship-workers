# Battleship Multiplayer — Brainstorm

**Date:** 2026-03-25
**Status:** Draft

## What We're Building

A 2-player, room-based Battleship game hosted entirely on Cloudflare:
- **Backend:** Cloudflare Workers + Durable Objects (game state, WebSocket handling)
- **Frontend:** Vanilla HTML/CSS/JS deployed to Cloudflare Pages
- **Repo:** GitHub, under `Lukas-Kaufmann` account

Classic Battleship rules: 10x10 grid, 5 ships (Carrier 5, Battleship 4,
Cruiser 3, Submarine 3, Destroyer 2), alternating turns, hit/miss/sunk.

This is a personal/fun project — functional over polished.

## Why This Approach

### Single Durable Object per room

One DO class `BattleshipRoom` per game room. The DO:
- Accepts both players' WebSocket connections (Hibernation API)
- Holds full game state (boards, ship placements, turn order, hits)
- Validates moves server-side
- Broadcasts results to both players
- Persists state to DO storage for crash recovery

The stateless CF Worker is a thin router — parses the room code from
the URL and forwards to the correct DO via `idFromName(roomCode)`.

**Rejected alternatives:**
- DO + KV room registry — YAGNI, no lobby needed
- Multi-DO (per-player + coordinator) — overengineered for 2 players

### Room-code matchmaking

Player 1 creates a room, gets a short code (e.g. `XKCD`), shares it.
Player 2 enters the code to join. No lobby, no public listing.

### WebSockets via Hibernation API

Real-time bidirectional communication. Durable Objects support WebSocket
Hibernation natively — the DO can sleep between messages, reducing costs.

## Architecture

```
┌──────────┐  WebSocket  ┌───────────┐  fetch()  ┌─────────────────┐
│ Browser A │ ──────────→ │ CF Worker │ ────────→ │ BattleshipRoom  │
└──────────┘              │ (router)  │           │ Durable Object  │
┌──────────┐  WebSocket  │           │  fetch()  │                 │
│ Browser B │ ──────────→ │           │ ────────→ │ - game state    │
└──────────┘              └───────────┘           │ - 2 WebSockets  │
                                                  │ - move validation│
┌──────────┐                                      └─────────────────┘
│ CF Pages │ ← static HTML/CSS/JS
└──────────┘
```

### Request flow

1. `GET /api/create` → Worker generates room code, returns it
2. `GET /api/room/:code/ws` → Worker resolves DO via `idFromName(code)`,
   forwards WebSocket upgrade
3. DO accepts connection, assigns player slot (1 or 2)
4. Players place ships → DO validates and stores
5. Players take turns firing → DO validates, updates state, broadcasts

### Game state (in DO)

- `phase`: `waiting` → `placement` → `playing` → `finished`
- `boards[0]`, `boards[1]`: ship positions + hit/miss markers
- `currentTurn`: 0 or 1
- `players`: WebSocket references

## Key Decisions

- **No auth** — room codes provide sufficient access control for a fun project
- **No database** — DO storage is the only persistence layer
- **No build step** — vanilla frontend, static files on CF Pages
- **Server-authoritative** — all game logic validated in the DO, clients
  are just views
- **Monorepo** — worker + frontend in one repo, deployed separately

## Open Questions

_None — all key decisions resolved._
