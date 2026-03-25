import { DurableObject } from "cloudflare:workers";

// --- Types ---

type GamePhase = "waiting" | "placement" | "playing" | "finished";
type PlayerIndex = 0 | 1;
type ShotResult = "hit" | "miss" | "sunk";
type CellState = "empty" | "ship" | "hit" | "miss";
type ShipName = "carrier" | "battleship" | "cruiser" | "submarine" | "destroyer";

interface ShipPlacement {
  name: ShipName;
  cells: [number, number][];
}

interface LastShot {
  row: number;
  col: number;
  result: ShotResult;
  sunkShip?: { name: ShipName; cells: [number, number][] };
}

interface GameState {
  phase: GamePhase;
  boards: [CellState[][], CellState[][]];
  ships: [ShipPlacement[] | null, ShipPlacement[] | null];
  currentTurn: PlayerIndex;
  winner: PlayerIndex | null;
  lastShot: LastShot | null;
}

interface ClientMessage {
  type: "placeShips" | "fire";
  ships?: ShipPlacement[];
  row?: number;
  col?: number;
}

const SHIP_SIZES: Record<ShipName, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

const GRID_SIZE = 10;
const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes

// --- Helpers ---

function emptyBoard(): CellState[][] {
  return Array.from({ length: GRID_SIZE }, () =>
    Array.from({ length: GRID_SIZE }, () => "empty" as CellState)
  );
}

function initialState(): GameState {
  return {
    phase: "waiting",
    boards: [emptyBoard(), emptyBoard()],
    ships: [null, null],
    currentTurn: 0,
    winner: null,
    lastShot: null,
  };
}

function validateShips(ships: ShipPlacement[]): string | null {
  if (!Array.isArray(ships) || ships.length !== 5) {
    return "Must place exactly 5 ships";
  }

  const expectedNames = new Set<ShipName>(Object.keys(SHIP_SIZES) as ShipName[]);
  const seenNames = new Set<string>();
  const occupied = new Set<string>();

  for (const ship of ships) {
    if (!expectedNames.has(ship.name)) return `Unknown ship: ${ship.name}`;
    if (seenNames.has(ship.name)) return `Duplicate ship: ${ship.name}`;
    seenNames.add(ship.name);

    const expectedSize = SHIP_SIZES[ship.name];
    if (!Array.isArray(ship.cells) || ship.cells.length !== expectedSize) {
      return `${ship.name} must have ${expectedSize} cells`;
    }

    // Check bounds and collect cells
    for (const cell of ship.cells) {
      if (!Array.isArray(cell) || cell.length !== 2) return "Invalid cell format";
      const [r, c] = cell;
      if (!Number.isInteger(r) || !Number.isInteger(c)) return "Cell coordinates must be integers";
      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) return "Cell out of bounds";
      const key = `${r},${c}`;
      if (occupied.has(key)) return "Ships overlap";
      occupied.add(key);
    }

    // Check contiguous and straight line
    const rows = ship.cells.map(([r]) => r);
    const cols = ship.cells.map(([, c]) => c);
    const isHorizontal = new Set(rows).size === 1;
    const isVertical = new Set(cols).size === 1;
    if (!isHorizontal && !isVertical) return `${ship.name} must be horizontal or vertical`;

    // Check contiguous
    if (isHorizontal) {
      cols.sort((a, b) => a - b);
      for (let i = 1; i < cols.length; i++) {
        if (cols[i] !== cols[i - 1] + 1) return `${ship.name} cells must be contiguous`;
      }
    } else {
      rows.sort((a, b) => a - b);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i] !== rows[i - 1] + 1) return `${ship.name} cells must be contiguous`;
      }
    }
  }

  if (seenNames.size !== 5) return "Must include all 5 ship types";
  return null;
}

function placeShipsOnBoard(board: CellState[][], ships: ShipPlacement[]): void {
  for (const ship of ships) {
    for (const [r, c] of ship.cells) {
      board[r][c] = "ship";
    }
  }
}

