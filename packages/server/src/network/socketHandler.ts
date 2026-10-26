import { Server, Socket } from "socket.io";
import type {
  JoinRoomMessage,
  RenamePlayerMessage,
  PlayerInputMessage,
  UseSpecialMessage,
  ChatMessage,
  SpecialType,
  BotDifficulty,
} from "@tetrinet3d/shared";
import { GameRoom } from "../game/Room.js";

/**
 * Verarbeitet eingehende WebSocket-Events und leitet sie an die Räume weiter.
 * Ein Socket kann in genau einem Raum aktiv sein (Socket.data.roomId).
 */
export function registerSocketHandlers(io: Server, rooms: Map<string, GameRoom>): void {
  io.on("connection", (socket: Socket) => {
    // Bereits in einem Raum? Dann alten Raum verlassen
    const prevRoomId = socket.data.roomId as string | undefined;
    if (prevRoomId && rooms.has(prevRoomId)) {
      rooms.get(prevRoomId)?.removePlayer(socket);
    }

    /* ---------------------------------------------------------------- */
    /* join_room                                                         */
    /* ---------------------------------------------------------------- */
    socket.on("join_room", (payload: JoinRoomMessage) => {
      const name = sanitizeName(payload?.name);
      const roomId = "arena"; // Einzelne globale Arena
      let room = rooms.get(roomId);
      if (!room) {
        room = new GameRoom(roomId, io);
        rooms.set(roomId, room);
      }
      if (!room.addPlayer(socket, name)) {
        // Raum voll
        return;
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
