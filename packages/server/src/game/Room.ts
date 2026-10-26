import { Server, Socket } from "socket.io";
import { MAX_PLAYERS, applySpecialToGrid, swapGridContents, TEAM_SIZE, addGarbageLines, GARBAGE_LINES, TEAMS, activeLevel } from "@tetrinet3d/shared";
import type { PlayerRef, SpecialType, BotDifficulty, TeamMode, TeamId, RoomStatus, ReadyAbortReason, GameMode } from "@tetrinet3d/shared";
import { Player } from "./Player.js";
import { GameLoop } from "./GameLoop.js";
import { BotAI, gridHeight, BOT_PRESETS } from "./BotAI.js";
import { BOT_AUTOFILL, BOT_DEFAULT_DIFFICULTY, LOBBY_LEADER_NAME, READY_CHECK_MS, AFK_PENALTY_MS, TEAM_NAME_MAX_LEN } from "../config.js";
import { BOT_AVATARS } from "@tetrinet3d/shared";

/**
 * Verwaltet einen Raum mit bis zu 6 Spielern.
 * Server-Authoritative: alle Zustandsänderungen laufen hier zusammen.
 */
export class GameRoom {
  readonly roomId: string;
  /** NACHT 20 (Matchmaking-Hub): Anzeigename (Lobby-Browser + Topbar). */
  public name: string;
  private io: Server;
  public players: Player[] = [];
  private loop: GameLoop | null = null;
  /** Alle Bots im Raum (key = Bot-ID). */
  public bots: Map<string, BotAI> = new Map();
  /** Dev-Modus: Lobby wird automatisch mit Bots aufgefüllt. */
  public devBots: boolean = BOT_AUTOFILL;
  /** Default-Stufe für neue Bots. */
  public defaultDifficulty: BotDifficulty = BOT_DEFAULT_DIFFICULTY;
  /**
   * Nacht 18: Spielmodus (Solo / 2er-Teams / 3er-Teams).
   * Standard "solo" = bisheriges Verhalten (letzter aktiver Spieler gewinnt).
   * Team-Zuteilung ist AUTO (Beitrittsreihenfolge) und wird beim
   * (Neu-)Zuteilen per assignTeams() neu berechnet.
   */
  public gameMode: TeamMode = "solo";

  /**
   * NACHT 20 (Tempo-Modus): "CLASSIC" (Level-basierte Fallgeschwindigkeit)
   * oder "TETRIFAST" (sofortiger Fall, tickMs=0). Default "CLASSIC". Gilt für
   * ALLE Spieler im Raum identisch — GameLoop liest `speedMode` pro Tick.
   */
  public speedMode: GameMode = "CLASSIC";

  /**
   * NACHT 19 (mainmenu.md §2): Raum-Zustandsmaschine. DEV-Modus startet
   * direkt im INGAME (wie bisher, AI-Training braucht sofortiges Spiel).
   * Release-Modus: LOBBY → Leader startet Ready-Check → INGAME.
   */
  public status: RoomStatus = "INGAME";
  /** Night 19: 15s-Ready-Check-Timer (Server-seitig autoritativ). */
  private readyCheckTimer: NodeJS.Timeout | null = null;
  /** Night 19: Ende-Zeitpunkt des Ready-Check (Date.now()+READY_CHECK_MS). */
  private readyCheckEndsAt: number | null = null;
  /**
   * Night 19 (mainmenu.md §2.1 AFK-Sanktion): `penaltyEndsAt` pro Socket-ID.
   * 60s-Sperre nach AFK-Timeout — Spieler kann in dieser Zeit nicht neu
   * beitreten (mainmenu.md §2.1: `penaltyEndsAt = Date.now() + 60000`).
   */
  private afkPenalties: Map<string, number> = new Map();
  /** Night 19 (mainmenu.md §3): Editierbare Teamnamen (je TeamId). */
  public teamNames: Partial<Record<TeamId, string>> = {};
  /** Night 19: Seed für deterministische Randomizer (S2C_GameStart). */
  public lastSeed: number = (Math.random() * 0xffffffff) >>> 0;

  /**
   * NACHT 20 (Matchmaking-Hub): Callback, der bei jeder Änderung der
   * Spieler-Anzahl ausgelöst wird (addPlayer/removePlayer/spawnBots).
   * Der socketHandler nutzt es, um `lobbys_updated` an alle Clients zu senden.
   */
  public onPlayerCountChange: (() => void) | null = null;

  constructor(roomId: string, io: Server) {
    this.roomId = roomId;
    // NACHT 20: Anzeigename = roomId (kann vom Lobby-Host überschrieben werden).
    this.name = roomId;
    this.io = io;
    // NACHT 19: DEV-Modus = INGAME direkt (AI-Training + Auto-Start-Kompatibilität).
    // Release (devBots=false): LOBBY → Ready-Check → INGAME.
    this.status = this.devBots ? "INGAME" : "LOBBY";
  }

  /* ---------------------------------------------------------------- */
  /* Spieler-Verwaltung                                                */
  /* ---------------------------------------------------------------- */

  get byId(): Map<string, Player> {
    return new Map(this.players.map((p) => [p.id, p]));
  }

  /**
   * Nacht 18.1 (attack-addlines.md): Bindet alle Player-Callbacks an den Raum.
   * Wird in addPlayer/spawnBots aufgerufen — Player bleiben im Raum, der
   * Callback muss nur 1x gesetzt werden.
   */
  private bindPlayer(player: Player): void {
    player.onClearedLines = (cleared) => this.handleClearedLines(player, cleared);
  }

  /** NACHT 20: Meldet eine Spieler-Anzahl-Änderung an den Lobby-Browser. */
  private notifyPlayerCountChange(): void {
    if (this.onPlayerCountChange) this.onPlayerCountChange();
  }

  /** NACHT 20: Stoppt die Game-Loop (bei Aufräumen leerer Custom-Lobbys). */
  public dispose(): void {
    this.loop?.stop();
    this.loop = null;
  }

