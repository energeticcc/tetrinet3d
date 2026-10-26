/**
 * AI-Agenten-Brücke.
 *
 * Verbindet KI-Agenten (z.B. ein LLM) mit der Tetrinet3D-Arena über das
 * GLEICHE Socket-Protokoll wie ein normaler Browser-Client. Jeder Agent
 * erhält eine eigene Socket-Verbindung zu sich selbst (localhost) und kann
 * damit exakt dieselben Aktionen durchführen wie ein Mensch: bewegen, drehen,
 * (soft-)drop, Specials abfeuern, chatten, rematch, Bots verwalten.
 *
 * Zusätzlich liefert die Brücke:
 *   - `describe()`: eine maschinen-/LLM-lesbare Beschreibung des Spiels
 *     (Regeln, Steuerung, Specials, Scoring), damit die KI lernen kann.
 *   - `status(id)`: der aktuelle Zustand aus der Perspektive des Agents
 *     (eigenes Feld, aktives Stück, Queue, Inventar, Gegner, Score, Status).
 */
import { io as connect, type Socket } from "socket.io-client";
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  MAX_PLAYERS,
  SPECIALS,
  NEGATIVE_SPECIALS,
  POSITIVE_SPECIALS,
} from "@tetrinet3d/shared";
import type { PlayerAction, SpecialType, BotDifficulty } from "@tetrinet3d/shared";

/** Ein registrierter KI-Agent + sein zuletzt bekannter Spielzustand. */
export interface AiAgent {
  id: string;
  name: string;
  socket: Socket;
  connected: boolean;
  createdAt: number;

  /** Server-zuweisene Spieler-ID (== Socket-ID). */
  playerId: string;
  /** Eigener Status: active | spectator | winner. */
  ownStatus: string;
  /** Eigener Score. */
  score: number;
  /** Aktives Stück (eigene Ansicht). */
  activePiece: { type: number; rotation: number; x: number; y: number } | null;
  /** Nächste Stücke (Queue). */
  queue: number[];
  /** Eigener Grid (22x12, y=0 oben). */
  grid: number[][] | null;
  /** Spezial-Inventar. */
  inventory: SpecialType[];
  /** Gegner (id → Kurzinfo). */
  opponents: Record<string, { name: string; score: number; status: string; isBot: boolean }>;
  /** Letztes relevantes Ereignis (für LLM-Feedback-Loop). */
  lastEvents: Array<{ at: number; text: string }>;
}

interface DescribeResult {
  game: string;
  grid: { width: number; height: number; rows: number; cols: number };
  pieces: string;
  controls: Record<string, string>;
  specials: Array<{ type: string; name: string; description: string; polarity: "negativ" | "positiv" }>;
  scoring: string;
  winCondition: string;
  api: {
    base: string;
    endpoints: Array<{ method: string; path: string; purpose: string }>;
  };
}

/**
 * Verwaltet die Lebenszyklen + Zustands-Caches aller KI-Agenten.
 * Thread-sicher genug für den serverseitigen HTTP-Handler (Single-Process).
 */
export class AiAgentManager {
  private agents = new Map<string, AiAgent>();
  private seq = 0;

  constructor(private serverUrl: string) {}

  /** Anzahl aktiver Agenten. */
  get count(): number {
    return this.agents.size;
  }

