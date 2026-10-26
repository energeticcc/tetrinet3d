import * as THREE from "three";
import { Arena } from "./render/Arena";
import { EffectsManager } from "./render/Effects";
import { NextPiecePreview } from "./render/NextPiece";
import { InputHandler } from "./input/inputHandler";
import { TouchControls } from "./input/touchControls";
import { SocketClient } from "./network/socketClient";
import { AudioManager } from "./audio/AudioManager";
import { SPECIALS, NEGATIVE_SPECIALS, BOT_DIFFICULTIES, PLAYER_COLORS, TEAMS } from "@tetrinet3d/shared";
import {
  tryMove,
  tryRotate,
  hardDrop,
  clearLines,
  collides,
  ghostPosition,
} from "@tetrinet3d/shared";
import type {
  SpecialType,
  PlayerStatus,
  PlayerAction,
  ActivePiece,
  RoomStateMessage,
  GridUpdateMessage,
  SpecialsUpdateMessage,
  SpecialTriggeredMessage,
  PlayerStatusMessage,
  GameOverMessage,
  ChatMessageOut,
  BotDifficulty,
  BotsUpdatedMessage,
  TeamMode,
  TeamId,
  LinesAttackMessage,
  RoomStatus,
  ReadyCheckInitMessage,
  PlayerReadyUpdateMessage,
  ReadyCheckAbortedMessage,
  GameStartMessage,
} from "@tetrinet3d/shared";

/**
 * App-Einstiegspunkt: Engine (Three.js), Netzwerk & UI-Overlay.
 * (Vorlage: md/main.ts)
 */
class GameApp {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;

  private arena!: Arena;
  private effects!: EffectsManager;
  private nextPiece!: NextPiecePreview;
  private audio = new AudioManager();
  private socket!: SocketClient;
  private input!: InputHandler;
  private touch: TouchControls | null = null;
  private prevInventoryLen = 0;
  /** Rematch-Button (referenziert, damit R-Taste funktioniert). */
  private rematchButton: HTMLButtonElement | null = null;

  private clock = new THREE.Clock();

  /** Lokale Spielernummer (Socket-ID). */
  private localPlayerId = "";
  /** Room-Liste (Index 0 = lokal). */
  private roomList: string[] = [];
  /** Namen + Score pro Spieler-ID (für das Live-Leaderboard). */
  private playerInfo = new Map<string, { name: string; score: number }>();
  /** Eignes FIFO-Specials-Inventory (Index 0 = aktiv). */
  private myInventory: SpecialType[] = [];
  /**
   * NACHT 19.6 (ghostpiece-addon.md §4): Schattenstein an/aus (Barrierefreiheit,
   * „Puristen-Modus"). Standard AN; persistiert in localStorage; KeyG toggle.
   */
  private ghostEnabled: boolean = (localStorage.getItem("tetrinet3d_ghost") ?? "1") === "1";

  /** Lokale Kopie des eigenen Spiels (Client-Side Prediction, game.md §3.1). */
  private myGrid: number[][] = [];
  private myPiece: ActivePiece | null = null;
  /** Nächste Stücke (Queue, Tetromino-Codes) — für die Vorschau. */
  private myQueue: number[] = [];
  /** true, wenn der lokale Spieler Spectator ist (Eingaben ignorieren). */
  private isSpectator = false;

  /**
   * Interpolation der Gegner-Blöcke (game.md §3.3):
   * pro Spieler: vorherige + aktuelle Stück-Position + Zeitpunkt des
   * Server-Updates (20Hz). Die Render-Schleife lerpt dazwischen (60fps).
   */
  private oppInterp = new Map<string, { prev: ActivePiece | null; cur: ActivePiece | null; t: number }>();

  /** Status der Spieler (für Spectator-Rendering). */
  private playerStatus = new Map<string, PlayerStatus>();
  /** Set mit Bot-Ids (für Leaderboard-Markierung + Bot-Panel). */
  private botIds = new Set<string>();
  /** Bot-Stufe (aus bots_updated). */
  private botDifficulty: BotDifficulty | null = null;
  /** Ist der lokale Spieler Lobby-Leader (darf Bots verwalten)? */
  private amLeader = false;
  /** Bot-Panel-Referenz (nur bei Leader sichtbar). */
  private botPanel: HTMLDivElement | null = null;

  /** Nacht 18: Team-Kennung pro Spieler-ID (undefined = Solo). */
  private playerTeam = new Map<string, TeamId | undefined>();
  /** Nacht 18: Aktueller Spielmodus (aus room_state). */
  private teamMode: TeamMode = "solo";
  /** Nacht 18: Team-Panel-Referenz (nur bei Leader sichtbar). */
  private teamPanel: HTMLDivElement | null = null;

  /* --- Nacht 19 (mainmenu.md §2/§3): Ready-Check, Status, Teamnamen --- */
  /** Raum-Status (LOBBY/READY_CHECK/INGAME/POST_GAME). */
  private roomStatus: RoomStatus = "INGAME";
  /** Custom-Teamnamen (je TeamId). */
  private teamNames: Partial<Record<TeamId, string>> = {};
  /** NACHT 19.7 (Team-Leader-Regel): Team-Leader pro Team = erster Joiner.
   *  UI zeigt ✎ nur für das Team, dessen Leader der lokale Spieler ist. */
  private teamLeaders: Partial<Record<TeamId, string>> = {};
  /** Ready-Check-Overlay-Referenz. */
  private readyOverlay: HTMLDivElement | null = null;
  /** Countdown-Element im Overlay. */
  private readyCountdownEl: HTMLSpanElement | null = null;
  /** readyState pro Spieler (aus ready_check_init / player_ready_update). */
  private readyState = new Map<string, boolean>();
  /** Ende-Zeitpunkt des Ready-Check (Date.now()+15000) für den Countdown. */
  private readyCheckEndsAt: number | null = null;
  /** rAF-Handle für den Ready-Countdown. */
  private readyRaf: number | null = null;

  constructor() {
    this.initThreeJS();
    this.initNetwork();
    this.initUI();
    this.initResizeListener();
    this.animate();
  }

  /* ---------------------------------------------------------------- */
  /* Three.js                                                          */
  /* ---------------------------------------------------------------- */
  private initThreeJS(): void {
    const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;

    this.scene = new THREE.Scene();
    // Nacht 17.5: dezentes Hintergrundbild (tetrinet_3d_arena_background.png).
    // Fallback-Farbe bleibt, bis die Textur geladen ist.
    this.scene.background = new THREE.Color(0x050505);
    const bgTex = new THREE.TextureLoader().load("/tetrinet_3d_arena_background.png");
    bgTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = bgTex;
    // Dezent: Bild wird gedimmt (three r152+: scene.backgroundIntensity).
    (this.scene as any).backgroundIntensity = 0.55;
    // Nebel-Farbe an das (dunkelblaue) Bild annähern, damit die Felder
    // weich in den Hintergrund übergehen statt in ein reines Schwarz.
    this.scene.fog = new THREE.FogExp2(0x0a0f16, 0.02);

    // 2.5D/3D-Perspektive ist KERN-SPEZIFIKATION des Spiels (Nacht 17.4:
    // Ortho-Experiment reverted). Die Perspektive wird über
    // Arena.applyCameraFraming() auf die freie Panel-Fläche angepasst.
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.set(0, 2, 5);
    this.camera.lookAt(0, 0, -4);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);

    this.arena = new Arena(this.scene, this.camera);
    this.effects = new EffectsManager(this.scene, this.arena);

