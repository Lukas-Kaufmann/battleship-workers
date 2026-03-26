// --- State ---

let state = "LOBBY";
let ws = null;
let roomCode = null;
let myPlayer = null;
let errorTimeout = null;
let reconnectAttempts = 0;
let isReconnecting = false;
const MAX_RECONNECT_ATTEMPTS = 5;

// Placement state
const SHIPS = [
  { name: "carrier", size: 5 },
  { name: "battleship", size: 4 },
  { name: "cruiser", size: 3 },
  { name: "submarine", size: 3 },
  { name: "destroyer", size: 2 },
];
let placedShips = [];
let currentShipIndex = 0;
let isHorizontal = true;

// --- DOM refs ---

const $lobby = document.getElementById("lobby");
const $game = document.getElementById("game");
const $btnCreate = document.getElementById("btn-create");
const $btnJoin = document.getElementById("btn-join");
const $inputCode = document.getElementById("input-code");
const $lobbyError = document.getElementById("lobby-error");
const $phaseText = document.getElementById("phase-text");
const $roomCodeDisplay = document.getElementById("room-code-display");

const $waitingView = document.getElementById("waiting-view");
const $waitingCode = document.getElementById("waiting-code");

const $placementView = document.getElementById("placement-view");
const $placementStatus = document.getElementById("placement-status");
const $placementBoard = document.getElementById("placement-board");
const $currentShipName = document.getElementById("current-ship-name");
const $btnRotate = document.getElementById("btn-rotate");
const $btnConfirmShips = document.getElementById("btn-confirm-ships");

const $playingView = document.getElementById("playing-view");
const $turnText = document.getElementById("turn-text");
const $myBoard = document.getElementById("my-board");
const $opponentBoard = document.getElementById("opponent-board");

const $finishedView = document.getElementById("finished-view");
const $resultText = document.getElementById("result-text");
const $finalMyBoard = document.getElementById("final-my-board");
const $finalOpponentBoard = document.getElementById("final-opponent-board");
const $btnNewGame = document.getElementById("btn-new-game");

const $disconnectOverlay = document.getElementById("disconnect-overlay");
const $btnBackLobby = document.getElementById("btn-back-lobby");
const $errorToast = document.getElementById("error-toast");

// --- Grid rendering ---

function createGrid(container, onClick) {
  container.innerHTML = "";
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      if (onClick) cell.addEventListener("click", () => onClick(r, c));
      container.appendChild(cell);
    }
  }
}

function renderBoard(container, board, showShips) {
  const cells = container.querySelectorAll(".cell");
  cells.forEach((cell) => {
    const r = parseInt(cell.dataset.row);
    const c = parseInt(cell.dataset.col);
    const val = board[r][c];
    cell.className = "cell";
    if (val === "ship" && showShips) cell.classList.add("ship");
    else if (val === "sunk") cell.classList.add("sunk");
    else if (val === "hit") cell.classList.add("hit");
    else if (val === "miss") cell.classList.add("miss");
  });
}

// --- Placement ---

function initPlacement() {
  placedShips = [];
  currentShipIndex = 0;
  isHorizontal = true;
  createGrid($placementBoard, handlePlacementClick);
  updatePlacementUI();
}

function updatePlacementUI() {
  if (currentShipIndex < SHIPS.length) {
    const ship = SHIPS[currentShipIndex];
    $currentShipName.textContent = `${ship.name} (${ship.size})`;
    $btnConfirmShips.disabled = true;
    $placementStatus.textContent = `Place your ${ship.name} (${ship.size} cells)`;
  } else {
    $currentShipName.textContent = "All placed!";
    $btnConfirmShips.disabled = false;
    $placementStatus.textContent = "All ships placed. Confirm when ready.";
  }
}

function getShipCells(row, col, size, horizontal) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    cells.push([r, c]);
  }
  return cells;
}

function isValidPlacement(cells) {
  const occupied = new Set();
  for (const ship of placedShips) {
    for (const [r, c] of ship.cells) occupied.add(`${r},${c}`);
  }
  return cells.every(
    ([r, c]) => r >= 0 && r < 10 && c >= 0 && c < 10 && !occupied.has(`${r},${c}`)
  );
}