function filterBoardForOpponent(board: CellState[][]): CellState[][] {
  return board.map((row) =>
    row.map((cell) => (cell === "ship" ? "empty" : cell))
  );
}

function checkAllSunk(board: CellState[][]): boolean {
  return board.every((row) => row.every((cell) => cell !== "ship"));
}

function findSunkShip(
  board: CellState[][],
  ships: ShipPlacement[],
  hitRow: number,
  hitCol: number
): { name: ShipName; cells: [number, number][] } | undefined {
  for (const ship of ships) {
    const containsHit = ship.cells.some(([r, c]) => r === hitRow && c === hitCol);
    if (!containsHit) continue;
    const allHit = ship.cells.every(([r, c]) => board[r][c] === "hit");
    if (allHit) return { name: ship.name, cells: ship.cells };
  }
  return undefined;
}

// --- Durable Object ---

interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

export class BattleshipRoom extends DurableObject {
  private sessions: Map<WebSocket, { player: PlayerIndex }>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();
    // Rehydrate sessions from surviving WebSocket attachments (post-hibernation)
    for (const ws of this.ctx.getWebSockets()) {
      const data = ws.deserializeAttachment() as { player: PlayerIndex } | null;
      if (data) this.sessions.set(ws, data);
    }
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    let state = await this.loadState();

    // Handle reconnect: close stale socket for the same player
    const rejoinParam = url.searchParams.get("rejoin");
    if (rejoinParam !== null) {
      const rejoinPlayer = parseInt(rejoinParam) as PlayerIndex;
      for (const [sessionWs, session] of this.sessions) {
        if (session.player === rejoinPlayer) {
          try { sessionWs.close(1000, "Replaced by reconnect"); } catch {}
          this.sessions.delete(sessionWs);
        }
      }
    }