    // Nächste Steine (Queue): ÜBER dem Hauptfeld, als HORIZONTALE REIHE (Nacht 11)
    this.nextPiece = new NextPiecePreview();
    this.nextPiece.group.position.set(Arena.MAIN_X, Arena.NEXT_Y, -11);
    this.nextPiece.group.scale.setScalar(0.55);
    this.scene.add(this.nextPiece.group);
    // dezente Punktquelle, damit die Vorschau glänzt
    const glow = new THREE.PointLight(0xffffff, 0.6, 20);
    glow.position.set(Arena.MAIN_X, Arena.NEXT_Y + 2, -9);
    this.scene.add(glow);
  }

  /* ---------------------------------------------------------------- */
  /* Netzwerk                                                          */
  /* ---------------------------------------------------------------- */
  private initNetwork(): void {
    this.socket = new SocketClient();
    const s = this.socket.socket;

    s.on("connect", () => {
      this.localPlayerId = s.id ?? "";
      this.logChat("system", "Verbunden mit dem Server.");
      // Eigentlichen Namen merken (Nacht 16.6): custom Name überleben Reload/Reconnect.
      let name = "Player_" + this.localPlayerId.slice(0, 4);
      try {
        const saved = localStorage.getItem("tetrinet3d_player_name");
        if (saved && saved.trim()) name = saved.trim().slice(0, 20);
      } catch { /* egal */ }
      this.socket.joinRoom(name);
    });

    // WebAudio erst nach erster User-Gesture entsperren (Autoplay-Policy)
    const unlockAudio = () => this.audio.unlock();
    window.addEventListener("keydown", unlockAudio, { once: true });
    window.addEventListener("pointerdown", unlockAudio, { once: true });

    s.on("room_state", (data: unknown) => {
      const state = data as RoomStateMessage;
      this.roomList = state.players.map((p) => p.id);
      for (const p of state.players) {
        this.playerInfo.set(p.id, { name: p.name, score: p.score ?? 0 });
        if (p.isBot) this.botIds.add(p.id);
        // Nacht 17.2: Status aus room_state übernehmen (Ausscheidung bleibt sichtbar)
        if (p.status) this.playerStatus.set(p.id, p.status);
        // Nacht 18: Team-Zugehörigkeit (undefined = Solo)
        this.playerTeam.set(p.id, p.team);
      }
      // Bots, die nicht mehr in der Liste sind, entfernen
      for (const id of [...this.botIds]) if (!state.players.some((p) => p.id === id)) this.botIds.delete(id);
      for (const id of [...this.playerTeam.keys()]) if (!state.players.some((p) => p.id === id)) this.playerTeam.delete(id);
      this.amLeader = state.isLeader ?? false;
      // Nacht 18: Spielmodus (solo = undefined vom Server)
      this.teamMode = state.gameMode ?? "solo";
      // NACHT 19: Raum-Status + Custom-Teamnamen.
      if (state.roomStatus) this.roomStatus = state.roomStatus;
      if (state.teamNames) this.teamNames = state.teamNames;
      if (state.teamLeaders) this.teamLeaders = state.teamLeaders;
      else this.teamLeaders = {}; // Modus-Wechsel/Reset → keine Leader mehr
      // Nacht 18.1: Team-Gruppierung — Teammates des lokalen Spielers
      // in die vordere Reihe (Slots 1-2), andere Gegner dahinter (3-5).
      this.arena.setupArena(this.roomList, this.playerTeam);
      // Neue Bounding-Box → Kamera neu framingen (wichtig nach jedem Join/Rematch!).
      this.arena.applyCameraFraming(window.innerWidth, window.innerHeight);
      this.positionInventory();
      // Namens-/Score-Labels + Rahmen-Farben anwenden (Nacht 12).
      this.refreshFieldLabels();
      this.setupInput();
      this.updateBotPanel();
      this.updateTeamPanel();
      this.updateLeaderboard();
    });

    s.on("bots_updated", (data: unknown) => {
      const msg = data as BotsUpdatedMessage;
      // NACHT 19.3 (BUG-FIX): null (0 Bots im Raum) darf die Leader-Wahl NICHT
      // überschreiben — sonst springt das Dropdown auf ultra_nightmare zurück.
      if (msg.difficulty) this.botDifficulty = msg.difficulty;
      this.updateBotPanel();
    });

    s.on("grid_update", (data: unknown) => {
      const msg = data as GridUpdateMessage;
      // WICHTIG: socket.io übergibt die SELBEN Objekt-Referenzen des Servers.
      // Jede lokale Mutation (Prediction) würde das Server-Objekt mutieren!
      // -> Deep-Copy für den lokalen Zustand.
      const grid = msg.grid.map((row) => row.slice());
      const piece = msg.activePiece ? { ...msg.activePiece } : null;
      // Live-Score (Leaderboard + Feld-Label)
      if (msg.score !== undefined) {
        const info = this.playerInfo.get(msg.playerId);
        if (info) info.score = msg.score;
        this.refreshLeaderboard();
        // Nacht 17.2: fieldNo + lost mitgeben
        const idx2 = this.roomList.indexOf(msg.playerId);
        const lost2 = this.playerStatus.get(msg.playerId) === "spectator" || this.playerStatus.get(msg.playerId) === "winner";
        this.arena.updateLabel(msg.playerId, info?.name ?? "", info?.score ?? 0, idx2 + 1, lost2);
      }
      // Eigener Spieler: lokalem Predictions-Zustand überlagern (Server ist Wahrheit).
      if (msg.playerId === this.localPlayerId) {
        this.myGrid = grid;
        this.myPiece = this.isSpectator ? null : piece;
        this.myQueue = (msg.queue ?? []).slice(0, 5);
        const inst = this.arena.getGrid(msg.playerId);
        if (inst) {
          inst.update(this.myGrid, this.isSpectator);
          inst.setActivePiece(this.myPiece);
          // NACHT 19.6 (ghostpiece-addon.md): Schattenstein = lokaler Hard-Drop-Landepunkt
          inst.setGhost(this.ghostEnabled && this.myPiece ? this.myPiece : null, this.ghostEnabled && this.myPiece ? ghostPosition(this.myGrid, this.myPiece) : null);
        }
        // Nächste Steine (Vorschau im Mittelfeld)
        this.nextPiece.setQueue(this.myQueue.slice(0, NextPiecePreview.MAX_SLOTS));
        // Server-Lock erkannt: altes Stück (unten) → neues Stück (oben)?
        const prev = (this as any)._lastServerPiece as ActivePiece | null;
        (this as any)._lastServerPiece = piece;
        if (prev && piece && prev.y > 1 && (piece.type !== prev.type || piece.y <= 1)) {
          this.audio.lock();
        }
        return;
      }
      // Gegner: Interpolation vorbereiten (game.md §3.3)
      const dimmed = this.playerStatus.get(msg.playerId) === "spectator";
      this.arena.updateGrid(msg.playerId, grid, dimmed);
      const st = this.oppInterp.get(msg.playerId) ?? { prev: null, cur: null, t: 0 };
      const canLerp = !!st.cur && !!piece && st.cur.type === piece.type;
      st.prev = canLerp ? st.cur : null;
      st.cur = piece;
      st.t = performance.now();
      this.oppInterp.set(msg.playerId, st);
      if (!canLerp) {
        // Neu-Spawn / Statuswechsel: direkt finale Position rendern
        this.arena.setActivePiece(msg.playerId, piece);
      }
    });

    s.on("specials_update", (data: unknown) => {
      const msg = data as SpecialsUpdateMessage;
      if (msg.playerId === this.localPlayerId) {
        this.myInventory = msg.inventory;
        if (msg.inventory.length > this.prevInventoryLen) this.audio.specialGained();
        this.prevInventoryLen = msg.inventory.length;
        this.updateInventoryUI();
      }
    });

    s.on("special_triggered", (data: unknown) => {
      const msg = data as SpecialTriggeredMessage;
      const targetGrid = msg.updatedTargetGrid.map((row) => row.slice()); // Deep-Copy
      if (msg.targetPlayerId === this.localPlayerId) {
        // Eigens getroffen: lokalen Zustand aktualisieren (z.B. Add Line)
        this.myGrid = targetGrid;
        const inst = this.arena.getGrid(msg.targetPlayerId);
        if (inst) {
          inst.update(this.myGrid, this.isSpectator);
          inst.setGhost(this.ghostEnabled && this.myPiece ? this.myPiece : null, this.ghostEnabled && this.myPiece ? ghostPosition(this.myGrid, this.myPiece) : null); // NACHT 19.6
        }
      } else {
        this.arena.updateGrid(msg.targetPlayerId, targetGrid);
      }
      // Special "S" (Switch Fields): auch das ANGREIFER-Feld hat sich geändert.
      // Falls ICH der Angreifer bin, muss das eigene (lokale) Grid aktualisiert
      // werden — der Server schickt `updatedAttackerGrid` dafür.
      if (msg.type === "S" && msg.updatedAttackerGrid && msg.byPlayerId === this.localPlayerId) {
        const myNewGrid = msg.updatedAttackerGrid.map((row) => row.slice());
        this.myGrid = myNewGrid;
        const inst = this.arena.getGrid(this.localPlayerId);
        if (inst) {
          inst.update(this.myGrid, this.isSpectator);
          inst.setGhost(this.ghostEnabled && this.myPiece ? this.myPiece : null, this.ghostEnabled && this.myPiece ? ghostPosition(this.myGrid, this.myPiece) : null); // NACHT 19.6
        }
      }
      this.effects.animateSpecial(msg.type, msg.targetPlayerId);
      this.audio.specialHit();
      // NIGHT 17.8: Namen auflösen + Ereignisse auf MEINEM FELD hervorheben.
      const tName = this.playerInfo.get(msg.targetPlayerId)?.name ?? msg.targetPlayerId.slice(0, 6);
      const aName = this.playerInfo.get(msg.byPlayerId)?.name ?? msg.byPlayerId.slice(0, 6);
      const onMyField = msg.targetPlayerId === this.localPlayerId;
      this.logChat(
        "system",
        onMyField
          ? `⚠ SPECIAL AUF DEINEM FELD: "${msg.type}" (${SPECIALS[msg.type]?.name ?? ""}) von ${aName}`
          : `Special "${msg.type}" (${SPECIALS[msg.type]?.name ?? ""}) auf ${tName} von ${aName}`,
        onMyField,
      );
    });

    s.on("player_status", (data: unknown) => {
      const msg = data as PlayerStatusMessage;
      this.playerStatus.set(msg.playerId, msg.status);
      const inst = this.arena.grids.get(msg.playerId);
      if (msg.playerId === this.localPlayerId) {
        this.isSpectator = msg.status === "spectator";
        if (this.isSpectator) {
          // Eingaben gesperrt, eigenes Stück entfernen, Feld grau (Nacht 15)
          this.myPiece = null;
          if (inst) {
            inst.grid.lost = true;
            inst.grid.update(this.myGrid, true);
          }
          this.arena.setActivePiece(msg.playerId, null);
          this.audio.gameOver();
          this.logChat("system", "Game Over — du bist jetzt Spectator.");
        }
      } else {
        if (msg.status === "spectator" || msg.status === "winner") {
          // Nacht 15: verlorenes Feld bleibt sichtbar, aber grau (Rahmen-Farbe bleibt).
          if (inst) {
            inst.grid.lost = true;
            inst.grid.update(inst.grid.valuesSnapshot(), true);
          }
          this.arena.setActivePiece(msg.playerId, null);
          // Nacht 17.2: Caption des Felds auch grau machen (Nummer bleibt sichtbar).
          this.refreshFieldLabels();
          this.logChat("system", msg.status === "winner" ? "Ein Spieler hat das Spiel gewonnen." : "Ein Spieler ist ausgefallen (Spectator).");
        } else if (inst) {
          // Status zurück auf aktiv (Rematch) — normaler Farbton wiederherstellen
          inst.grid.lost = false;
          inst.grid.update(inst.grid.valuesSnapshot(), false);
          this.refreshFieldLabels();
        }
      }
      this.refreshLeaderboard();
    });

    s.on("game_over", (data: unknown) => {
      const msg = data as GameOverMessage;
      const isMe = msg.winnerId === this.localPlayerId;
      // Nacht 18: Team-Modus → mein TEAM hat gewonnen, nicht nur ich.
      const myTeam = this.playerTeam.get(this.localPlayerId);
      const myTeamWon = !!msg.winnerTeamId && myTeam !== undefined && myTeam === msg.winnerTeamId;
      const win = isMe || myTeamWon;
      if (win) this.audio.win();
      else this.audio.gameOver();

      let text = win ? "🏆 DU HAST GEWONNEN!" : "GAME OVER";
      if (msg.winnerTeamId) {
        const info = TEAMS[msg.winnerTeamId];
        text = win
          ? `🏆 EUER TEAM ${msg.winnerTeamId} HAT GEWONNEN!`
          : `GAME OVER — Team ${msg.winnerTeamId} (${info?.label ?? ""}) gewinnt`;
      }
      this.showBanner(text, win);
    });

    // Nacht 18.1 (attack-addlines.md): Ich habe Garbage-Linien erhalten.
    // Der Server hat bereits das Grid upgedatet + broadcastGrid gesendet —
    // hier nur die visuellen/audio + Eventlog-Meldung.
    s.on("lines_attack", (data: unknown) => {
      const msg = data as LinesAttackMessage;
      // Eigener Angriff: System-Log (die Empfänger sehen ihren eigenen Teil).
      this.logChat("system", `⚔ ${msg.attackerName} trifft ${msg.cleared}× → +${msg.count} Garbage-Zeile(n)`, msg.attackerId === this.localPlayerId);
      // Kleiner "Impact"-Ton — wir nutzen specialHit (der einzige verfügbare
      // "Impact"-Effekt-Sound, keine neuen Assets, siehe memory.md).
      this.audio.specialHit();
    });

    /* --- NACHT 19 (mainmenu.md §2.1): Ready-Check-Handler --- */
    s.on("ready_check_init", (data: unknown) => {
      const msg = data as ReadyCheckInitMessage;
      this.roomStatus = "READY_CHECK";
      this.readyCheckEndsAt = msg.endsAt;
      this.readyState.clear();
      for (const p of msg.players) this.readyState.set(p.id, p.ready);
      this.showReadyOverlay(msg);
    });

    s.on("player_ready_update", (data: unknown) => {
      const msg = data as PlayerReadyUpdateMessage;
      this.readyState.set(msg.playerId, msg.isReady);
      // Live-Update im Overlay (falls noch sichtbar)
      this.updateReadyOverlayList();
    });

    /* --- NACHT 19.2: Alle bereit → „Bereit\" wird zum „Start\"-Knopf (Leader) --- */
    s.on("ready_all_ready", () => {
      const overlay = document.getElementById("ready-overlay");
      const readyBtn = overlay?.querySelector<HTMLButtonElement>("#ready-ready-btn");
      if (this.amLeader && readyBtn) {
        readyBtn.textContent = "🚀 Start";
        readyBtn.classList.add("start-mode");
        readyBtn.onclick = () => this.socket.confirmStart();
        this.logChat("system", "Alle bereit — klicke auf 🚀 START, um loszulegen!");
      } else if (!this.amLeader) {
        this.logChat("system", "Alle bereit — wartet auf den Start des Leaders…");
      }
    });

    s.on("ready_check_aborted", (data: unknown) => {
      const msg = data as ReadyCheckAbortedMessage;
      this.roomStatus = "LOBBY";
      this.readyState.clear();
      this.hideReadyOverlay();
      const reasonText =
        msg.reason === "TIMEOUT_AFK" ? "⏱ AFK-Timeout" :
        msg.reason === "PLAYER_DECLINED" ? "⛔ Abgelehnt" : "↩️ Abgebrochen";
      this.logChat("system", `${reasonText} — Ready-Check beendet.`);
      if (msg.reason === "TIMEOUT_AFK" && msg.afkPlayerIds.includes(this.localPlayerId)) {
        this.logChat("system", "Du wurdest als AFK deklariert (60s-Sperre).", true);
      }
      this.updateTeamPanel();
    });

    s.on("game_start", (data: unknown) => {
      const msg = data as GameStartMessage;
      this.roomStatus = "INGAME";
      this.hideReadyOverlay();
      // Eigenen Predictions-Zustand zurücksetzen (wie rematch_started)
      this.isSpectator = false;
      this.myGrid = [];
      this.myPiece = null;
      this.myQueue = [];
      this.nextPiece.setQueue([]);
      this.myInventory = [];
      this.prevInventoryLen = 0;
      this.oppInterp.clear();
      this.playerInfo.forEach((info) => (info.score = 0));
      this.playerStatus.clear();
      this.hideBanner();
      this.updateInventoryUI();
      this.updateLeaderboard();
      for (const inst of this.arena.grids.values()) inst.grid.lost = false;
      this.logChat("system", `🚀 Match gestartet! (Seed: ${msg.seed})`);
      this.audio.specialGained(); // "Ready!"-Ton
      this.updateTeamPanel();
    });

    s.on("room_status", (data: unknown) => {
      const msg = data as { status: RoomStatus };
      this.roomStatus = msg.status;
      this.updateTeamPanel();
    });

    s.on("team_name_updated", (data: unknown) => {
      const msg = data as { teamId: TeamId; name: string };
      this.teamNames[msg.teamId] = msg.name;
      this.updateTeamPanel();
      this.updateLeaderboard();
    });
    s.on("rematch_started", (data: unknown) => {
      const msg = data as { byPlayerId: string };
      // Eigenen Predictions-Zustand zurücksetzen (Server schickt frische Grids)
      this.isSpectator = false;
      this.myGrid = [];
      this.myPiece = null;
      this.myQueue = [];
      this.nextPiece.setQueue([]);
      this.myInventory = [];
      this.prevInventoryLen = 0;
      this.oppInterp.clear();
      this.playerInfo.forEach((info) => (info.score = 0));
      // Nacht 15 (Bug-Fix): Status-Cache leeren, sonst bleibt ein früherer
      // "spectator" haften → Feld dauerhaft gedimmt + Leaderboard-Badge falsch.
      this.playerStatus.clear();
      this.hideBanner();
      this.updateInventoryUI();
      this.updateLeaderboard();
      // Nacht 15: verloren-grau aufheben (Rahmenfarbe bleibt)
      for (const inst of this.arena.grids.values()) inst.grid.lost = false;
      this.audio.specialGained(); // kleiner "Ready!"-Ton
      if (msg.byPlayerId === this.localPlayerId) {
        this.logChat("system", "🔄 Neues Spiel gestartet! Los geht's.");
      }
    });

    s.on("chat", (data: unknown) => {
      const msg = data as ChatMessageOut;
      this.logChat(msg.from, msg.text);
    });

    s.on("room_full", () => {
      this.logChat("system", "Raum ist voll. Warte auf einen freien Platz…");
    });
  }

  private setupInput(): void {
    this.input?.detach();
    this.input = new InputHandler(this.socket, {
      // NACHT 19.7 (inventory-addon.md §1.1): STRIKTES FIFO — es ist IMMER nur
      // das Special an Index 0 (das älteste) aktiv und auslösbar. Keine Freiwahl.
      getActiveSpecial: () => this.myInventory[0] ?? null,
      getTargetCount: () => Math.max(1, this.roomList.length),
      getTargetStatus: (idx) => {
        // NIGHT 17.8: Client-Guard — Specials auf ausgeschiedene Gegner
        // werden LOKAL abgelehnt (Inventar bleibt erhalten, kein Runden-Trip).
        const pid = this.roomList[idx];
        return pid ? (this.playerStatus.get(pid) ?? null) : null;
      },
      onRejectedTarget: (special, status) => {
        this.logChat("system", `Special "${special}" abgelehnt — Ziel ist nicht mehr aktiv (${status}).`);
      },
      onPredict: (action) => this.predict(action),
      // Nacht 15: „Ungültige Eingabe (kein aktives Stück)" unterdrücken —
      // Taste-Druck ohne Stück ist normal (z.B. direkt nach Lock / Game Over).
      onSpecialFire: () => this.audio.special(),
    });
    this.input.attach();

    // Mobile/Touch: Gesten auf dem Canvas + On-Screen-Buttons (sichtbar bei coarse-Pointer).
    const touchRoot = document.getElementById("touch-panel") as HTMLDivElement | null;
    if (touchRoot && !this.touch) {
      this.touch = new TouchControls(touchRoot, {
        act: (a) => this.input?.act(a),
        fireSpecial: (t) => this.input?.fireSpecial(t),
      });
      const canvas = document.getElementById("game-canvas");
      if (canvas) this.touch.attachGestures(canvas);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Client-Side Prediction (game.md §3.1)                             */
  /* ---------------------------------------------------------------- */
  /**
   * Führt eine Aktion LOKAL auf dem eigenen Feld aus und rendert sofort.
   * Der Server validiert dieselbe Aktion; das nächste grid_update
   * überlagert diese Kopie mit dem Server-Zustand (Snap-Back bei Lag).
   * Gibt true zurück, wenn die Aktion legal war.
   */
  private predict(action: PlayerAction): boolean {
    // NACHT 19.4: Außerhalb INGAME (Lobby/Ready-Check/Post-Game) keine lokale
    // Prediction — der Server akzeptiert die Eingabe ohnehin nicht, und wir
    // wollen keine visuellen Stücken-Bewegungen außerhalb des Spiels.
    if (this.roomStatus !== "INGAME") return false;
    if (this.isSpectator || !this.myPiece) return false;
    let changed = true;

    switch (action) {
      case "LEFT":
      case "RIGHT":
        changed = tryMove(this.myGrid, this.myPiece, action === "LEFT" ? -1 : 1, 0);
        if (changed) this.audio.move();
        break;
      case "ROTATE":
        changed = tryRotate(this.myGrid, this.myPiece);
        if (changed) this.audio.rotate();
        break;
      case "SOFT_DROP":
        changed = tryMove(this.myGrid, this.myPiece, 0, 1);
        if (changed) this.audio.softDrop();
        break;
      case "HARD_DROP": {
        hardDrop(this.myGrid, this.myPiece);
        const lines = clearLines(this.myGrid);
        this.audio.lock();
        if (lines > 0) this.audio.clear(lines);
        // Stück ist fest: lokales Piece erst auf null setzen, bis der Server
        // das nächste Stück sendet (Vermeidet Doppel-Stück-Rendering).
        this.myPiece = null;
        break;
      }
    }

    if (changed) {
      const inst = this.arena.getGrid(this.localPlayerId);
      if (inst) {
        inst.update(this.myGrid, false);
        inst.setActivePiece(this.myPiece);
        // NACHT 19.6: Schattenstein gleitet sofort mit (flüssig, ohne Verzögerung)
        inst.setGhost(this.ghostEnabled && this.myPiece ? this.myPiece : null, this.ghostEnabled && this.myPiece ? ghostPosition(this.myGrid, this.myPiece) : null);
      }
    }
    return changed;
  }

  /* ---------------------------------------------------------------- */
  /* UI                                                                */
  /* ---------------------------------------------------------------- */
  private initUI(): void {
    const chatInput = document.getElementById("chat-input") as HTMLInputElement | null;
    chatInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && chatInput.value.trim()) {
        this.socket.sendChat(chatInput.value.trim());
        chatInput.value = "";
      }
      e.stopPropagation();
    });

    /* ------------------------------------------------------------------ */
    /* Nacht 16.6: Rename auf der EIGENEN Leaderboard-Zeile.               */
    /* BINDING: Delegierter POINTERDOWN auf die stabile <ul> (#player-list) — */
    /* NICHT "click" pro Zeile: Die <li>s werden bei JEDEM Score-Update per */
    /* innerHTML ersetzt. Ein gewöhnlicher Klick besteht aus mousedown→     */
    /* mouseup→click; in dieser Lücke (20Hz Score-Updates) kann der Re-     */
    /* Render die Zeile + den frisch gesetzten Rename-Input wegreißen, und  */
    /* der anschließende click landet auf dem neuen (nicht gebundenen) <li> */
    /* → "drufklicke, passiert nichts". pointerdown feuert VOR diesem Race */
    /* und der Handler überlebt die Re-Renders (ul ist stabil).            */
    /* ------------------------------------------------------------------ */
    const playerList = document.getElementById("player-list");
    playerList?.addEventListener("pointerdown", (e) => {
      const li = (e.target as HTMLElement).closest?.("li") as HTMLLIElement | null;
      if (!li || li.dataset.own !== "1") return;
      e.preventDefault(); // Textauswahl + Doppelmeldungen vermeiden
      if (this.renameActive) return;
      this.startRename(li);
    });

    // M = Ton an/aus · R = Rematch (wenn Banner sichtbar)
    // Special-Char-Tasten (A/C/B/G/O/Q/N/R) wurden entfernt (Nacht 15) —
    // Tab wechselt Special, 1–6 feuern ab (siehe #keybinds + docs).
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.code === "KeyM") {
        const on = this.audio.toggle();
        this.logChat("system", on ? "🔊 Ton an" : "🔇 Ton aus");
      } else if (e.code === "KeyG") {
        // NACHT 19.6 (ghostpiece-addon.md §4): Schattenstein an/aus
        this.ghostEnabled = !this.ghostEnabled;
        localStorage.setItem("tetrinet3d_ghost", this.ghostEnabled ? "1" : "0");
        const inst = this.arena.getGrid(this.localPlayerId);
        if (inst) inst.setGhost(this.ghostEnabled && this.myPiece ? this.myPiece : null, this.ghostEnabled && this.myPiece ? ghostPosition(this.myGrid, this.myPiece) : null);
        this.logChat("system", this.ghostEnabled ? "👻 Schattenstein AN" : "👻 Schattenstein AUS");
      } else if (e.code === "KeyR" && this.rematchButton && !this.rematchButton.disabled) {
        this.rematchButton.click();
      }
    });
  }

  /** Zeigt den Game-Over-Banner mit Rematch-Button. */
  private showBanner(text: string, winner: boolean): void {
    const banner = document.getElementById("status-banner");
    if (!banner) return;
    banner.innerHTML = "";
    const h = document.createElement("div");
    h.textContent = text;
    const btn = document.createElement("button");
    btn.id = "rematch-btn";
    btn.textContent = "🔄 Neues Spiel (R)";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      this.socket.requestRematch();
    });
    banner.append(h, btn);
    banner.classList.toggle("winner", winner);
    banner.classList.remove("hidden");
    this.rematchButton = btn;
  }

  private hideBanner(): void {
    document.getElementById("status-banner")?.classList.add("hidden");
    this.rematchButton = null;
  }

  /** Nacht 16.6: true, während der eigene Name im Leaderboard editiert wird. */
  private renameActive = false;

  /** NACHT 19.7: true, während ein Team-Name im Team-Panel inline editiert wird. */
  private teamRenameActive = false;

  /** Leaderboard neu aufbauen: nach Score absteigend, lokaler Spieler markiert. */
  private updateLeaderboard(): void {
    const list = document.getElementById("player-list");
    if (!list) return;
    // Wichtige Guard: NICHT re-rendern, solange der Rename-Input lebt —
    // sonst würde der Input bei jedem Score-Update (innerHTML-Replace) weggerissen.
    if (this.renameActive) {
      if (list.querySelector("input.rename-input")) return;
      this.renameActive = false; // Input weggerissen → normal weiterbauen
    }
    const rows = this.roomList
      .map((pid) => ({
        id: pid,
        name: this.playerInfo.get(pid)?.name ?? pid.slice(0, 4),
        score: this.playerInfo.get(pid)?.score ?? 0,
        status: this.playerStatus.get(pid) ?? "active",
        // Nacht 18: Team-Badge (nur im Team-Modus, sonst undefined).
        team: this.teamMode === "solo" ? undefined : this.playerTeam.get(pid),
      }))
      .sort((a, b) => b.score - a.score);
    list.innerHTML = rows
      .map((r) => {
        const cls = [
          r.id === this.localPlayerId ? "local-player" : "",
          r.status === "spectator" ? "spectator" : "",
          r.status === "winner" ? "winner" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const botTag = r.id === this.localPlayerId ? "" : this.botIds.has(r.id) ? ' <span class="bot-tag">🤖</span>' : "";
      const own = r.id === this.localPlayerId;
      const ownCls = own ? " p-own" : "";
      const ownTitle = own ? ' title="Klicken, um deinen Namen zu ändern (Enter speichern, Esc abbrechen)"' : "";
      const ownData = own ? ' data-own="1"' : "";
      // Nacht 18: Team-Badge (farbiger Punkt + Team-Buchstabe), nur im Team-Modus.
      const teamTag = r.team && TEAMS[r.team]
        ? ` <span class="team-badge" style="background:${hexCss(TEAMS[r.team].color)}" title="${TEAMS[r.team].label}">${r.team}</span>`
        : "";
      return `<li class="${cls}${ownCls}"${ownData}${ownTitle}><span class="p-name">${escapeHtml(r.name)}${teamTag}${botTag}</span><span class="p-score">${r.score}</span></li>`;
      })
      .join("");
  }

  /**
   * Nacht 16.6: Inline-Umbenennung in der eigenen Leaderboard-Zeile.
   * Name wird zum Eingabefeld; Enter/Blur speichert (→ Server → room_state),
   * Esc oder leer bricht ab. Game-Keys sind in INPUTs automatisch inaktiv
   * (InputHandler + Window-Keydown prüfen auf INPUT/TEXTAREA).
   */
  private startRename(row: HTMLLIElement): void {
    // Falls bereits ein Editierfeld da ist (z. B. Doppelklick oder gestückter
    // Zustand): einfach fokussieren — nie in einem toten Zustand hängenbleiben.
    const existing = row.querySelector<HTMLInputElement>("input.rename-input");
    if (existing) {
      this.renameActive = true;
      existing.focus();
      existing.select();
      return;
    }
    this.renameActive = true;
    const current = this.playerInfo.get(this.localPlayerId)?.name ?? "";
    const nameEl = row.querySelector<HTMLElement>(".p-name");
    if (!nameEl) {
      this.renameActive = false;
      return;
    }

    const input = document.createElement("input");
    input.className = "rename-input";
    input.maxLength = 20;
    input.value = current;
    input.setAttribute("spellcheck", "false");
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      this.renameActive = false;
      const trimmed = input.value.trim();
      if (save && trimmed && trimmed !== current) {
        try {
          localStorage.setItem("tetrinet3d_player_name", trimmed);
        } catch { /* Storage blockiert → egal */ }
        this.socket.renamePlayer(trimmed); // Server → room_state → Re-Render
      } else {
        // Abbrechen/leer/unverändert: Namens-Span wiederherstellen
        // (updateLeaderboard wäre hier guard-blockiert → direkt reparieren).
        if (input.parentNode) {
          const span = document.createElement("span");
          span.className = "p-name";
          span.textContent = current;
          input.replaceWith(span);
        }
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  /** Score-/Status-Änderungen im bestehenden Leaderboard anwenden. */
  private refreshLeaderboard(): void {
    this.updateLeaderboard();
  }

  /**
   * Nacht 12: Setzt für JEDES Feld (lokal + Gegner) die Rahmen-Farbe (Teamfarbe)
   * und das Namens-/Score-Label über dem Feld. Index-basiert aus PLAYER_COLORS
   * (0 = lokal, 1–5 = Gegner) — zirkulär wiederverwendbar bei >6 Spielern.
   */
  private refreshFieldLabels(): void {
    for (const pid of this.roomList) {
      const idx = this.roomList.indexOf(pid);
      const info = this.playerInfo.get(pid);
      const name = info?.name ?? pid.slice(0, 6);
      const score = info?.score ?? 0;
      const lost = this.playerStatus.get(pid) === "spectator" || this.playerStatus.get(pid) === "winner";
      // Nacht 18.1: Rahmen-Farbe: Team-Farbe (falls Team), sonst PLAYER_COLORS.
      const teamId = this.playerTeam.get(pid);
      const color = teamId ? TEAMS[teamId].color : PLAYER_COLORS[idx % PLAYER_COLORS.length];
      this.arena.setFrameColor(pid, color);
      // Nacht 17.2: fieldNo = Taste (1–6), lost = graue Caption
      // Nacht 18.1: teamColor für die Caption-Rahmen/Badge in Teamfarbe.
      const teamColor = teamId ? TEAMS[teamId].color : undefined;
      this.arena.updateLabel(pid, name, score, idx + 1, lost, teamColor);
    }
  }

  /**
   * Bot-Panel: nur für den Lobby-Leader sichtbar.
   * Zeigt die aktuelle Bot-Anzahl + Stufe und Buttons zum Hinzufügen,
   * Entfernen und Ändern der Schwierigkeitsstufe.
   */
  private updateBotPanel(): void {
    let panel = document.getElementById("bot-panel") as HTMLDivElement | null;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "bot-panel";
      panel.className = "bot-panel";
      // Linke Spalte: unter Spielerliste & Chat, damit es das Spielfeld nicht verdeckt.
      (document.getElementById("left-panel") ?? document.getElementById("ui-container") ?? document.body).appendChild(panel);
      this.botPanel = panel;
    }

    // Nicht-Leader: Panel ausblenden.
    if (!this.amLeader) {
      panel!.classList.add("hidden");
      return;
    }
    panel!.classList.remove("hidden");

    // Fallback = Server-Default (DEV: ultra_nightmare, siehe server/src/config.ts).
    const diff = this.botDifficulty ?? "ultra_nightmare";
    const opts = BOT_DIFFICULTIES.map(
      (d) => `<option value="${d.key}" ${d.key === diff ? "selected" : ""}>${d.label}</option>`,
    ).join("");

    panel!.innerHTML = `
      <div class="bot-panel-title">🤖 Bots (Lobby-Leader)</div>
      <label class="bot-diff">
        <span>Schwierigkeit:</span>
        <select id="bot-diff-select">${opts}</select>
      </label>
      <div class="bot-btns">
        <button id="bot-add-1">+1</button>
        <button id="bot-add-3">+3</button>
        <button id="bot-add-5">+5</button>
        <button id="bot-remove">Alles entfernen</button>
      </div>
      <div class="bot-hint">${this.botIds.size} im Raum</div>`;

    // Listener (einmalig, da innerHTML ersetzt wird)
    const add = (n: number) => this.socket.addBots(n, (document.getElementById("bot-diff-select") as HTMLSelectElement).value as BotDifficulty);
    (document.getElementById("bot-add-1") as HTMLButtonElement)?.addEventListener("click", () => add(1));
    (document.getElementById("bot-add-3") as HTMLButtonElement)?.addEventListener("click", () => add(3));
    (document.getElementById("bot-add-5") as HTMLButtonElement)?.addEventListener("click", () => add(5));
    (document.getElementById("bot-remove") as HTMLButtonElement)?.addEventListener("click", () => this.socket.removeBots());
    (document.getElementById("bot-diff-select") as HTMLSelectElement)?.addEventListener("change", (e) => {
      this.socket.setBotDifficulty((e.target as HTMLSelectElement).value as BotDifficulty);
    });
  }

  /**
   * Nacht 18: Team-Panel.
   *  - Für ALLE sichtbar: aktuelle Team-Zuordnung (Roster) + Modus.
   *  - NUR für den Leader: Modus-Auswahl (Solo / 2er / 3er Teams).
   */
  /* --- NACHT 19 (mainmenu.md §2.1): Ready-Check-Overlay --- */
  /**
   * Bildschirmfüllendes animiertes Overlay mit 15s-Countdown + Ready-Liste.
   * (mainmenu.md §2.1: "UI-Freeze & Overlay, pulsierender Countdown,
   *  Herzschlag-Sound.") Herzschlag-Sound: wir nutzen `audio.special` als
   * Platzhalter (keine neuen Assets, siehe memory.md).
   */
  private showReadyOverlay(msg: ReadyCheckInitMessage): void {
    let overlay = document.getElementById("ready-overlay") as HTMLDivElement | null;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ready-overlay";
      overlay.className = "ready-overlay";
      document.body.appendChild(overlay);
      this.readyOverlay = overlay;
    }
    const isLeader = this.amLeader;
    const myReady = this.readyState.get(this.localPlayerId) ?? false;
    overlay.innerHTML = `
      <div class="ready-overlay-box">
        <h2 class="ready-title">🎯 Ready-Check</h2>
        <div class="ready-countdown"><span id="ready-seconds">${Math.max(0, Math.ceil((msg.endsAt - Date.now()) / 1000))}</span> s</div>
        <div class="ready-list" id="ready-list"></div>
        ${isLeader
          ? `<button id="ready-ready-btn" class="ready-btn ${myReady ? "ready-active" : ""}">${myReady ? "✓ Bereit" : "🚀 Bereit"}</button>
             <button id="ready-decline-btn" class="ready-btn decline">⛔ Ablehnen</button>`
          : `<button id="ready-ready-btn" class="ready-btn ${myReady ? "ready-active" : ""}">${myReady ? "✓ Bereit" : "🚀 Bereit"}</button>
             <button id="ready-decline-btn" class="ready-btn decline" disabled>⛔ Ablehnen (nur Leader)</button>`}
      </div>`;
    overlay.classList.remove("hidden");
    this.readyCountdownEl = overlay.querySelector("#ready-seconds");
    // Herzschlag-Sound (Puls-Ton als Spannung, mainmenu.md §2.1)
    this.audio.special();
    // Live-Liste aktualisieren
    this.updateReadyOverlayList();
    // Buttons binden
    const readyBtn = overlay.querySelector<HTMLButtonElement>("#ready-ready-btn");
    if (readyBtn) {
      readyBtn.addEventListener("click", () => {
        if (!this.readyState.get(this.localPlayerId)) {
          this.readyState.set(this.localPlayerId, true);
          this.socket.playerReady(true);
          this.updateReadyOverlayList();
        }
      });
    }
    const declineBtn = overlay.querySelector<HTMLButtonElement>("#ready-decline-btn");
    if (declineBtn && !declineBtn.disabled) {
      declineBtn.addEventListener("click", () => {
        declineBtn.disabled = true;
        this.socket.playerReady(false); // Server → ready_check_aborted
      });
    }
    // Countdown-Animation (rAF, bis readyCheckEndsAt)
    this.startReadyCountdown();
  }

  /** Live-Liste der Ready-Status-Updates im Overlay. */
  private updateReadyOverlayList(): void {
    const list = document.getElementById("ready-list");
    if (!list) return;
    const rows = this.roomList
      .map((pid) => {
        const name = this.playerInfo.get(pid)?.name ?? pid.slice(0, 4);
        const team = this.playerTeam.get(pid);
        const ready = this.readyState.get(pid) ?? false;
        const isMe = pid === this.localPlayerId;
        const teamColor = team ? hexCss(TEAMS[team].color) : null;
        return `<li class="${ready ? "member-ready" : ""}${isMe ? " me" : ""}"${teamColor ? ` style="border-left-color:${teamColor}"` : ""}>
          <span>${escapeHtml(name)}</span><span class="ready-state">${ready ? "✓ bereit" : "… wartet"}</span></li>`;
      })
      .join("");
    list.innerHTML = rows;
  }

  /** rAF-basierter Countdown (pulsierend, mainmenu.md §2.1). */
  private startReadyCountdown(): void {
    if (this.readyRaf) cancelAnimationFrame(this.readyRaf);
    const tick = (): void => {
      if (!this.readyCheckEndsAt) return;
      const remaining = Math.max(0, this.readyCheckEndsAt - Date.now());
      const secs = Math.ceil(remaining / 1000);
      const el = document.getElementById("ready-seconds");
      if (el) {
        el.textContent = String(secs);
        // Puls: letzte 5s rot + größer
        el.parentElement!.classList.toggle("urgent", secs <= 5);
      }
      if (remaining > 0) {
        this.readyRaf = requestAnimationFrame(tick);
      }
    };
    this.readyRaf = requestAnimationFrame(tick);
  }

  private hideReadyOverlay(): void {
    const overlay = document.getElementById("ready-overlay");
    if (overlay) overlay.classList.add("hidden");
    if (this.readyRaf) { cancelAnimationFrame(this.readyRaf); this.readyRaf = null; }
    this.readyCountdownEl = null;
    this.readyCheckEndsAt = null;
  }

  private updateTeamPanel(): void {
    let panel = document.getElementById("team-panel") as HTMLDivElement | null;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "team-panel";
      panel.className = "team-panel";
      (document.getElementById("left-panel") ?? document.getElementById("ui-container") ?? document.body).appendChild(panel);
      this.teamPanel = panel;
    }

    // NACHT 19.7 (wie Spieler-Umbenennen): NICHT re-rendern, solange der
    // Team-Name-Input lebt — sonst würde er bei jedem Score-/room_state-Update
    // (innerHTML-Replace) weggerissen.
    if (this.teamRenameActive) {
      if (panel.querySelector("input.team-rename-input")) return;
      this.teamRenameActive = false; // Input weggerissen → normal weiterbauen
    }

    const mode = this.teamMode;
    // Team-Roster aus der aktuellen Room-Liste bauen (Beitrittsreihenfolge).
    const rosterByTeam = new Map<TeamId, { name: string; team: TeamId; ready: boolean }[]>();
    for (const pid of this.roomList) {
      const team = this.playerTeam.get(pid);
      if (!team) continue;
      const name = this.playerInfo.get(pid)?.name ?? pid.slice(0, 6);
      const ready = this.readyState.get(pid) ?? false;
      if (!rosterByTeam.has(team)) rosterByTeam.set(team, []);
      rosterByTeam.get(team)!.push({ name, team, ready });
    }
    const teamIds = [...rosterByTeam.keys()].sort();

    // NACHT 19: Teamnamen (Custom oder Standard) + Ready-Status pro Mitglied.
    const displayTeamName = (tid: TeamId): string => this.teamNames[tid] ?? TEAMS[tid].label;
    const rosterHtml = mode === "solo"
      ? '<div class="team-roster solo">Solo-Modus — jeder für sich.</div>'
      : teamIds
          .map((tid) => {
            const info = TEAMS[tid];
            // NACHT 19.7 (Team-Leader-Regel): ✎ nur für das Team, dessen
            // Leader der lokale Spieler ist (erster Joiner, s. teamLeaders).
            const isTeamLeader = this.teamLeaders[tid] === this.localPlayerId;
            const readyCount = rosterByTeam.get(tid)!.filter((m) => m.ready).length;
            const totalCount = rosterByTeam.get(tid)!.length;
            const readyBadge = this.roomStatus === "READY_CHECK"
              ? ` <span class="team-ready-badge">${readyCount}/${totalCount} bereit</span>` : "";
            // NACHT 19.7 (Team-Leader-Regel): Eigener Team-Name ist KLIKBAR
            // (wie der eigene Spieler-Name) → inline-Umbenennen (Enter speichern,
            // Esc abbrechen). NUR wenn ich der Team-Leader (erster Joiner) bin.
            const nameAttr = isTeamLeader
              ? `class="team-name-editable" data-team="${tid}" title="Klicken, um den Team-Namen zu ändern (Enter speichern, Esc abbrechen)"`
              : `class="team-name"`;
            const pencil = isTeamLeader ? `<span class="team-pencil" aria-hidden="true">✎</span>` : "";
            return `<div class="team-roster" style="border-left-color:${hexCss(info.color)}"><span class="team-dot" style="background:${hexCss(info.color)}"></span><b ${nameAttr}>${escapeHtml(displayTeamName(tid))}</b>${pencil}${readyBadge}<div class="team-members">${rosterByTeam.get(tid)!.map((m) => `<span class="${m.ready ? "member-ready" : ""}">${escapeHtml(m.name)}${m.ready ? " ✓" : ""}</span>`).join("")}</div></div>`;
          })
          .join("");

    // Modus-Auswahl: NUR Leader.
    const modeBtns = this.amLeader
      ? `<div class="team-modes">
          <button data-mode="solo" class="${mode === "solo" ? "active" : ""}">Solo</button>
          <button data-mode="team2" class="${mode === "team2" ? "active" : ""}">2er-Teams</button>
          <button data-mode="team3" class="${mode === "team3" ? "active" : ""}">3er-Teams</button>
        </div>`
      : "";

    // NACHT 19: Status-Indikator + Start-/Cancel-Button (nur Leader, LOBBY/POST_GAME).
    const statusLabel: Record<RoomStatus, string> = {
      LOBBY: "🏛 Lobby",
      READY_CHECK: "⏳ Ready-Check…",
      INGAME: "🎮 In-Game",
      POST_GAME: "🏁 Post-Game",
    };
    const startSection = this.amLeader
      ? `<div class="team-start-section">
          <div class="room-status">${statusLabel[this.roomStatus]}</div>
          ${this.roomStatus === "LOBBY" || this.roomStatus === "POST_GAME"
            ? `<button id="start-match-btn" class="start-btn">🚀 Match starten</button>`
            : this.roomStatus === "READY_CHECK"
              ? `<button id="cancel-ready-btn" class="cancel-btn">↩️ Ready-Check abbrechen</button>`
              : ""}
        </div>`
      : `<div class="team-start-section"><div class="room-status">${statusLabel[this.roomStatus]}</div></div>`;

    panel!.innerHTML = `
      ${startSection}
      <div class="team-panel-title">👥 Teams</div>
      ${modeBtns}
      <div class="team-roster-box">${rosterHtml}</div>`;

    // Modus-Buttons (nur bei Leader vorhanden).
    panel!.querySelectorAll<HTMLButtonElement>(".team-modes button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = btn.dataset.mode as TeamMode;
        if (m !== mode) this.socket.setGameMode(m); // Server → room_state → Re-Render
      });
    });

    // NACHT 19: Start-Button.
    const startBtn = panel!.querySelector<HTMLButtonElement>("#start-match-btn");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        startBtn.disabled = true;
        this.socket.startReadyCheck(); // Server → ready_check_init → Overlay
      });
    }

    // NACHT 19: Cancel-Button (nur Leader, während READY_CHECK).
    const cancelBtn = panel!.querySelector<HTMLButtonElement>("#cancel-ready-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        cancelBtn.disabled = true;
        this.socket.cancelReadyCheck();
      });
    }

    // NACHT 19.7 (mainmenu.md §3): Team-Namen inline editieren (wie Spieler-Umbenennen).
    // Eigener Team-Name ist klickbar (class .team-name-editable) → Input vor Ort.
    panel!.querySelectorAll<HTMLElement>(".team-name-editable").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startTeamRename(el);
      });
    });
  }

  /**
   * NACHT 19.7: Inline-Umbenennung des eigenen Teams im Team-Panel —
   * identisches Muster wie `startRename` (Spieler-Name): Name wird zum
   * Eingabefeld; Enter/Blur speichert (→ Server → team_name_updated),
   * Esc oder leer bricht ab. Game-Keys sind in INPUTs automatisch inaktiv.
   */
  private startTeamRename(nameEl: HTMLElement): void {
    const tid = nameEl.dataset.team as TeamId;
    const current = this.teamNames[tid] ?? TEAMS[tid].label;
    // Bereits ein Editierfeld da (Doppelklick)? Einfach fokussieren.
    const existing = nameEl.parentElement?.querySelector<HTMLInputElement>("input.team-rename-input");
    if (existing) {
      this.teamRenameActive = true;
      existing.focus();
      existing.select();
      return;
    }
    this.teamRenameActive = true;

    const input = document.createElement("input");
    input.className = "team-rename-input";
    input.maxLength = 24;
    input.value = current;
    input.setAttribute("spellcheck", "false");
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      this.teamRenameActive = false;
      const trimmed = input.value.trim();
      if (save && trimmed && trimmed !== current) {
        this.socket.editTeamName(tid, trimmed); // Server sanitisiert + broadcast
      } else {
        // Abbrechen/leer/unverändert: Namens-Span wiederherstellen.
        if (input.parentNode) {
          const b = document.createElement("b");
          b.className = "team-name-editable";
          b.dataset.team = tid;
          b.setAttribute("title", "Klicken, um den Team-Namen zu ändern (Enter speichern, Esc abbrechen)");
          b.textContent = current;
          input.replaceWith(b);
        }
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  private updateInventoryUI(): void {
    const panel = document.getElementById("inventory-panel");
    const list = document.getElementById("specials-list");
    if (!panel || !list) return;
    // Nacht 15: Panel nur anzeigen, wenn Specials im Inventar sind (vermeidet
    // eine leere Box zwischen Hauptfeld & Gegnern).
    panel.classList.toggle("hidden", this.myInventory.length === 0);
    if (this.myInventory.length === 0) { list.innerHTML = ""; return; }
    // NACHT 19.7 (inventory-addon.md §1.1): FIFO-Queue — Index 0 = AKTIV
    // (auslösbar), der Rest wartet. Ab Index 1 nicht mehr selektierbar.
    list.innerHTML = this.myInventory
      .map((sp, i) => {
        const def = SPECIALS[sp];
        const polarity = NEGATIVE_SPECIALS.includes(sp) ? "negative" : "positive";
        const title = `${def.name} — ${def.description}` + (i === 0 ? "  (AKTIV — mit 1–6 abfeuern)" : "  (wartet in der Queue)");
        return `<span class="special-slot ${i === 0 ? "active" : "queued"} ${polarity}" title="${escapeHtml(title)}">${sp}</span>`;
      })
      .join("");
  }

  /**
   * Nacht 15: System-Events (author="system") → #actions-log (oben).
   * Spieler-Nachrichten → #chat-log (unten).
   */
  private logChat(author: string, text: string, highlight = false): void {
    const isSystem = author === "system";
    const logId = isSystem ? "actions-log" : "chat-log";
    const log = document.getElementById(logId);
    if (!log) return;
    const div = document.createElement("div");
    // NIGHT 17.8: `highlight` = Ereignis betrifft MEIN Spielfeld → auffällig
    div.className = "msg" + (isSystem ? " system" : "") + (highlight ? " my-field" : "");
    if (isSystem) {
      div.textContent = text;
    } else {
      div.innerHTML = `<span class="author">${escapeHtml(author)}:</span>${escapeHtml(text)}`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  /* ---------------------------------------------------------------- */
  /* Schleife                                                          */
  /* ---------------------------------------------------------------- */
  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();
    this.effects.tick(dt);
    this.updateOpponentInterpolation();
    // NIGHT 17.8: Pulsierender Glow für Special-Steine (nur wenn vorhanden)
    for (const inst of this.arena.grids.values()) {
      inst.grid.pulseSpecials(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Glättet die Positionen der fallenden Gegner-Blöcke zwischen den
   * 20Hz-Server-Updates (lineare Interpolation, max. 250ms-Trail).
   */
  private updateOpponentInterpolation(): void {
    const now = performance.now();
    for (const [playerId, st] of this.oppInterp) {
      if (!st.prev || !st.cur || st.prev.type !== st.cur.type) continue;
      const k = (now - st.t) / 250; // 250ms = 5 Server-Ticks Trail
      if (k >= 1) continue; // endgültige Position liegt bereits
      const lerp = (a: number, b: number) => a + (b - a) * Math.min(k, 0.999);
      this.arena.moveActivePiece(playerId, {
        ...st.cur,
        x: lerp(st.prev.x, st.cur.x),
        y: lerp(st.prev.y, st.cur.y),
      });
    }
  }

  private initResizeListener(): void {
    // Initiale Kamera-Einstellung (Nacht 17.3: Ortho-View-Volumen)
    this.arena.applyCameraFraming(window.innerWidth, window.innerHeight);
    this.positionInventory();
    window.addEventListener("resize", () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      // applyCameraFraming() setzt Ortho left/right/top/bottom + updateProjectionMatrix
      this.arena.applyCameraFraming(window.innerWidth, window.innerHeight);
      this.positionInventory();
    });
  }

  /**
   * Nacht 15: Positioniert das HTML-Inventar exakt in der freien 3D-Lücke
   * zwischen Hauptfeld und Gegnerfeldern (Position von Arena berechnete Pixel).
   */
  private positionInventory(): void {
    const panel = document.getElementById("inventory-panel");
    if (!panel) return;
    const pos = this.arena.inventoryScreenPos;
    if (!pos) return;
    panel.style.left = `${pos.x}px`;
    panel.style.top = `${pos.y}px`;
    // transform (-50%,-50%) bleibt im CSS — zentriert das Panel auf die Position.
  }
}

function hexCss(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new GameApp();
  (window as any).__game = app; // Debug-Zugriff (Dev)
});