  addPlayer(socket: Socket, name: string): boolean {
    // NACHT 19 (mainmenu.md §2.1 Sanktion): AFK-Penalty blockiert den Beitritt.
    if (this.isPenalized(socket.id)) {
      const ends = this.afkPenalties.get(socket.id) ?? 0;
      const secs = Math.ceil((ends - Date.now()) / 1000);
      socket.emit("room_full");
      this.io.to(socket.id).emit("chat", {
        from: "system",
        text: `⏱ AFK-Sperre noch ${secs} s aktiv — bitte warte, bevor du wieder eintrittst.`,
      });
      return false;
    }
    if (this.players.length >= MAX_PLAYERS) {
      socket.emit("room_full");
      return false;
    }

    const seed = seedFromSocket(socket.id);
    const player = new Player(socket.id, name, seed);
    this.players.push(player);
    // Nacht 18.1: Garbage-Linien-Callback an den Raum binden.
    this.bindPlayer(player);
    socket.data.playerId = socket.id;
    socket.data.roomId = this.roomId;
    socket.join(this.roomId);

    // Dev-Modus: automatisch mit Bots auffüllen (Release: nur manuell)
    if (this.devBots) {
      const slots = MAX_PLAYERS - this.players.length;
      if (slots > 0) this.spawnBots(slots, this.defaultDifficulty);
    }

    // Nacht 18: Teams neu zuweisen (Beitritt → neue Reihenfolge).
    this.assignTeams();

    // Raum-Liste (sortiert: lokaler Spieler zuerst) an ALLE senden
    this.broadcastRoomState();
    this.broadcastBots();
    this.notifyPlayerCountChange(); // NACHT 20: Lobby-Browser auffrischen.

    // Game-Loop starten, sobald mindestens ein Spieler da ist
    if (!this.loop) {
      this.loop = new GameLoop(this.io, this);
      this.loop.start();
    }

    // Neuen Spieler grüßen
    this.logChat("system", `${name} betrat die Arena.`);
    if (this.devBots) this.logChat("system", `🤖 ${this.bots.size} Bots bereit (Dev-Modus).`);
    return true;
  }

  removePlayer(socket: Socket): void {
    const idx = this.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return;
    const [removed] = this.players.splice(idx, 1);
    this.logChat("system", `${removed.name} verließ die Arena.`);

    // Space-Fill nicht nötig: Indices in room_state werden neu gesendet
    if (this.players.length > 0) {
      // Nacht 18: Team-Roster neu aufteilen (Rücken-Fill).
      this.assignTeams();
      this.broadcastRoomState();
    } else {
      this.loop?.stop();
      this.loop = null;
    }

    // Winner neu prüfen (ggf. ist jetzt nur noch einer übrig)
    if (this.players.length === 1) {
      const only = this.players[0];
      only.status = "winner";
      this.status = "POST_GAME";
      this.io.to(this.roomId).emit("game_over", {
        winnerId: only.id,
        // Nacht 18: im Team-Modus gehört der letzte Überlebende seinem Team.
        winnerTeamId: only.team ?? null,
      });
      this.broadcastRoomStatus();
    }
    this.notifyPlayerCountChange(); // NACHT 20: Lobby-Browser auffrischen.
  }

  /**
   * NIGHT-16.2 (Bug-Fix "Spielende wird nicht erkannt"):
   * Gewinner = der EINZIG noch aktive Spieler, solange mind. 2 Spieler/Teams
   * im Raum sind. Zuvor: `players.length !== 1` → in Bots-auffüllten Räumen
   * (devBots, immer 6 Spieler) wurde NIE ein Gewinner gefunden, weil players.length
   * nie 1 ist. Jetzt basiert die Prüfung auf der ANZAHL aktiver Spieler.
   */
  getWinner(): Player | null {
    if (this.players.length < 2) return null; // Solo-Raum: niemand "gewinnt"

    // SOLO-Modus: bisherige Regel — genau ein aktiver Spieler = Winner.
    if (this.gameMode === "solo") {
      const active = this.players.filter((p) => p.status === "active");
      return active.length === 1 ? active[0] : null;
    }

    // TEAM-Modus (Nacht 18): Team-Totenkopf-Regel.
    // Gewinnt das Team T, das noch mind. 1 aktiven Spieler hat,
    // während ALLE anderen Teams KEINEN aktiven Spieler mehr haben.
    // Mehrere Teams mit Aktiv → noch nicht entschieden (null).
    const active = this.players.filter((p) => p.status === "active");
    if (active.length === 0) return null;

    const teamsWithActive = new Map<TeamId, number>();
    for (const p of active) {
      if (!p.team) continue;
      teamsWithActive.set(p.team, (teamsWithActive.get(p.team) ?? 0) + 1);
    }
    // Ohne Teams (z. B. nach Moduswechsel-Übergang) → Solo-Regel als Fallback.
    if (teamsWithActive.size === 0) {
      return active.length === 1 ? active[0] : null;
    }
    if (teamsWithActive.size !== 1) return null; // mehrere Teams aktiv → offen

    const winningTeam = [...teamsWithActive.keys()][0];
    // Der Winner-Spieler = der (einzige) noch aktive Spieler des gewinnenden Teams.
    // Bei mehreren aktiven im Team: der letzte verbliebene zählt — in der Praxis
    // scheidet ein Team aus, wenn der LETZTE seine letzte Zeile übersteigt,
    // d. h. es gibt exakt 1 aktiven. Fallback: erster aktiver des Teams.
    return active.find((p) => p.team === winningTeam) ?? null;
  }

  /**
   * Nacht 18: Ermittelt das gewinnende Team (bzw. null, wenn das Spiel
   * noch offen ist). Verwendet dieselbe Logik wie getWinner().
   */
  getWinnerTeam(): TeamId | null {
    const winner = this.getWinner();
    if (!winner) return null;
    return winner.team ?? null;
  }

  /**
   * Nacht 18: Teams neu zuweisen (auto, nach Beitrittsreihenfolge).
   *   - "solo"  : alle Spieler bekommen team = undefined.
   *   - "team2" : nacheinander A,A,B,B,C,C (je 2).
   *   - "team3" : nacheinander A,A,A,B,B,B (je 3).
   * Wird aufgerufen bei: setGameMode, addPlayer, spawnBots, removePlayer.
   */
  private assignTeams(): void {
    const size = TEAM_SIZE[this.gameMode];
    if (size === 0) {
      for (const p of this.players) p.team = undefined;
      return;
    }
    const teamIds: TeamId[] = ["A", "B", "C"];
    let teamIdx = 0;
    let inTeam = 0;
    for (const p of this.players) {
      if (inTeam >= size) {
        teamIdx++;
        inTeam = 0;
        if (teamIdx >= teamIds.length) {
          // Mehr als 3 Teams unmöglich (MAX_PLAYERS=6, size>=2). Abbruch.
          p.team = undefined;
          continue;
        }
      }
      p.team = teamIds[teamIdx];
      inTeam++;
    }
  }