    // Reject if room is full
    if (this.sessions.size >= 2) {
      // Accept then immediately send error and close
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "error", message: "Room full" }));
      server.close(1008, "Room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    // If room is finished or doesn't exist, reset for a new game
    if (!state || state.phase === "finished") {
      state = initialState();
    }

    const playerIndex = this.sessions.size as PlayerIndex;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ player: playerIndex });
    this.sessions.set(server, { player: playerIndex });

    // Transition phases
    if (playerIndex === 0) {
      state.phase = "waiting";
    } else if (playerIndex === 1 && state.phase === "waiting") {
      state.phase = "placement";
    }

    await this.saveState(state);
    await this.resetAlarm();

    // Send initial state to all connected players.
    for (const [sessionWs, session] of this.sessions) {
      try {
        this.sendState(sessionWs, state, session.player);
      } catch {
        this.sessions.delete(sessionWs);
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.resetAlarm();

    if (typeof message !== "string" || message.length > 4096) return;

    const session = this.sessions.get(ws);
    if (!session) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      return;
    }

    if (!msg || typeof msg.type !== "string") {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      return;
    }

    const state = await this.loadState();
    if (!state) return;

    switch (msg.type) {
      case "placeShips":
        await this.handlePlaceShips(ws, session.player, msg, state);
        break;
      case "fire":
        await this.handleFire(ws, session.player, msg, state);
        break;
      default:
        ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (!session) return;

    const state = await this.loadState();
    if (!state) return;

    // If game is active, opponent wins by forfeit
    if (state.phase === "playing" || state.phase === "placement") {
      const opponent = (session.player === 0 ? 1 : 0) as PlayerIndex;
      state.phase = "finished";
      state.winner = opponent;
      await this.saveState(state);

      // Notify remaining player
      for (const [otherWs, otherSession] of this.sessions) {
        if (otherSession.player === opponent) {
          otherWs.send(JSON.stringify({ type: "opponentDisconnected" }));
          this.sendState(otherWs, state, otherSession.player);
        }
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (!session) return;

    const state = await this.loadState();
    if (!state) return;

    if (state.phase === "playing" || state.phase === "placement") {
      const opponent = (session.player === 0 ? 1 : 0) as PlayerIndex;
      state.phase = "finished";
      state.winner = opponent;
      await this.saveState(state);

      for (const [otherWs, otherSession] of this.sessions) {
        if (otherSession.player === opponent) {
          otherWs.send(JSON.stringify({ type: "opponentDisconnected" }));
          this.sendState(otherWs, state, otherSession.player);
        }
      }
    }
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(1000, "Room expired");
    }
    this.sessions.clear();
  }

  // --- Private methods ---

  private async handlePlaceShips(
    ws: WebSocket,
    player: PlayerIndex,
    msg: ClientMessage,
    state: GameState
  ): Promise<void> {
    if (state.phase !== "placement") {
      ws.send(JSON.stringify({ type: "error", message: "Wrong phase" }));
      return;
    }

    if (state.ships[player] !== null) {
      ws.send(JSON.stringify({ type: "error", message: "Already placed ships" }));
      return;
    }

    if (!msg.ships) {
      ws.send(JSON.stringify({ type: "error", message: "Missing ships" }));
      return;
    }

    const error = validateShips(msg.ships);
    if (error) {
      ws.send(JSON.stringify({ type: "error", message: error }));
      return;
    }

    state.ships[player] = msg.ships;
    placeShipsOnBoard(state.boards[player], msg.ships);

    // Check if both players have placed
    if (state.ships[0] !== null && state.ships[1] !== null) {
      state.phase = "playing";
      state.currentTurn = 0;
    }

    await this.saveState(state);
    this.broadcastState(state);
  }

  private async handleFire(
    ws: WebSocket,
    player: PlayerIndex,
    msg: ClientMessage,
    state: GameState
  ): Promise<void> {
    if (state.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Wrong phase" }));
      return;
    }

    if (state.currentTurn !== player) {
      ws.send(JSON.stringify({ type: "error", message: "Not your turn" }));
      return;
    }

    const { row, col } = msg;
    if (
      row === undefined || col === undefined ||
      !Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE
    ) {
      ws.send(JSON.stringify({ type: "error", message: "Out of bounds" }));
      return;
    }

    const opponent = (player === 0 ? 1 : 0) as PlayerIndex;
    const cell = state.boards[opponent][row][col];

    if (cell === "hit" || cell === "miss") {
      ws.send(JSON.stringify({ type: "error", message: "Already fired here" }));
      return;
    }

    let result: ShotResult;
    let sunkShip: { name: ShipName; cells: [number, number][] } | undefined;

    if (cell === "ship") {
      state.boards[opponent][row][col] = "hit";
      sunkShip = findSunkShip(state.boards[opponent], state.ships[opponent]!, row, col);
      result = sunkShip ? "sunk" : "hit";
    } else {
      state.boards[opponent][row][col] = "miss";
      result = "miss";
    }

    state.lastShot = { row, col, result, sunkShip };

    // Check win condition
    if (checkAllSunk(state.boards[opponent])) {
      state.phase = "finished";
      state.winner = player;
    } else {
      state.currentTurn = opponent;
    }

    await this.saveState(state);
    this.broadcastState(state);
  }

  private broadcastState(state: GameState): void {
    for (const [ws, session] of this.sessions) {
      this.sendState(ws, state, session.player);
    }
  }

  private sendState(ws: WebSocket, state: GameState, player: PlayerIndex): void {
    const opponent = (player === 0 ? 1 : 0) as PlayerIndex;
    const msg = {
      type: "state" as const,
      phase: state.phase,
      player,
      currentTurn: state.currentTurn,
      myBoard: state.boards[player],
      opponentBoard: filterBoardForOpponent(state.boards[opponent]),
      myShipsPlaced: state.ships[player] !== null,
      opponentReady: state.ships[opponent] !== null,
      winner: state.winner,
      lastShot: state.lastShot,
    };
    ws.send(JSON.stringify(msg));
  }

  private async loadState(): Promise<GameState | null> {
    return (await this.ctx.storage.get<GameState>("game")) ?? null;
  }

  private async saveState(state: GameState): Promise<void> {
    await this.ctx.storage.put("game", state);
  }

  private async resetAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_MS);
  }
}