function handlePlacementClick(row, col) {
  if (currentShipIndex >= SHIPS.length) return;

  const ship = SHIPS[currentShipIndex];
  const cells = getShipCells(row, col, ship.size, isHorizontal);

  if (!isValidPlacement(cells)) return;

  placedShips.push({ name: ship.name, cells });

  // Render placed ship
  const domCells = $placementBoard.querySelectorAll(".cell");
  for (const [r, c] of cells) {
    domCells[r * 10 + c].classList.add("ship");
  }

  currentShipIndex++;
  updatePlacementUI();
}

// Hover preview
$placementBoard.addEventListener("mouseover", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell || currentShipIndex >= SHIPS.length) return;
  clearPreview();

  const row = parseInt(cell.dataset.row);
  const col = parseInt(cell.dataset.col);
  const ship = SHIPS[currentShipIndex];
  const cells = getShipCells(row, col, ship.size, isHorizontal);
  const valid = isValidPlacement(cells);

  for (const [r, c] of cells) {
    if (r >= 0 && r < 10 && c >= 0 && c < 10) {
      const el = $placementBoard.children[r * 10 + c];
      el.classList.add(valid ? "preview" : "preview-invalid");
    }
  }
});

$placementBoard.addEventListener("mouseout", clearPreview);

function clearPreview() {
  $placementBoard.querySelectorAll(".preview, .preview-invalid").forEach((el) => {
    el.classList.remove("preview", "preview-invalid");
  });
}

$btnRotate.addEventListener("click", () => {
  isHorizontal = !isHorizontal;
  $btnRotate.textContent = isHorizontal ? "Rotate" : "Rotate";
});

$btnConfirmShips.addEventListener("click", () => {
  if (placedShips.length !== 5) return;
  state = "PLACEMENT_SUBMITTED";
  $btnConfirmShips.disabled = true;
  $placementStatus.textContent = "Waiting for opponent...";
  ws.send(JSON.stringify({ type: "placeShips", ships: placedShips }));
});

// --- WebSocket ---

function connect(code) {
  // Clean up any existing connection
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }

  roomCode = code;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let wsUrl = `${protocol}//${location.host}/api/room/${code}/ws`;
  if (isReconnecting && myPlayer !== null) {
    wsUrl += `?rejoin=${myPlayer}`;
  }
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.onopen = () => {
    console.log("[ws] open, state was:", state);
    isReconnecting = false;
    transition("CONNECTING");
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "state":
          handleStateMessage(msg);
          break;
        case "error":
          console.warn("[ws] server error:", msg.message);
          showError(msg.message);
          // If we were firing, go back to MY_TURN
          if (state === "FIRING") transition("MY_TURN");
          break;
        case "opponentDisconnected":
          showError("Opponent disconnected");
          break;
      }
    } catch (e) {
    }
  };

  socket.onclose = (event) => {
    console.log("[ws] close, code:", event.code, "state:", state, "isCurrentSocket:", socket === ws);
    // Ignore close events from any socket that isn't the current one
    if (socket !== ws) return;
    if (state === "GAME_OVER" || state === "LOBBY") return;

    // During pre-game phases, reconnect silently
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS
        && (state === "CONNECTING" || state === "WAITING")) {
      reconnectAttempts++;
      isReconnecting = true;
      setTimeout(() => connect(roomCode), 1000 * reconnectAttempts);
      return;
    }

    isReconnecting = false;
    transition("DISCONNECTED");
  };

  socket.onerror = () => {};
}

