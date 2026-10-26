import { TICK_MS, activeLevel, getTimings } from "@tetrinet3d/shared";
import type { Server } from "socket.io";
import { GameRoom } from "./Room.js";

/**
 * Server-seitige Game-Loop mit fixer Tick-Rate (20Hz).
 *
 * Jede Runde:
 *  1. Alle aktiven Spieler physisch weiterlaufen lassen (Fall-Logik).
 *  2. Geänderte Felder an den Raum senden (20Hz, gem. game.md §3.3).
 *  3. Game-Over/Winner-Prüfung.
 */
export class GameLoop {
  private io: Server;
  private room: GameRoom;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;

  constructor(io: Server, room: GameRoom) {
    this.io = io;
    this.room = room;
  }

  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.step(), TICK_MS);
    console.log(`[GameLoop] Raum ${this.room.roomId} gestartet (20Hz)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private step(): void {
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;

    // NIGHT-16.2 ("Spiel startet erst, wenn mindestens 2 Spieler/Teams spielen"):
    // Solo-Raum (genau 1 Spieler, keine Bots) → Warten in der Lobby. Kein Fall,
    // keine Bot-Updates, kein Game-Over. Sobald ein 2. Spieler dazukommt,
    // läuft das Spiel automatisch weiter (der Tick läuft ja immer im Hintergrund).
    if (this.room.players.length < 2) {
      return;
    }

    // NACHT 19 (mainmenu.md §2): Nur im INGAME-Status ticken.
    // LOBBY/READY_CHECK/POST_GAME = pausiert (kein Fallen, keine Bots,
    // kein Winner-Check). DEV-Modus startet direkt im INGAME (Kompatibilität).
    if (this.room.status !== "INGAME") {
      return;
    }

    // Bots erst denken (KI-Aktionen), dann ticken alle Spieler (Fall-Physik).
    this.room.updateBots(elapsed);

    // Level-System (levels.md): RAUM-LEVEL = Durchschnitt aller Spieler-Level.
    // Die Fallgeschwindigkeit folgt dem Raum-Level und gilt für ALLE identisch.
    const roomLevel = activeLevel(
      this.room.players.map((p) => p.level),
      0,
    );
    const { tickMs } = getTimings("CLASSIC", roomLevel);
    for (const player of this.room.players) {
      player.dropInterval = Math.max(1, tickMs);
    }

    for (const player of this.room.players) {
      const before = player.status;
      const invBefore = player.specialsInventory.length;
      player.tick(elapsed);

      // Grid-Update an den Raum senden
      this.room.broadcastGrid(player);

      // Nacht 15: Nach Gravity-Lock kann das Inventory gewachsen sein
      // (Specials bei Zeilen-Clear eingesammelt) — dann auch broadcasten.
      if (player.specialsInventory.length !== invBefore) {
        this.room.broadcastSpecials(player);
      }

      // Statuswechsel melden (Game Over -> Spectator)
      if (before !== player.status) {
        this.io.to(this.room.roomId).emit("player_status", {
          playerId: player.id,
          status: player.status,
        });
      }
    }

    // NIGHT-16.2 (robust): Winner-Prüfung JEDEN Tick, nicht nur bei Statuswechsel.
    // Bedingung: mind. 2 Spieler im Raum (sonst würde ein Solo-Spieler sich selbst
    // "gewinnen") UND genau EIN aktiver Spieler → der ist der Winner.
    // `getWinner()` liefert null, sobald ALLE Spieler inaktiv oder <2 Spieler.
    const winner = this.room.getWinner();
    if (winner && winner.status !== "winner") {
      winner.status = "winner";
      // NACHT 19: Spiel vorbei → POST_GAME (GameLoop pausiert, Ready-Check möglich).
      this.room.status = "POST_GAME";
      this.room.broadcastRoomStatus();
      // Nacht 18: im Team-Modus zählt das TEAM — Client zeigt
      // "Team X gewinnt!" + hebt das Team im Leaderboard hervor.
      this.io.to(this.room.roomId).emit("game_over", {
        winnerId: winner.id,
        winnerTeamId: this.room.getWinnerTeam(),
      });
      this.io.to(this.room.roomId).emit("player_status", {
        playerId: winner.id,
        status: "winner",
      });
      if (winner.team) {
        this.io.to(this.room.roomId).emit("chat", {
          from: "system",
          text: `🏆 Team ${winner.team} gewinnt! (letzter aktiver Spieler: ${winner.name})`,
        });
      }
    }
  }
}
