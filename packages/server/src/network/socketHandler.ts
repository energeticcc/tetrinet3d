import { Server, Socket } from "socket.io";
import type {
  JoinRoomMessage,
  RenamePlayerMessage,
  PlayerInputMessage,
  UseSpecialMessage,
  ChatMessage,
  SpecialType,
  BotDifficulty,
  LobbyEntry,
} from "@tetrinet3d/shared";
import { MAX_PLAYERS } from "@tetrinet3d/shared";
import { GameRoom } from "../game/Room.js";

/**
 * NACHT 20 (Matchmaking-Hub): Der Default-Raum ist die globale Arena.
 * AI-Agenten + der klassische "just join"-Flow landen dort. Custom-Lobbys
 * werden via `create_lobby` erzeugt und erscheinen im Lobby-Browser.
 */
const DEFAULT_ROOM = "arena";

/**
 * NACHT 20: Baut die Lobby-Liste aus allen aktiven Räumen. Der Default-Raum
 * wird als "Arena (Default)" gelabelt, damit man jederzeit zurückkehren kann.
 */
function buildLobbies(rooms: Map<string, GameRoom>): LobbyEntry[] {
  const list: LobbyEntry[] = [];
  for (const [roomId, room] of rooms) {
    list.push({
      roomId,
      name: roomId === DEFAULT_ROOM ? "Arena (Default)" : room.name,
      players: room.players.length,
      maxPlayers: MAX_PLAYERS,
      gameMode: room.gameMode,
      speedMode: room.speedMode,
      full: room.players.length >= MAX_PLAYERS,
      inGame: room.status === "INGAME",
      hasPassword: room.hasPassword, // NACHT 20.5: Flag nur ja/nein, nie Klartext
    });
  }
  // Vollsortierung: offene Lobbys zuerst, dann nach Name.
  list.sort((a, b) => {
    if (a.full !== b.full) return a.full ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return list;
}

/** NACHT 20: Broadcast der Lobby-Liste an ALLE verbundenen Clients. */
function broadcastLobbies(io: Server, rooms: Map<string, GameRoom>): void {
  io.emit("lobbys_updated", { lobbies: buildLobbies(rooms) });
}

/**
 * NACHT 20: Aufräumen + Broadcast nach jedem Raum-Änderungs-Ereignis
 * (Join/Leave). Leere Custom-Lobbys werden entfernt (die Default-Arena bleibt).
 */
function afterRoomChange(io: Server, rooms: Map<string, GameRoom>): void {
  for (const [roomId, room] of rooms) {
    if (roomId !== DEFAULT_ROOM && room.players.length === 0) {
      room.dispose(); // NACHT 20: Game-Loop stoppen
      rooms.delete(roomId);
    }
  }
  broadcastLobbies(io, rooms);
}

/** NACHT 20: Erzeugt eine eindeutige 6-Zeichen-Lobby-Code (ohne Verwechslungs-Chars). */
function makeRoomCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // keine I/L/O/0/1
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return "lobby_" + code;
}

/**
 * Verarbeitet eingehende WebSocket-Events und leitet sie an die Räume weiter.
 * Ein Socket kann in genau einem Raum aktiv sein (Socket.data.roomId).
 */
/**
 * NACHT 20: Holt einen Raum oder erzeugt ihn — und wiret dabei immer den
 * `onPlayerCountChange`-Callback (→ `lobbys_updated`), damit sich die
 * Lobby-Liste bei JEDEM Join/Leave automatisch auffrischt.
 */
function getOrCreateRoom(io: Server, rooms: Map<string, GameRoom>, roomId: string): GameRoom {
  let room = rooms.get(roomId);
  if (!room) {
    room = new GameRoom(roomId, io);
    rooms.set(roomId, room);
  }
  room.onPlayerCountChange = () => afterRoomChange(io, rooms);
  return room;
}

/**
 * NACHT 20: Verlässt der Socket seinen AKTUELLEN Raum (falls vorhanden),
 * bevor er einen anderen betritt. Verhindert "Spieler in zwei Räumen".
 */
function leaveCurrentRoom(io: Server, rooms: Map<string, GameRoom>, socket: Socket): void {
  const currentId = socket.data.roomId as string | undefined;
  if (currentId && rooms.has(currentId)) {
    rooms.get(currentId)?.removePlayer(socket);
  }
  afterRoomChange(io, rooms);
}

export function registerSocketHandlers(io: Server, rooms: Map<string, GameRoom>): void {
  io.on("connection", (socket: Socket) => {
    // Bereits in einem Raum? Dann alten Raum verlassen
    const prevRoomId = socket.data.roomId as string | undefined;
    if (prevRoomId && rooms.has(prevRoomId)) {
      rooms.get(prevRoomId)?.removePlayer(socket);
      afterRoomChange(io, rooms);
    }

    // NACHT 20: Initial Lobby-Liste senden (Client rendert den Lobby-Browser).
    getOrCreateRoom(io, rooms, DEFAULT_ROOM);
    broadcastLobbies(io, rooms);

    /* ---------------------------------------------------------------- */
    /* join_room (NACHT 20: roomId wählbar, Default = "arena")           */
    /* ---------------------------------------------------------------- */
    socket.on("join_room", (payload: JoinRoomMessage) => {
      const name = sanitizeName(payload?.name);
      socket.data.playerName = name; // NACHT 20: für create_lobby + Anzeige
      const roomId = payload?.roomId ?? DEFAULT_ROOM;
      // NACHT 20: vorherigen Raum verlassen (kein "Spieler in zwei Räumen").
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        leaveCurrentRoom(io, rooms, socket);
      }
      const room = getOrCreateRoom(io, rooms, roomId);
      // NACHT 20.5: Passwort-Check — nur wenn der Socket NICHTS schon in diesem Raum ist.
      const alreadyIn = room.players.some((p) => p.id === socket.id);
      if (!alreadyIn && room.hasPassword && !room.checkPassword(payload?.password)) {
        socket.emit("lobby_denied", { reason: "wrong_password", roomId });
        return;
      }
      room.addPlayer(socket, name); // Room selbst sendet room_full / broadcastRoomState
      // NACHT 20: Spieler-Anzahl geändert → Lobby-Liste (per Callback in Room).
    });

    /* ---------------------------------------------------------------- */
    /* create_lobby (NACHT 20: eigene Lobby erstellen + beitreten)        */
    /* ---------------------------------------------------------------- */
    socket.on("create_lobby", (payload: { name?: string; password?: string }) => {
      const hostName = sanitizeName((payload?.name as string) || (socket.data.playerName as string) || "Player");
      // NACHT 20: vorherigen Raum verlassen (Host zieht in die neue Lobby um).
      leaveCurrentRoom(io, rooms, socket);
      const roomId = makeRoomCode();
      const room = new GameRoom(roomId, io);
      // Anzeigename: "Lobby <CODE>" (Host kann später umbenennen — Scope 3).
      const code = roomId.replace("lobby_", "");
      room.name = `Lobby ${code}`;
      // NACHT 20.5: optionales Passwort (SHA-256-Hash, nie Klartext persistiert)
      if (payload?.password) room.setPassword(payload.password);
      room.onPlayerCountChange = () => afterRoomChange(io, rooms); // NACHT 20
      rooms.set(roomId, room);
      if (room.addPlayer(socket, hostName)) {
        socket.emit("chat", { from: "system", text: `🏛 Lobby ${code} erstellt. Teile den Code, um Freunde einzuladen.` });
      }
    });

    /* ---------------------------------------------------------------- */
    /* rename_player (eigener Name ändern)                               */
    /* ---------------------------------------------------------------- */
    socket.on("rename_player", (payload: RenamePlayerMessage) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      room.renamePlayer(socket, sanitizeName(payload?.name));
    });

    /* ---------------------------------------------------------------- */
    /* player_input (Server-Validierung)                                 */
    /* ---------------------------------------------------------------- */
    socket.on("player_input", (payload: PlayerInputMessage) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !payload?.action) return;
      room.handleAction(socket, payload.action);
    });

    /* ---------------------------------------------------------------- */
    /* use_special                                                       */
    /* ---------------------------------------------------------------- */
    socket.on("use_special", (payload: UseSpecialMessage) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      const targetIndex = Math.max(0, Math.min(5, payload?.targetIndex ?? 0));
      const specialType = (payload?.specialType ?? "A") as SpecialType;
      room.handleUseSpecial(socket, targetIndex, specialType);
    });

    /* ---------------------------------------------------------------- */
    /* chat                                                              */
    /* ---------------------------------------------------------------- */
    socket.on("chat", (payload: ChatMessage) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      room.handleChat(socket, payload?.text ?? "");
    });

    /* ---------------------------------------------------------------- */
    /* rematch (nur nach Game Over)                                      */
    /* ---------------------------------------------------------------- */
    socket.on("rematch", () => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.requestRematch(socket);
    });

    /* ---------------------------------------------------------------- */
    /* bots (Lobby-Auffüllung, nur Leader)                               */
    /* ---------------------------------------------------------------- */
    socket.on("add_bots", (payload: { count?: number; difficulty?: BotDifficulty }) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      // Fallback = Raum-Default (DEV-Phase: ultra_nightmare, siehe config.ts).
      const difficulty = (payload?.difficulty ?? room.defaultDifficulty) as BotDifficulty;
      room.addBots(socket, payload?.count ?? 1, difficulty);
    });

    socket.on("remove_bots", () => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.removeBots(socket);
    });

    socket.on("set_bot_difficulty", (payload: { difficulty?: BotDifficulty }) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      // Fallback = Raum-Default (DEV-Phase: ultra_nightmare, siehe config.ts).
      const difficulty = (payload?.difficulty ?? room.defaultDifficulty) as BotDifficulty;
      room.setBotDifficulty(socket, difficulty);
    });

    /* ---------------------------------------------------------------- */
    /* set_game_mode (Nacht 18: Solo / 2er / 3er Teams, nur Leader)      */
    /* ---------------------------------------------------------------- */
    socket.on("set_game_mode", (payload: { mode?: string }) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      const mode = payload?.mode;
      if (mode === "solo" || mode === "team2" || mode === "team3") {
        room.setGameMode(socket, mode);
      }
    });

    /* ---------------------------------------------------------------- */
    /* set_speed_mode (NACHT 20: CLASSIC / TETRIFAST, nur Leader)        */
    /* ---------------------------------------------------------------- */
    socket.on("set_speed_mode", (payload: { mode?: string }) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      const mode = payload?.mode;
      if (mode === "CLASSIC" || mode === "TETRIFAST") {
        room.setSpeedMode(socket, mode);
      }
    });

    /* ---------------------------------------------------------------- */
    /* Nacht 19 (mainmenu.md §2.1): Ready-Check, Start, Teamname          */
    /* ---------------------------------------------------------------- */
    socket.on("start_ready_check", () => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.startReadyCheck(socket);
    });

    // NACHT 19 (Fix 19.2): Spieler klickt „Bereit\"/„Ablehnen\".
    socket.on("player_ready", (payload: { confirmed?: boolean }) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.playerReady(socket, !!payload?.confirmed);
    });

    // NACHT 19.2: Leader klickt „Start\" (alle müssen bereit sein).
    socket.on("confirm_start", () => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.confirmStart(socket);
    });

    socket.on("cancel_ready_check", () => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.cancelReadyCheck(socket);
    });

    socket.on("edit_team_name", (payload: { teamId?: string; newName?: string }) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;
      const teamId = payload?.teamId;
      if (teamId === "A" || teamId === "B" || teamId === "C") {
        room.editTeamName(socket, teamId, payload?.newName ?? "");
      }
    });

    /* ---------------------------------------------------------------- */
    /* disconnect                                                        */
    /* ---------------------------------------------------------------- */
    socket.on("disconnect", () => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) room.removePlayer(socket);
    });
  });
}

function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "Player";
  const trimmed = name.trim().slice(0, 20);
  return trimmed.length ? trimmed : "Player";
}