  /**
   * Nacht 18: Spielmodus wechseln (nur Lobby-Leader).
   * Setzt gameMode, weist Teams neu zu und broadcastet den Raum-Zustand.
   * Läuft das Spiel noch (mind. 2 aktiv), wird die Runde NICHT resetet —
   * Moduswechsel wirkt ab dem nächsten Ausscheidungs-Event.
   */
  setGameMode(socket: Socket, mode: TeamMode): void {
    if (mode !== "solo" && mode !== "team2" && mode !== "team3") {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Unbekannter Modus." });
      return;
    }
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann den Modus ändern." });
      return;
    }
    if (this.gameMode === mode) return;
    this.gameMode = mode;
    this.assignTeams();
    this.broadcastRoomState();
    const label =
      mode === "solo" ? "Solo" :
      mode === "team2" ? "2er-Teams" : "3er-Teams";
    const teamCount = this.gameMode === "solo" ? 0 : Math.ceil(this.players.length / TEAM_SIZE[mode]);
    this.logChat("system", `🎮 Modus: ${label} (${teamCount} Team(s)).`);
    // Kurze Team-Übersicht ins Log, damit der Raum weiß, wer wo ist.
    if (mode !== "solo") {
      const roster = this.players
        .map((p) => `${p.name}→${p.team}`)
        .join(", ");
      this.logChat("system", `Teams: ${roster}`);
    }
  }

  /**
   * NACHT 20 (Tempo-Modus): "CLASSIC" (Level-basiert) oder "TETRIFAST"
   * (sofortiger Fall). NUR der Lobby-Leader darf es ändern. Wirkt für ALLE
   * Spieler ab dem nächsten GameLoop-Tick (dropInterval wird pro Tick gesetzt,
   * s. GameLoop.step — kein Reset nötig).
   */
  setSpeedMode(socket: Socket, mode: GameMode): void {
    if (mode !== "CLASSIC" && mode !== "TETRIFAST") {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Unbekannter Tempo-Modus." });
      return;
    }
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann das Tempo ändern." });
      return;
    }
    if (this.speedMode === mode) return;
    this.speedMode = mode;
    this.broadcastRoomState();
    this.logChat("system", `⚡ Tempo: ${mode === "TETRIFAST" ? "TETRIFAST (sofortiger Fall)" : "CLASSIC (Level-basiert)"}.`);
  }

  hasExactlyOneActive(): boolean {
    const active = this.players.filter((p) => p.status === "active");
    return active.length === 1;
  }

  /**
   * Nacht 18.1 (attack-addlines.md §1+§2): Bei 2+ gleichzeitig gelöschten
   * Zeilen werden Garbage-Linien an JEDES aktive SPIELER-TEAM AUSSERHALB
   * des Angreifers-Teams verteilt.
   *
   *   Solo  → an alle aktiven Gegner (Jeder-gegen-Jeden, §2 FFA).
   *   Team2 → an alle aktiven Spieler der anderen Teams (Teammates immun, §2).
   *   Team3 → analog.
   *
   *   Matrix (§1): 2 Zeilen → 1 Garbage, 3 → 2, 4 → 4.
   *
   *   Jede Straflinie: 11 graue Blöcke + genau 1 Loch (Loch-Position
   *   zufällig JE ZEILE, §3). Der Server ist Autorität — der empfangende
   *   Client rendert das neue Grid via broadcastGrid.
   */
  private handleClearedLines(attacker: Player, cleared: number): void {
    const garbageCount = GARBAGE_LINES[cleared] ?? 0;
    if (garbageCount <= 0) return; // 1 Zeile → 0 Garbage

    const attackerTeam = attacker.team;
    // Ziele: alle AKTIVEN Spieler, NICHT der Angreifer, und NICHT
    // Teammates (attack-addlines.md §2).
    const targets = this.players.filter((p) => {
      if (p.id === attacker.id) return false;
      if (p.status !== "active") return false;
      if (attackerTeam && p.team === attackerTeam) return false; // Teammate immun
      return true;
    });
    if (targets.length === 0) return;

    for (const t of targets) {
      addGarbageLines(t.grid, garbageCount, () => Math.random());
      // Nach Garbage: aktives Stück kann kollidieren → sofort feststellen
      t.settleIfColliding();
      this.broadcastGrid(t);
      this.io.to(t.id).emit("lines_attack", {
        count: garbageCount,
        attackerId: attacker.id,
        attackerName: attacker.name,
        cleared,
      });
    }

    // Eventlog: Angriff + Empfänger (für den Angreifer sichtbar).
    const names = targets.map((t) => t.name).join(", ");
    this.logChat("system", `${attacker.name} trifft ${cleared}×! → ${names} (+${garbageCount} Zeile(n))`);
  }

  /**
   * Night 19 (mainmenu.md §2.1): Leader startet den Ready-Check.
   * Voraussetzungen: Raum im LOBBY/POST_GAME, mindestens 2 Spieler,
   * alle Spieler ohne aktive AFK-Penalty (mainmenu.md §2.1 Sanktion).
   * Bots readyen automatisch (sonst könnte ein Raum mit Bots nie starten).
   * 
   * Bei Erfolg: Broadcast READY_CHECK_INIT mit `endsAt` (Date.now()+15000)
   * → Clients zeigen das 15s-Overlay. Nach Ablauf: alle unreaktiven Spieler
   * = AFK → penaltyEndsAt = now + 60000 + Broadcast READY_CHECK_ABORTED
   * (reason=TIMEOUT_AFK, afkPlayerIds).
   */
  startReadyCheck(socket: Socket): void {
    if (this.status !== "LOBBY" && this.status !== "POST_GAME") {
      this.io.to(socket.id).emit("chat", { from: "system", text: `Nur in der Lobby (Status: ${this.status}).` });
      return;
    }
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann den Match starten." });
      return;
    }
    if (this.players.length < 2) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Mindestens 2 Spieler nötig (bist du allein)." });
      return;
    }
    const now = Date.now();
    const penalized = this.players.filter((p) => {
      const ends = this.afkPenalties.get(p.id);
      return ends && ends > now;
    });
    if (penalized.length > 0) {
      const maxEnd = Math.max(...penalized.map((p) => this.afkPenalties.get(p.id) ?? now));
      this.io.to(socket.id).emit("chat", {
        from: "system",
        text: `AFK-Sperre aktiv für: ${penalized.map((p) => p.name).join(", ")} (${Math.ceil((maxEnd - now) / 1000)} s verbleibend).`,
      });
      return;
    }

    // Alle Bots + AI-Agenten sofort ready (sie können nicht klicken) — blockieren nie.
    // NACHT 19: Der Leader hat „Match starten\" geklickt → er ist implizit bereit.
    (this.players.find((p) => p.id === socket.id) as any).__ready = true;

    // NACHT 19.2: Der 15s-Timer läuft IMMER (kein Sofort-Auto-Start). Sind ALLE
    // sofort bereit, signalisiert `ready_all_ready` → der „Bereit\"-Knopf wird
    // zum „Start\"-Knopf (Leader klickt explizit). Der Timeout-Fallback startet
    // ebenfalls, wenn alle bereit sind (siehe handleReadyCheckTimeout).
    const endsAt = now + READY_CHECK_MS;
    this.status = "READY_CHECK";
    this.readyCheckEndsAt = endsAt;

    const players = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      // Bots/AI = automatisch bereit; Menschen = false bis „Bereit"-Klick.
      ready: this.isAutoReady(p) || (p as any).__ready === true,
      team: p.team,
    }));
    this.io.to(this.roomId).emit("ready_check_init", { endsAt, players });

    // NACHT 19.2: ALLE direkt bereit (z. B. nur Leader + Bots/AIs)? → Signal an
    // die Clients: „Bereit\"-Knopf wird zum „Start\"-Knopf.
    this.broadcastReadyAllReadyIfDone();

    // 15s-Timeout (mainmenu.md §2.1): unreaktivierte = AFK.
    this.readyCheckTimer = setTimeout(() => {
      this.readyCheckTimer = null;
      this.handleReadyCheckTimeout();
    }, READY_CHECK_MS);

    this.logChat("system", `🎯 Ready-Check gestartet (${Math.round(READY_CHECK_MS / 1000)} s).`);
    this.broadcastRoomStatus();
  }

  /**
   * Night 19: Player reagiert auf den Ready-Check (true = „Bereit", false = Abbruch).
   * - confirmed=true: Update + Broadcast. Wenn ALLE ready → Spiel startet.
   * - confirmed=false: Sofortiger Abbruch (reason=PLAYER_DECLINED).
   * Außerhalb des READY_CHECK-Status: ignorieren (Guard).
   */
  playerReady(socket: Socket, confirmed: boolean): void {
    if (this.status !== "READY_CHECK") return;
    const player = this.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (!confirmed) {
      this.abortReadyCheck("PLAYER_DECLINED", []);
      this.logChat("system", `⛔ ${player.name} hat den Ready-Check abgelehrt.`);
      return;
    }

    (player as any).__ready = true;
    this.io.to(this.roomId).emit("player_ready_update", {
      playerId: player.id,
      playerName: player.name,
      isReady: true,
    });

    // NACHT 19.2: Spiel startet NICHT automatisch — sind jetzt ALLE bereit,
    // signalisieren wir `ready_all_ready` (Client: „Bereit\" → „Start\"-Knopf).
    this.broadcastReadyAllReadyIfDone();
  }

  /**
   * NACHT 19.2: Signal an alle Clients, wenn alle relevanten Spieler bereit sind
   * (Menschen ready + Bots/AI-Agenten zählen immer). Client-UI: Der „Bereit\"-Knopf
   * des Leaders wird zum „Start\"-Knopf; der Start bleibt eine EXPLIZITE Aktion.
   */
  private broadcastReadyAllReadyIfDone(): void {
    if (this.status !== "READY_CHECK") return;
    const pending = this.players.filter((p) => !(p as any).__ready && !this.isAutoReady(p));
    if (pending.length === 0) {
      this.io.to(this.roomId).emit("ready_all_ready");
    }
  }

  /**
   * NACHT 19.2: Leader bestätigt den Start (Klick auf den „Start\"-Knopf).
   * Voraussetzung: READY_CHECK + ALLE relevanten Spieler bereit.
   */
  confirmStart(socket: Socket): void {
    if (this.status !== "READY_CHECK") {
      this.io.to(socket.id).emit("chat", { from: "system", text: `Nur während des Ready-Checks (Status: ${this.status}).` });
      return;
    }
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann das Match starten." });
      return;
    }
    const pending = this.players.filter((p) => !(p as any).__ready && !this.isAutoReady(p));
    if (pending.length > 0) {
      const names = pending.map((p) => p.name).join(", ");
      this.io.to(socket.id).emit("chat", { from: "system", text: `Noch nicht alle bereit: ${names}.` });
      return;
    }
    this.startGameFromReadyCheck();
  }

  /** Leader kann den Ready-Check jederzeit abbrechen (z. B. Team-Größe prüfen). */
  cancelReadyCheck(socket: Socket): void {
    if (this.status !== "READY_CHECK") return;
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Leader kann den Ready-Check abbrechen." });
      return;
    }
    this.abortReadyCheck("LEADER_CANCEL", []);
    this.logChat("system", `↩️ Leader hat den Ready-Check abgebrochen.`);
  }

  /**
   * Night 19: 15s-Timeout abgelaufen — Spieler ohne Reaktion = AFK.
   * Sanktion (mainmenu.md §2.1): `penaltyEndsAt = Date.now() + 60000`.
   * AFK-Spieler können in dieser Zeit nicht neu beitreten.
   */
  private handleReadyCheckTimeout(): void {
    if (this.status !== "READY_CHECK") return; // wurde z. B. schon abgebrochen
    const now = Date.now();
    // Unreaktivierte MENSCHE = AFK (Bots/AI-Agenten zählen immer als bereit).
    const afkIds = this.players
      .filter((p) => !(p as any).__ready && !this.isAutoReady(p))
      .map((p) => p.id);

    // NACHT 19.1 (BUG-FIX, mainmenu.md §2.1): ALLE relevanten Spieler sind
    // bereit (kein AFK) → Spiel startet SOFORT. Vorher wurde hier IMMER
    // abgebrochen — in Räumen mit nur Leader + Bots/AIs war danach ALLE bereit,
    // aber niemand triggerte `playerReady` → das Spiel startete nie.
    if (afkIds.length === 0) {
      this.startGameFromReadyCheck();
      return;
    }

    for (const id of afkIds) {
      this.afkPenalties.set(id, now + AFK_PENALTY_MS);
    }
    this.abortReadyCheck("TIMEOUT_AFK", afkIds);
    const names = this.players.filter((p) => afkIds.includes(p.id)).map((p) => p.name).join(", ");
    this.logChat("system", `⏱ AFK-Timeout — ${names} wurden als AFK deklariert (${Math.round(AFK_PENALTY_MS / 1000)} s Sperre).`);
  }

  /**
   * Night 19: Interne Abbruch-Logik. Setzt Status zurück auf LOBBY,
   * sendet S2C_READY_CHECK_ABORTED (reason + afkPlayerIds) und räumt
   * den Timer auf. Wird aufgerufen bei PLAYER_DECLINED, TIMEOUT_AFK,
   * LEADER_CANCEL.
   */
  private abortReadyCheck(reason: ReadyAbortReason, afkPlayerIds: string[]): void {
    if (this.readyCheckTimer) {
      clearTimeout(this.readyCheckTimer);
      this.readyCheckTimer = null;
    }
    this.readyCheckEndsAt = null;
    this.status = "LOBBY";
    this.io.to(this.roomId).emit("ready_check_aborted", { reason, afkPlayerIds });
    // Reset der Ready-Flags für alle (nächster Versuch startet frisch).
    for (const p of this.players) (p as any).__ready = false;
    this.broadcastRoomStatus();
  }

  /**
   * Night 19: Alle bereit → Spiel startet. Status = INGAME, alle Grids
   * zurückgesetzt, neuer Seed, broadcast. (Wie `requestRematch`, aber vom
   * Ready-Check-Pfad — kein Requester nötig.)
   */
  private startGameFromReadyCheck(): void {
    this.readyCheckTimer = null;
    this.readyCheckEndsAt = null;
    this.status = "INGAME";
    this.lastSeed = (Math.random() * 0xffffffff) >>> 0;

    // Alle Grids/Inventar zurücksetzen (frische Runde).
    for (const p of this.players) {
      (p as any).__ready = false;
      p.reset();
    }
    this.resetBots();

    this.io.to(this.roomId).emit("game_start", { seed: this.lastSeed });
    for (const p of this.players) {
      this.io.to(this.roomId).emit("player_status", { playerId: p.id, status: p.status });
      this.broadcastGrid(p);
      this.broadcastSpecials(p);
    }
    this.logChat("system", `🚀 Match gestartet!`);
    this.broadcastRoomStatus();
  }

  /**
   * Night 19 (mainmenu.md §3): Team-Umbenennung.
   *  - Spieler muss Teil des eigenen Teams sein (Sonst: Ablehnen).
   *  - Sanitization: trim + max 24 Zeichen + Unicode-Filter (keine Steuerzeichen).
   *  - Realtime-Sync: Client debounced (300ms), Server autoritativ.
   *  - Broadcast: room_state (alle sehen den neuen Namen sofort).
   */
  /**
   * NACHT 19.8 (Team-Leader-Regel): Team-Leader = der ERSTE ECHTE SPIELER,
   * der das Team gejoint hat (Beitrittsreihenfolge in `this.players`).
   * Bots zählen nur, wenn das Team ausschließlich aus Bots besteht → dann ist
   * der erste Bot im Beitrittsraster der Leader. Alleiniger
   * Umbenennungs-Berechtigter pro Team.
   */
  teamLeaderId(teamId: TeamId): string | undefined {
    const members = this.players.filter((p) => p.team === teamId);
    const firstHuman = members.find((p) => !this.bots.has(p.id));
    if (firstHuman) return firstHuman.id;
    // Bot-only-Team → erster Bot (Beitrittsreihenfolge)
    return members[0]?.id;
  }

  editTeamName(socket: Socket, teamId: TeamId, newName: string): void {
    if (teamId !== "A" && teamId !== "B" && teamId !== "C") return;
    const player = this.players.find((p) => p.id === socket.id);
    if (!player) return;
    // NACHT 19.7 (Team-Leader-Regel): NUR der Team-Leader (erster Joinder)
    // darf den Team-Namen ändern — nicht mehr jedes Mitglied.
    if (player.team !== teamId) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur Team-Mitglieder dürfen den Team-Namen ändern." });
      return;
    }
    const leaderId = this.teamLeaderId(teamId);
    if (leaderId !== socket.id) {
      const leaderName = this.players.find((p) => p.id === leaderId)?.name ?? "?";
      this.io.to(socket.id).emit("chat", { from: "system", text: `Nur der Team-Leader (${leaderName}) darf den Namen ändern.` });
      return;
    }
    // Sanitization (mainmenu.md §3): trim + max 24 Zeichen + keine Steuerzeichen.
    const clean = (newName ?? "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "") // Steuerzeichen
      .slice(0, TEAM_NAME_MAX_LEN)
      .trim();
    if (!clean) {
      this.io.to(socket.id).emit("chat", { from: "system", text: `Team-Name zu kurz (mind. 1 Zeichen, max. ${TEAM_NAME_MAX_LEN}).` });
      return;
    }
    this.teamNames[teamId] = clean;
    this.io.to(this.roomId).emit("team_name_updated", { teamId, name: clean });
    this.logChat("system", `🏷 Team ${teamId} heißt jetzt „${clean}".`);
    this.broadcastRoomState();
  }

  /** Night 19: Status an alle Clients senden (public für GameLoop). */
  public broadcastRoomStatus(): void {
    this.io.to(this.roomId).emit("room_status", { status: this.status });
  }

  /**
   * Night 19: Bots UND AI-Agenten („AI-*" via /ai/*) sind im Ready-Check
   * immer automatisch bereit — sie klicken nicht und dürfen nie AFK-gebannt
   * werden (AI-Training nutzt denselben Raum und läuft in rematch-Loops).
   */
  private isAutoReady(p: Player): boolean {
    return this.bots.has(p.id) || p.name.startsWith("AI-");
  }

  /**
   * Night 19: Ist ein Socket wegen AFK-Penalty gesperrt? (mainmenu.md §2.1)
   */
  isPenalized(socketId: string): boolean {
    const ends = this.afkPenalties.get(socketId);
    return !!ends && ends > Date.now();
  }

  /**
   * Night 19: Team-Display-Name (custom oder Standard). Für Client-UI.
   */
  getTeamDisplayName(teamId: TeamId): string {
    return this.teamNames[teamId] ?? TEAMS[teamId]?.label ?? `Team ${teamId}`;
  }

  /* ---------------------------------------------------------------- */
  /* Eingaben & Specials                                               */
  /* ---------------------------------------------------------------- */

  /**
   * NIGHT 17.10: ZENTRALER Special-Ziel-Guard (Game-Regel, game.md §2).
   * Ein Special darf NUR auf ein AKTIVES Zielfeld wirken — mit Ausnahme
   * des eigenen Felds (POS-Specials wie Nuke auf sich selbst).
   *
   * Verworfen → `false`: das Special bleibt im Inventory (wird NICHT
   * verbraucht), es gibt ein System-Log. Wird von ALLEN Pfade genutzt:
   * `handleUseSpecial` (Menschen/AI-Agenten via Socket) UND
   * `fireBotSpecial` (Bot-Loop) — keine Pfad-duplizierte Logik mehr.
   * @returns true = Ziel ist legal, Weiterarbeiten (Abzug + Apply).
   */
  private resolveSpecialTarget(
    attackerName: string,
    target: Player,
    specialType: SpecialType,
    isOwnField: boolean,
  ): boolean {
    if (!isOwnField && target.status !== "active") {
      console.warn(`[Room] ${attackerName}: Special "${specialType}" auf ausgeschiedenen ${target.name} → verworfen.`);
      this.logChat("system", `Special "${specialType}" verworfen — ${target.name} ist nicht mehr aktiv.`);
      return false;
    }
    return true;
  }

  handleAction(socket: Socket, action: string): void {
    const player = this.players.find((p) => p.id === socket.id);
    if (!player) return;
    // NACHT 19.4 (Game-Regel): Außerhalb INGAME (Lobby/Ready-Check/Post-Game)
    // werden KEINE Spieleingaben mehr angenommen — Stücke können nicht mehr
    // bewegt/gedreht/droppt werden. (AI-Rematch setzt vorher wieder INGAME.)
    if (this.status !== "INGAME") return;
    if (player.status !== "active") return; // ausgeschieden (Spectator/Winner)
    // Snapshot vor der Aktion (damit wir erkennen, ob sich das Inventory geändert hat)
    const invBefore = player.specialsInventory.length;
    player.handleAction(action as never);
    // Sofortiges Feedback an den eigenen Client (Prediction-Refine)
    this.broadcastGrid(player);
    // Nacht 15: Wenn sich das Inventory geändert hat (Specials nach Zeilen-Clear
    // in afterLock eingesammelt), muss der Client das auch erfahren!
    if (player.specialsInventory.length !== invBefore) {
      this.broadcastSpecials(player);
    }
  }

  handleUseSpecial(socket: Socket, targetIndex: number, specialType: SpecialType): void {
    const attacker = this.players.find((p) => p.id === socket.id);
    if (!attacker) return;
    // NACHT 19.4: Specials nur während eines laufenden Spiels (INGAME).
    if (this.status !== "INGAME") return;

    // Ziel in der KUNDEN-ANSICHT auflösen: Index 0 = eigener Spieler (sortWithSelfFirst),
    // da der Client seine sortierte room_state-Liste als Index nutzt.
    const ref = sortWithSelfFirst(this.players, attacker.id)[targetIndex];
    const target = ref ? this.players.find((p) => p.id === ref.id) : undefined;
    if (!target) return;

    // 0. NIGHT 17.2/17.10 (Game-Regel aus game.md §2): ZENTRALER Guard —
    //    Specials wirken NUR auf AKTIVE Ziele; eigenes Feld immer erlaubt.
    //    Verworfen → Special bleibt im Inventory.
    if (!this.resolveSpecialTarget(attacker.name, target, specialType, target.id === attacker.id)) return;

    // 1. NACHT 19.7 (inventory-addon.md §1.1/§2.2, Anti-Cheat): STRIKTES FIFO —
    //    es ist IMMER nur das Special an Index 0 (das älteste) auslösbar.
    //    Abweichung = verworfen (stillschweigend), Special bleibt in der Queue.
    if (attacker.specialsInventory.length === 0 || attacker.specialsInventory[0] !== specialType) {
      console.warn(`[Room] ${attacker.name}: Special ${specialType} verworfen — Front ist "${attacker.specialsInventory[0] ?? "∅"}" (FIFO).`);
      return;
    }
    // 2. Abziehen (Front der Queue rückt nach, §1.1)
    attacker.specialsInventory.shift();
    this.broadcastSpecials(attacker);

    // 3. Logik (Shared, Server-Authoritative)
    if (specialType === "S") {
      // Switch Fields: eigenes Feld ↔ Zielfeld tauschen (game.md §2, Special 8)
      swapGridContents(attacker.grid, target.grid);
      // Beide Spieler: aktives Stück kann jetzt kollidieren → ggf. feststellen
      target.settleIfColliding();
      attacker.settleIfColliding();
      // Beide Grids broadcasten
      this.broadcastGrid(attacker);
    } else {
      applySpecialToGrid(target.grid, specialType);
      // Aktives Stück kann jetzt kollidieren (z.B. Add Line) -> ggf. feststellen
      target.settleIfColliding();
    }

    // 4. Broadcast (Zielfeld immer; Angreifer nur bei S)
    this.broadcastGrid(target);
    this.io.to(this.roomId).emit("special_triggered", {
      byPlayerId: attacker.id,
      targetPlayerId: target.id,
      type: specialType,
      updatedTargetGrid: target.grid,
      // Switch Fields: auch das Angreifer-Feld hat sich geändert.
      ...(specialType === "S" ? { updatedAttackerGrid: attacker.grid } : {}),
    });
    this.logChat(attacker.id, `${attacker.name} zündet "${specialType}" auf ${target.name}.`);
  }

  handleChat(socket: Socket, text: string): void {
    const player = this.players.find((p) => p.id === socket.id);
    if (!player) return;
    this.io.to(this.roomId).emit("chat", {
      from: player.name,
      text: text.slice(0, 200),
    });
  }

  /**
   * Rematch: nur erlaubt, wenn das Spiel beendet ist (mindestens ein
   * Spieler nicht mehr aktiv). Resetzt ALLE Spieler (Feld, Score, Specials)
   * und startet die Runde neu.
   */
  /** Eigene Spieler-ID umbenennen (Nacht 16.6): nur der Socket-Besitzer. */
  renamePlayer(socket: Socket, newName: string): void {
    const player = this.players.find((p) => p.id === socket.id);
    if (!player || player.name === newName) return;
    const oldName = player.name;
    player.name = newName;
    this.logChat("system", `${oldName} heißt jetzt ${newName}.`);
    this.broadcastRoomState();
  }

  requestRematch(socket: Socket): void {
    const requester = this.players.find((p) => p.id === socket.id);
    if (!requester) return;
    if (!this.players.some((p) => p.status !== "active")) return; // läuft noch

    // NACHT 19: Rematch = neue Runde → Status INGAME (GameLoop tickt wieder).
    this.status = "INGAME";

    for (const p of this.players) p.reset();
    this.resetBots();
    this.io.to(this.roomId).emit("rematch_started", { byPlayerId: requester.id });
    this.broadcastRoomStatus();
    this.broadcastRoomState();
    this.broadcastBots();
    for (const p of this.players) {
      // Nacht 15: Status "active" explizit senden (reset() setzt ihn synchron,
      // die GameLoop-Change-Detection würde ihn sonst nicht mehr melden).
      this.io.to(this.roomId).emit("player_status", { playerId: p.id, status: p.status });
      this.broadcastGrid(p);
      this.broadcastSpecials(p);
    }
    this.logChat("system", `Neues Spiel gestartet (${requester.name}). Viel Glück!`);
  }

  /* ---------------------------------------------------------------- */
  /* Bot-Verwaltung (Lobby-Auffüllung)                                  */
  /* ---------------------------------------------------------------- */

  /** Wie viele Spieler (Menschen + Bots) sind aktiv? */
  private get activeCount(): number {
    return this.players.length;
  }

  /**
   * `count` Bots hinzufügen (bis MAX_PLAYERS). Nur Lobby-Leader darf es.
   */
  /** Bots ohne Rechteprüfung erzeugen (intern, z. B. Dev-Autofill). */
  private spawnBots(count: number, difficulty: BotDifficulty): number {
    const want = Math.max(0, Math.min(5, count | 0));
    let added = 0;
    // NACHT 20 (Bot-Namen/-Avatare): thematisierter Namen-Pool pro Stufe.
    const names = BOT_AVATARS[difficulty].names;
    for (let i = 0; i < want && this.players.length < MAX_PLAYERS; i++) {
      const id = "bot_" + Math.random().toString(36).slice(2, 8);
      const name = names[(this.bots.size + added) % names.length];
      const seed = (Date.now() ^ (added + 1) ^ 0xabcdef) >>> 0;
      const bot = new BotAI(id, name, seed, difficulty);
      this.players.push(bot.player);
      this.bots.set(id, bot);
      // Nacht 18.1: Auch Bots schießen Garbage (attack-addlines.md).
      this.bindPlayer(bot.player);
      added++;
    }
    if (added > 0) {
      // Nacht 18: Neue Bots in die Team-Zuweisung einbauen.
      this.assignTeams();
      this.broadcastRoomState();
      this.broadcastBots();
    }
    return added;
  }

  /**
   * `count` Bots hinzufügen (bis MAX_PLAYERS). Nur Lobby-Leader darf es.
   */
  addBots(socket: Socket, count: number, difficulty: BotDifficulty): void {
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann Bots hinzufügen." });
      return;
    }
    const added = this.spawnBots(count, difficulty);
    if (added > 0) {
      this.logChat("system", `🤖 ${added} Bot(s) hinzugefügt (${BOT_PRESETS[difficulty].label}).`);
      this.notifyPlayerCountChange(); // NACHT 20: Lobby-Browser auffrischen.
    }
  }

  /** Alle Bots entfernen. */
  removeBots(socket: Socket): void {
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann Bots entfernen." });
      return;
    }
    const ids = [...this.bots.keys()];
    for (const id of ids) {
      const idx = this.players.findIndex((p) => p.id === id);
      if (idx !== -1) this.players.splice(idx, 1);
      this.bots.delete(id);
    }
    if (ids.length > 0) {
      // Nacht 18: Ohne die Bots neu aufteilen.
      this.assignTeams();
      this.broadcastRoomState();
      this.broadcastBots();
      this.logChat("system", `🤖 ${ids.length} Bot(s) entfernt.`);
      this.notifyPlayerCountChange(); // NACHT 20: Lobby-Browser auffrischen.
    }
  }

  /** Schwierigkeitsstufe aller Bots ändern. */
  setBotDifficulty(socket: Socket, difficulty: BotDifficulty): void {
    if (!this.isLeader(socket)) {
      this.io.to(socket.id).emit("chat", { from: "system", text: "Nur der Lobby-Leader kann die Stufe ändern." });
      return;
    }
    for (const bot of this.bots.values()) bot.setDifficulty(difficulty);
    this.defaultDifficulty = difficulty;
    this.broadcastBots();
    this.logChat("system", `🤖 Bot-Stufe: ${BOT_PRESETS[difficulty].label}`);
  }

  /**
   * Ermittelt die Lobby-Leader-ID:
   *  1. MENSCHLICHE Spieler (Bots + "AI-*"-Agenten ausgeschlossen).
   *  2. VORRANG: der Spieler mit dem konfigurierten Namen (LOBBY_LEADER_NAME,
   *     DEV: "energetic", via TETRIS_LEADER änderbar) — Nacht 17.1.
   *  3. Fallback: der erste menschliche Spieler im Raum.
   */
  pickLeaderId(): string | undefined {
    const humans = this.players.filter((p) => !this.bots.has(p.id) && !p.name.startsWith("AI-"));
    if (humans.length === 0) return undefined;
    if (LOBBY_LEADER_NAME) {
      const preferred = humans.find((p) => p.name === LOBBY_LEADER_NAME);
      if (preferred) return preferred.id;
    }
    return humans[0].id;
  }

  /** Ist das aufrufende Socket der Lobby-Leader? */
  isLeader(socket: Socket): boolean {
    return this.pickLeaderId() === socket.id;
  }

  /** Bot-Status (Anzahl + Stufe + Ids) an den Raum senden. */
  private broadcastBots(): void {
    const botIds = [...this.bots.keys()];
    // NACHT 19.3 (BUG-FIX): Bei 0 aktiven Bots senden wir die Raum-Einstellung
    // (`defaultDifficulty`) statt null — sonst fällt die Client-UI (Panel-Dropdown)
    // auf den Server-Default (ultra_nightmare) zurück, obwohl der Leader eine
    // andere Stufe gewählt hatte.
    const difficulty = botIds.length ? this.bots.get(botIds[0])!.difficulty : this.defaultDifficulty;
    this.io.to(this.roomId).emit("bots_updated", {
      botCount: botIds.length,
      difficulty,
      botIds,
    });
  }

  /**
   * Von der Game-Loop aufgerufen: alle Bots einen Tick weiterlaufen lassen.
   */
  updateBots(elapsedMs: number): void {
    if (this.bots.size === 0) return;
    for (const bot of this.bots.values()) {
      if (bot.player.status !== "active") continue;
      const ctx = {
        // NIGHT 17.9: NUR AKTIVE Spieler als Ziele — ausgeschiedene
        // (spectator/winner) dürfen die Bots nicht mehr anfeuern
        // (Game-Regel, identisch zu handleUseSpecial seit 17.2).
        opponents: this.players
          .filter((p) => p.id !== bot.id && p.status === "active")
          .map((p) => ({ id: p.id, name: p.name, height: gridHeight(p.grid) })),
        fireSpecial: (targetId: string, type: SpecialType) => {
          this.fireBotSpecial(bot, targetId, type);
        },
      };
      bot.update(elapsedMs, ctx);
    }
  }

  /** Bot feuert ein Special auf ein Ziel (validiert + broadcast). */
  private fireBotSpecial(bot: BotAI, targetId: string, type: SpecialType): void {
    const inv = bot.player.specialsInventory;
    const idx = inv.indexOf(type);
    if (idx === -1) return;
    const target = this.players.find((p) => p.id === targetId);
    if (!target) return;

    // NIGHT 17.9/17.10: ZENTRALER Guard (wie Menschen-Pfad) — Specials wirken
    // NUR auf AKTIVE Ziele. Verworfen → Special bleibt im Bot-Inventory,
    // kein Grid-Write, kein Broadcast. (Bot kann nicht auf sich selbst feuern,
    // daher isOwnField=false.)
    if (!this.resolveSpecialTarget(bot.name, target, type, false)) return;

    inv.splice(idx, 1);
    this.broadcastSpecials(bot.player);
    applySpecialToGrid(target.grid, type);
    target.settleIfColliding();
    this.broadcastGrid(target);
    this.io.to(this.roomId).emit("special_triggered", {
      byPlayerId: bot.id,
      targetPlayerId: target.id,
      type,
      updatedTargetGrid: target.grid,
    });
    this.logChat("system", `${bot.name} zündet "${type}" auf ${target.name}.`);
  }

  /** Bot-Anteil bei Rematch zurücksetzen. */
  resetBots(): void {
    for (const bot of this.bots.values()) bot.reset();
  }

  /* ---------------------------------------------------------------- */
  /* Broadcast-Helfer                                                  */
  /* ---------------------------------------------------------------- */

  /** Spielerliste senden, wobei der lokale Spieler immer Index 0 ist. */
  private broadcastRoomState(): void {
    const all: PlayerRef[] = this.players.map((p) => {
      const bot = this.bots.get(p.id);
      return {
        id: p.id,
        name: p.name,
        score: p.score,
        isBot: !!bot,
        botDifficulty: bot?.difficulty ?? undefined,
        // Nacht 17.2: Status mitliefern → Client rendert Ausschiedene sofort grau.
        status: p.status,
        // Nacht 18: Team-Kennung (nur im Team-Modus).
        team: p.team,
      };
    });

    // An jeden Spieler eine individualisierte, sortierte Liste schicken
    for (const p of this.players) {
      if (this.bots.has(p.id)) continue; // Bots bekommen kein room_state
      const sorted = sortWithSelfFirst(all, p.id);
      // Leader = konfiguierter Spieler (energetic) oder erster Mensch (Nacht 17.1)
      const leaderId = this.pickLeaderId();
      // NACHT 19.8: Team-Leader pro Team = erster ECHTER Spieler; bei
      // Bot-only-Teams = erster Bot (Beitrittsreihenfolge) — see teamLeaderId().
      const teamLeaders: Partial<Record<TeamId, string>> = {};
      for (const tid of ["A", "B", "C"] as TeamId[]) {
        const leaderId = this.teamLeaderId(tid);
        if (leaderId) teamLeaders[tid] = leaderId;
      }
      this.io.to(p.id).emit("room_state", {
        players: sorted,
        selfIndex: 0,
        isLeader: leaderId === p.id,
        // NACHT 20 (Matchmaking-Hub): Raum-ID + Anzeigename für Topbar/Lobby-Return.
        roomId: this.roomId,
        roomName: this.name,
        // Nacht 18: Aktueller Modus (undefined = Solo).
        gameMode: this.gameMode === "solo" ? undefined : this.gameMode,
        // NACHT 20: Tempo-Modus (CLASSIC/TETRIFAST) für ALLE Spieler.
        speedMode: this.speedMode,
        // NACHT 19: Raum-Status + Teamnamen (Custom oder Standard).
        roomStatus: this.status,
        teamNames: this.teamNames,
        // NACHT 19.7: Team-Leader (erster Joiner) — UI zeigt ✎ nur dort.
        teamLeaders,
      });
    }
  }

  /** Grid + aktives Stück + Queue + Score eines Spielers an den Raum senden. */
  broadcastGrid(player: Player): void {
    this.io.to(this.roomId).emit("grid_update", {
      playerId: player.id,
      grid: player.grid,
      activePiece: player.activePiece,
      queue: player.queue.slice(0, 5),
      score: player.score,
      // NACHT 19.11: Aktuelles Raum-Level (Ø Spieler-Level) → Client-HUD.
      level: activeLevel(this.players.map((p) => p.level)),
    });
  }

  /** Specials-Inventory eines Spielers senden (an alle im Raum). */
  public broadcastSpecials(player: Player): void {
    this.io.to(this.roomId).emit("specials_update", {
      playerId: player.id,
      inventory: player.specialsInventory,
    });
  }

  private logChat(from: string, text: string): void {
    this.io.to(this.roomId).emit("chat", { from, text });
  }
}

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

function sortWithSelfFirst(players: PlayerRef[], selfId: string): PlayerRef[] {
  return players.slice().sort((a, b) => {
    if (a.id === selfId) return -1;
    if (b.id === selfId) return 1;
    return 0;
  });
}

function seedFromSocket(socketId: string): number {
  let h = 2166136261;
  for (let i = 0; i < socketId.length; i++) {
    h ^= socketId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
