import { generateRoomCode } from "./room-code";

export { BattleshipRoom } from "./battleship-room";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/create") {
      const code = generateRoomCode();
      return Response.json({ code });
    }

    const wsMatch = url.pathname.match(/^\/api\/room\/([A-Z0-9]{6})\/ws$/i);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Serve static assets for everything else
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
