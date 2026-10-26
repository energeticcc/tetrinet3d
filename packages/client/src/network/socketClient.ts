import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type {
  PlayerAction,
  RoomStateMessage,
  GridUpdateMessage,
  SpecialsUpdateMessage,
  SpecialTriggeredMessage,
  PlayerStatusMessage,
  GameOverMessage,
  ChatMessageOut,
  SpecialType,
  BotDifficulty,
  TeamMode,
} from "@tetrinet3d/shared";

// NIGHT-16.5 (LAN-Fix): Der Socket läuft ALWAYS SAME-ORIGIN (gleiche
// Origin wie die Seite). Damit muss ein LAN-Spieler NUR EINEN Port öffnen:
//   - Vite-Dev   : http://172.25.0.4:5173/ → Socket zu http://172.25.0.4:5173/socket.io
//                  → Vite-PROXY leitet /socket.io intern auf den WSL-Server (3000) weiter.
//                  Der LAN-Client sieht nur Port 5173 (kein 2. Port, kein CORS).
//   - Dist-Build : http://172.25.0.4:3000/ → Socket zu http://172.25.0.4:3000/socket.io
//                  (SAME-ORIGIN = der echte Server, kein Proxy nötig).
// Vorher (Nacht 16.4) wurde der Socket auf `:3000` gerichtet → im LAN
// (nur 5173 erreichbar) kam die Seite, aber der WebSocket verband NICHT
// → „Spielfeld bleibt leer".
const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
const SERVER_URL =
  env.VITE_SERVER_URL ||
  (typeof location !== "undefined" ? location.origin : "");

/**
 * Kapselt die WebSocket-Verbindung.
 * - Ausgabe (emit): joinRoom / sendAction / useSpecial / sendChat
 * - Eingabe: typisierte on/off-Listener
 */
export class SocketClient {
  readonly socket: Socket;

  constructor() {
    this.socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
      autoConnect: true,
    });
  }

  /* --- Ausgabe (Client -> Server) --- */
  /** NACHT 20 (Matchmaking-Hub): roomId optional — Default = globale Arena. NACHT 20.5: Passwort optional. */
  joinRoom(name: string, roomId?: string, password?: string): void {
    this.socket.emit("join_room", { name, roomId, password });
  }

  /** NACHT 20: Eigene Lobby erstellen (6-stelliger Code, Host wird Leader). NACHT 20.5: optionales Passwort. */
  createLobby(name?: string, password?: string): void {
    this.socket.emit("create_lobby", { name, password });
  }

  renamePlayer(name: string): void {
    this.socket.emit("rename_player", { name });
  }

  sendAction(action: PlayerAction): void {
    this.socket.emit("player_input", { action, timestamp: Date.now() });
  }

  useSpecial(targetIndex: number, specialType: SpecialType): void {
    this.socket.emit("use_special", { targetIndex, specialType });
  }

  sendChat(text: string): void {
    this.socket.emit("chat", { text });
  }

  requestRematch(): void {
    this.socket.emit("rematch");
  }

  /* --- Bots (Lobby-Auffüllung) --- */
  addBots(count: number, difficulty: BotDifficulty): void {
    this.socket.emit("add_bots", { count, difficulty });
  }

  removeBots(): void {
    this.socket.emit("remove_bots");
  }

  setBotDifficulty(difficulty: BotDifficulty): void {
    this.socket.emit("set_bot_difficulty", { difficulty });
  }

  /* --- Nacht 18: Spielmodus (Solo / 2er / 3er Teams, nur Leader) --- */
  setGameMode(mode: TeamMode): void {
    this.socket.emit("set_game_mode", { mode });
  }

  /* --- NACHT 20: Tempo-Modus (CLASSIC / TETRIFAST, nur Leader) --- */
  setSpeedMode(mode: "CLASSIC" | "TETRIFAST"): void {
    this.socket.emit("set_speed_mode", { mode });
  }

  /* --- Nacht 19 (mainmenu.md §2.1): Ready-Check + Start + Teamname --- */
  startReadyCheck(): void {
    this.socket.emit("start_ready_check");
  }

  /**
   * NACHT 19.2: Leader bestätigt den Start (Klick auf „Start\"-Knopf,
   * alle Spieler müssen bereit sein).
   */
  confirmStart(): void {
    this.socket.emit("confirm_start");
  }

  playerReady(confirmed: boolean): void {
    this.socket.emit("player_ready", { confirmed });
  }

  cancelReadyCheck(): void {
    this.socket.emit("cancel_ready_check");
  }

  editTeamName(teamId: "A" | "B" | "C", newName: string): void {
    this.socket.emit("edit_team_name", { teamId, newName });
  }

  get id(): string | null {
    return this.socket.id ?? null;
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  /* --- Eingabe (Server -> Client) --- */
  on(event: string, cb: (data?: unknown) => void): void {
    this.socket.on(event, cb as (data: unknown) => void);
  }

  off(event: string, cb: (data?: unknown) => void): void {
    this.socket.off(event, cb as (data: unknown) => void);
  }

  destroy(): void {
    this.socket.disconnect();
  }
}

/* Typisierte Listener-Helfer */
export type RoomStateCb = (state: RoomStateMessage) => void;
export type GridUpdateCb = (data: GridUpdateMessage) => void;
export type SpecialsUpdateCb = (data: SpecialsUpdateMessage) => void;
export type SpecialTriggeredCb = (data: SpecialTriggeredMessage) => void;
export type PlayerStatusCb = (data: PlayerStatusMessage) => void;
export type GameOverCb = (data: GameOverMessage) => void;
export type ChatCb = (data: ChatMessageOut) => void;