  /** Liste aller Agenten (Kurzinfo, ohne Socket). */
  list(): Array<{ id: string; name: string; connected: boolean; playerId: string }> {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      connected: a.connected,
      playerId: a.playerId,
    }));
  }

  private get(id: string): AiAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * Registriert einen neuen KI-Agenten und verbindet ihn mit der Arena.
   * @param name Anzeigename (max. 20 Zeichen).
   */
  async register(name: string): Promise<{ agentId: string; playerId: string }> {
    const cleanName = (name || "AI").trim().slice(0, 20) || "AI";
    const socket = connect(this.serverUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
    });

    const agent: AiAgent = {
      id: `ai-${(++this.seq).toString(36)}`,
      name: cleanName,
      socket,
      connected: false,
      createdAt: Date.now(),
      playerId: "",
      ownStatus: "active",
      score: 0,
      activePiece: null,
      queue: [],
      grid: null,
      inventory: [],
      opponents: {},
      lastEvents: [],
    };
    this.agents.set(agent.id, agent);
    this.pushEvent(agent, `Agent "${cleanName}" registriert. Warte auf Verbindung …`);

    socket.on("connect", () => {
      agent.playerId = socket.id ?? "";
      agent.connected = true;
      socket.emit("join_room", { name: cleanName });
      this.pushEvent(agent, `Verbunden, Spieler-ID ${socket.id ?? ""}. Betrete Arena.`);
    });

    // WICHTIG (Nacht 16): Wenn der Server neu startet, sterben die in-process
    // Sockets. Ohne diesen Handler bliebe `connected=true` → action() würde
    // "ok:true" melden, aber an einen toten Socket emittieren (Agent friert
    // scheinbar ein). Jetzt: Status melden + Agent aus dem Registry entfernen,
    // damit der Raum-Slot frei wird und Clients keine Ghost-Player sehen.
    socket.on("disconnect", () => {
      agent.connected = false;
      this.pushEvent(agent, "⚠️ Server-Verbindung verloren (Server-Neustart?). Agent wird entfernt.");
      this.agents.delete(agent.id);
    });

    socket.on("room_state", (d: any) => {
      const players: any[] = d?.players ?? [];
      agent.playerId = players[0]?.id ?? agent.playerId;
      for (const p of players) {
        if (p.id === agent.playerId) {
          agent.score = p.score ?? 0;
        } else {
          agent.opponents[p.id] = {
            name: p.name,
            score: p.score ?? 0,
            status: "active",
            isBot: !!p.isBot,
          };
        }
      }
    });

    socket.on("grid_update", (d: any) => {
      const own = d?.playerId === agent.playerId;
      if (own) {
        agent.grid = d.grid;
        agent.activePiece = d.activePiece ?? null;
        agent.queue = d.queue ?? [];
        if (d.score !== undefined) agent.score = d.score;
      } else {
        const opp = agent.opponents[d.playerId];
        if (opp) opp.score = d.score ?? opp.score;
      }
    });

    socket.on("specials_update", (d: any) => {
      if (d?.playerId === agent.playerId) agent.inventory = d.inventory ?? [];
    });

    socket.on("player_status", (d: any) => {
      if (d?.playerId === agent.playerId) {
        agent.ownStatus = d.status;
        this.pushEvent(agent, `Eigener Status: ${d.status}.`);
      } else if (agent.opponents[d?.playerId]) {
        agent.opponents[d.playerId].status = d.status;
      }
    });

    socket.on("special_triggered", (d: any) => {
      const targetName = d.targetPlayerId === agent.playerId ? "dich" : d.targetPlayerId;
      this.pushEvent(agent, `Special "${d.type}" (${SPECIALS[d.type as SpecialType]?.name ?? ""}) auf ${targetName} gezündet.`);
      if (d.updatedTargetGrid) {
        if (d.targetPlayerId === agent.playerId) agent.grid = d.updatedTargetGrid;
      }
      if (d.updatedAttackerGrid && d.byPlayerId === agent.playerId) agent.grid = d.updatedAttackerGrid;
    });

    socket.on("game_over", (d: any) => {
      const won = d?.winnerId === agent.playerId;
      agent.ownStatus = won ? "winner" : "spectator";
      this.pushEvent(agent, won ? "🏆 GESIEGT!" : "GAME OVER.");
    });

    socket.on("chat", (d: any) => {
      this.pushEvent(agent, `Chat [${d?.from}]: ${d?.text}`);
    });

    socket.on("room_full", () => {
      this.pushEvent(agent, "⚠️ Raum voll — kein Platz für diesen Agenten.");
    });

    socket.on("disconnect", () => {
      agent.connected = false;
      this.pushEvent(agent, "Verbindung zum Server verloren.");
    });

    // Warten, bis verbunden + Spieler-ID bekannt (oder Time-out).
    const deadline = Date.now() + 4000;
    while (!agent.playerId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return { agentId: agent.id, playerId: agent.playerId };
  }

  /** Alle Aktionen, die ein Mensch ausführen kann (für einen Agenten). */
  action(id: string, action: PlayerAction): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    if (!a.connected) return { ok: false, error: "Agent nicht verbunden." };
    a.socket.emit("player_input", { action });
    return { ok: true };
  }

  /** Special abfeuern (targetIndex: 0=eigenes Feld, 1–5=Gegner). */
  special(id: string, targetIndex: number, specialType: SpecialType): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    if (!a.connected) return { ok: false, error: "Agent nicht verbunden." };
    if (!SPECIALS[specialType]) return { ok: false, error: `Unbekanntes Special "${specialType}".` };
    // NACHT 19.7 (inventory-addon.md §1.1): FIFO — nur das Front-Special
    // (Index 0) ist auslösbar; Server verifiziert den Rest.
    if (a.inventory.length === 0 || a.inventory[0] !== specialType) {
      return { ok: false, error: `FIFO: nur das Front-Special "${a.inventory[0] ?? "∅"}" ist aktiv (hast: ${a.inventory.join(",") || "keine"}).` };
    }
    a.socket.emit("use_special", { targetIndex, specialType });
    a.inventory = a.inventory.filter((s, i) => !(s === specialType && i === a.inventory.indexOf(specialType)));
    return { ok: true };
  }

  /** Chat-Nachricht senden. */
  chat(id: string, text: string): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    if (!a.connected) return { ok: false, error: "Agent nicht verbunden." };
    a.socket.emit("chat", { text: (text || "").slice(0, 200) });
    return { ok: true };
  }

  /** Rematch anfragen (nur nach Spielende). */
  rematch(id: string): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    if (!a.connected) return { ok: false, error: "Agent nicht verbunden." };
    a.socket.emit("rematch");
    return { ok: true };
  }

  /** Bots hinzufügen (nur Lobby-Leader). */
  addBots(id: string, count: number, difficulty?: BotDifficulty): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    if (!a.connected) return { ok: false, error: "Agent nicht verbunden." };
    a.socket.emit("add_bots", { count, difficulty });
    return { ok: true };
  }

  /** Alle Bots entfernen (nur Lobby-Leader). */
  removeBots(id: string): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    if (!a.connected) return { ok: false, error: "Agent nicht verbunden." };
    a.socket.emit("remove_bots");
    return { ok: true };
  }

  /** Entfernt einen Agenten (Socket trennen + aus dem Raum). */
  unregister(id: string): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "Agent nicht gefunden." };
    a.socket.disconnect();
    this.agents.delete(id);
    return { ok: true };
  }

  /** Vollständiger Status eines Agents (für den LLM-Feedback-Loop). */
  status(id: string): any {
    const a = this.get(id);
    if (!a) return { error: "Agent nicht gefunden." };
    return {
      agentId: a.id,
      name: a.name,
      connected: a.connected,
      playerId: a.playerId,
      ownStatus: a.ownStatus,
      score: a.score,
      activePiece: a.activePiece,
      queue: a.queue,
      inventory: a.inventory,
      grid: a.grid,
      gridHeight: a.grid ? a.grid.length : GRID_HEIGHT,
      gridWidth: a.grid?.[0]?.length ?? GRID_WIDTH,
      /** Höhe des eigenen Stacks (nützlich für die KI). */
      ownStackTop: this.stackTop(a.grid),
      opponents: Object.entries(a.opponents).map(([pid, o]) => ({ id: pid, ...o })),
      recentEvents: a.lastEvents.slice(-12),
      hint: a.ownStatus === "active"
        ? "Steuere mit action(). Vermeide es, deinen Stack zu hoch zu bauen. Nutze Specials strategisch."
        : (a.ownStatus === "winner" ? "Du hast gewonnen. rematch() für eine neue Runde." : "Ausgeschieden (Spectator). Du kannst den Raum beobachten."),
    };
  }

  /** Y-Koordinate der obersten gefüllten Zelle (kleiner = höher). */
  private stackTop(grid: number[][] | null): number | null {
    if (!grid) return null;
    for (let y = 0; y < grid.length; y++) {
      if (grid[y].some((v) => v !== 0)) return y;
    }
    return null;
  }

  private pushEvent(a: AiAgent, text: string): void {
    a.lastEvents.push({ at: Date.now(), text });
    if (a.lastEvents.length > 50) a.lastEvents = a.lastEvents.slice(-50);
  }

  /** LLM-lesbare Spielspezifikation + API-Doku. */
  describe(): DescribeResult {
    const specialList = (Object.keys(SPECIALS) as SpecialType[]).map((t) => ({
      type: t,
      name: SPECIALS[t].name,
      description: SPECIALS[t].description,
      polarity: (NEGATIVE_SPECIALS as string[]).includes(t) ? "negativ" as const : "positiv" as const,
    }));

    return {
      game: "Tetrinet3D — ein 6-Spieler-Tetris-Networking-Spiel. Baue dein Feld sauber, räume Zeilen, sammle Special-Buchstaben und setze sie strategisch ein, um Gegner zu stören. Wer zuletzt aktiv ist, gewinnt.",
      grid: { width: GRID_WIDTH, height: GRID_HEIGHT, rows: GRID_HEIGHT, cols: GRID_WIDTH },
      pieces: "7 Tetrominos (I, O, T, S, Z, J, L) mit je 4 Blöcken, 4 Rotationszustände. Steine fallen von oben; bei Kontakt mit dem Boden/Wand fixieren sie sich. Volle Zeilen werden geräumt (Special-Buchstaben darin wandern in dein Inventar).",
      controls: {
        action: "POST /ai/action  body {action: 'LEFT'|'RIGHT'|'ROTATE'|'SOFT_DROP'|'HARD_DROP'}",
        special: "POST /ai/special body {targetIndex: 0–5, specialType: 'A'..'N'}  (0=eigenes Feld, 1–5=Gegner)",
        chat: "POST /ai/chat body {text}",
        rematch: "POST /ai/rematch",
        bots: "POST /ai/bots  body {add?: n, remove?: true, difficulty?}",
      },
      specials: specialList,
      scoring: "Basis × (Level+1): 1 Zeile=40, 2=100, 3=300, 4=1200. Level steigt mit den gelösten Zeilen (10 Zeilen/Level, max 10).",
      winCondition: "Wenn nur noch ein Spieler aktiv ist, gewinnt dieser (Game Over).",
      api: {
        base: "http://localhost:3000",
        endpoints: [
          { method: "GET", path: "/ai/describe", purpose: "Diese Spielbeschreibung + API-Doku." },
          { method: "GET", path: "/ai/agents", purpose: "Alle registrierten KI-Agenten." },
          { method: "POST", path: "/ai/register", purpose: "Neuen Agenten anmelden → {agentId, playerId}." },
          { method: "GET", path: "/ai/status?agent=ID", purpose: "Aktueller Zustand aus der Sicht des Agents." },
          { method: "POST", path: "/ai/action?agent=ID", purpose: "Bewegen/Drehen/Drop." },
          { method: "POST", path: "/ai/special?agent=ID", purpose: "Special abfeuern." },
          { method: "POST", path: "/ai/chat?agent=ID", purpose: "Chat-Nachricht." },
          { method: "POST", path: "/ai/rematch?agent=ID", purpose: "Neue Runde." },
          { method: "DELETE", path: "/ai/agents?agent=ID", purpose: "Agenten entfernen." },
        ],
      },
    };
  }
}

/** MAX_PLAYERS wird hier referenziert, damit die Konstante nicht "unused" wirkt. */
export const AI_MAX_ROOM = MAX_PLAYERS;
