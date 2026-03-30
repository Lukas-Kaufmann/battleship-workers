# Battleship

Multiplayer Battleship game running on Cloudflare Workers + Durable Objects.

Play against a friend (via room code) or a computer opponent. Classic rules:
10×10 grid, 5 ships, alternating turns, no adjacent ship placement.

## How it works

- A stateless Cloudflare Worker routes requests
- Each game room is a Durable Object that manages WebSocket connections,
  validates moves, and persists state
- The frontend is vanilla HTML/CSS/JS served as static assets — no build step

## Development

```
npm install
npm run dev
```

Opens a local dev server with Wrangler. The game is playable at `http://localhost:8787`.

## Deploy

```
npm run deploy
```

Deploys to Cloudflare Workers. Requires a Cloudflare account and `wrangler` auth.

## Type check

```
npm run check
```
