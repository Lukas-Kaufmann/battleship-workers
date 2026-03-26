# Computer Opponent — Brainstorm

**Date:** 2026-03-26
**Status:** Draft

## What We're Building

A "Play vs Computer" mode so there's always an opponent available.
The human clicks a button in the lobby, gets matched against a
server-side bot, and plays a normal game of Battleship.

### Scope

- New "Play vs Computer" button in the lobby UI
- Server-side virtual player (no real WebSocket for player 2)
- Single difficulty level: medium (hunt-around-hits + random)
- ~1 second delay before bot fires to feel natural
- Bot reuses existing game validation (ship placement rules, fire rules)

### Out of Scope

- Multiple difficulty levels
- Auto-fill when no opponent joins a room
- Client-side bot logic
- Bot as a separate WebSocket client

## Why This Approach

**Server-side virtual player in the Durable Object.**

- Matches the existing architecture: all game logic is already
  server-authoritative in `BattleshipRoom`
- No duplication of game rules client-side
- Not cheatable — bot's ships are never sent to the client
- Simplest path: extends the existing state machine rather than
  building a parallel system

Rejected alternatives:

- **Client-side bot**: duplicates game logic, trivially cheatable,
  diverges from the server-authoritative model
- **Bot as WebSocket client**: over-engineered, adds deployment
  complexity for no real benefit

## Key Decisions

1. **Entry point**: dedicated "Play vs Computer" button in the lobby
   (not auto-fill or timeout-based)
2. **Architecture**: bot logic lives in the Durable Object as a
   virtual player 1 — no real WebSocket connection needed
3. **Difficulty**: single medium-level AI (hunt around hits, random
   otherwise). No difficulty picker.
4. **Turn delay**: ~1 second artificial delay before the bot fires
   to simulate a human opponent
5. **Bot ship placement**: server generates valid random placements
   using the same `validateShips` rules

## Resolved Questions

1. **Room codes for bot games**: reuse the existing room code system.
   Simpler, and the code is harmless even though nobody will join.
2. **Rematch**: yes — add a "Play Again" button after bot games that
   starts a fresh bot game without returning to the lobby.