function handleStateMessage(msg) {
  myPlayer = msg.player;
  $roomCodeDisplay.textContent = roomCode;

  switch (msg.phase) {
    case "waiting":
      reconnectAttempts = 0;
      console.log("[ws] got waiting state, transitioning to WAITING");
      transition("WAITING");
      $waitingCode.textContent = roomCode;
      break;

    case "placement":
      if (state !== "PLACEMENT_SUBMITTED") {
        transition("PLACING");
        initPlacement();
      }
      if (msg.opponentReady) {
        $placementStatus.textContent = msg.myShipsPlaced
          ? "Waiting for opponent..."
          : "Opponent is ready! Place your ships.";
      }
      break;

    case "playing":
      // Render boards
      createGrid($myBoard, null);
      createGrid($opponentBoard, handleFireClick);
      renderBoard($myBoard, msg.myBoard, true);
      renderBoard($opponentBoard, msg.opponentBoard, false);

      if (msg.currentTurn === myPlayer) {
        transition("MY_TURN");
        $turnText.textContent = "Your turn — fire!";
        $turnText.className = "your-turn";
      } else {
        transition("OPPONENT_TURN");
        $turnText.textContent = "Opponent's turn...";
        $turnText.className = "opponent-turn";
      }
      break;

    case "finished":
      createGrid($finalMyBoard, null);
      createGrid($finalOpponentBoard, null);
      renderBoard($finalMyBoard, msg.myBoard, true);
      renderBoard($finalOpponentBoard, msg.opponentBoard, false);

      if (msg.winner === myPlayer) {
        $resultText.textContent = "You Win!";
        $resultText.className = "win";
      } else {
        $resultText.textContent = "You Lose";
        $resultText.className = "lose";
      }
      transition("GAME_OVER");
      break;
  }
}

function handleFireClick(row, col) {
  if (state !== "MY_TURN") return;
  // Check if already fired (cell has hit or miss class)
  const cell = $opponentBoard.children[row * 10 + col];
  if (cell.classList.contains("hit") || cell.classList.contains("miss") || cell.classList.contains("sunk")) return;

  transition("FIRING");
  ws.send(JSON.stringify({ type: "fire", row, col }));
}

// --- State transitions ---

function transition(newState) {
  console.log("[transition]", state, "→", newState);
  state = newState;

  // Hide all views
  $waitingView.hidden = true;
  $placementView.hidden = true;
  $playingView.hidden = true;
  $finishedView.hidden = true;
  $disconnectOverlay.hidden = true;

  switch (newState) {
    case "LOBBY":
      $lobby.hidden = false;
      $game.hidden = true;
      $btnCreate.disabled = false;
      break;
    case "CONNECTING":
      $lobby.hidden = true;
      $game.hidden = false;
      $phaseText.textContent = "Connecting...";
      break;
    case "WAITING":
      $phaseText.textContent = "Waiting for opponent";
      $waitingView.hidden = false;
      break;
    case "PLACING":
      $phaseText.textContent = "Place your ships";
      $placementView.hidden = false;
      break;
    case "PLACEMENT_SUBMITTED":
      $phaseText.textContent = "Ships placed — waiting for opponent";
      $placementView.hidden = false;
      break;
    case "MY_TURN":
      $phaseText.textContent = "Your turn";
      $playingView.hidden = false;
      break;
    case "FIRING":
      $phaseText.textContent = "Firing...";
      $playingView.hidden = false;
      break;
    case "OPPONENT_TURN":
      $phaseText.textContent = "Opponent's turn";
      $playingView.hidden = false;
      break;
    case "GAME_OVER":
      $phaseText.textContent = "Game Over";
      $finishedView.hidden = false;
      break;
    case "DISCONNECTED":
      $disconnectOverlay.hidden = false;
      break;
  }
}

// --- Error toast ---

function showError(message) {
  $errorToast.textContent = message;
  $errorToast.hidden = false;
  clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => {
    $errorToast.hidden = true;
  }, 3000);
}

// --- Lobby actions ---

$btnCreate.addEventListener("click", async () => {
  $lobbyError.hidden = true;
  $btnCreate.disabled = true;
  try {
    const res = await fetch("/api/create");
    const data = await res.json();
    connect(data.code);
  } catch (err) {
    $lobbyError.textContent = "Failed to create room";
    $lobbyError.hidden = false;
    $btnCreate.disabled = false;
  }
});

$btnJoin.addEventListener("click", () => {
  const code = $inputCode.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    $lobbyError.textContent = "Enter a valid 6-character room code";
    $lobbyError.hidden = false;
    return;
  }
  $lobbyError.hidden = true;
  connect(code);
});

$inputCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $btnJoin.click();
});

// --- Post-game ---

$btnNewGame.addEventListener("click", () => {
  if (ws) ws.close();
  ws = null;
  roomCode = null;
  myPlayer = null;
  transition("LOBBY");
});

$btnBackLobby.addEventListener("click", () => {
  if (ws) ws.close();
  ws = null;
  roomCode = null;
  myPlayer = null;
  transition("LOBBY");
});
