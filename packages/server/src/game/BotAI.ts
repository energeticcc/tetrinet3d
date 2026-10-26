/**
 * Bot-KI (server-seitig, Server-Authoritative).
 *
 * Ein BotAI "besitzt" einen Player und steuert ihn:
 *  - Rechnet die optimale Plazierung (x, rotation) aus (Holes/Height/Lines).
 *  - Führt sie als Aktionssequenz (ROTATE/LEFT/RIGHT/HARD_DROP) aus.
 *  - Der "Skill" der Stufe entscheidet, wie oft optimal vs. zufällig gewählt
 *    wird und wie viele Aktionen pro Sekunde ausgeführt werden (Reaktionstempo).
 *  - Feuert aggressiv Specials auf Gegner ab (Aggressivität pro Stufe).
 *
 * Das Entscheidungs-RNG ist pro Bot seedbar → nachvollziehbares Verhalten.
 */
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  SPAWN_X,
  collides,
  hardDrop,
  cloneGrid,
} from "@tetrinet3d/shared";
import type {
  BotDifficulty,
  PlayerAction,
  Matrix,
  SpecialType,
} from "@tetrinet3d/shared";
import { Player } from "./Player.js";

/** pro Stufe: Reaktionstempo, Skill (0–1), Special-Aggressivität, Mindest-Inventar. */
export interface BotPreset {
  label: string;
  actionsPerSec: number;
  skill: number;
  specialAggr: number;
  specialMinInv: number;
}

export const BOT_PRESETS: Record<BotDifficulty, BotPreset> = {
  too_young: { label: "I'm too young to die", actionsPerSec: 3, skill: 0.28, specialAggr: 0.08, specialMinInv: 3 },
  not_rough: { label: "Hey, not too rough", actionsPerSec: 5, skill: 0.45, specialAggr: 0.12, specialMinInv: 2 },
  hurt_me: { label: "Hurt me plenty", actionsPerSec: 8, skill: 0.62, specialAggr: 0.22, specialMinInv: 2 },
  ultraviolence: { label: "Ultraviolence", actionsPerSec: 12, skill: 0.78, specialAggr: 0.35, specialMinInv: 1 },
  nightmare: { label: "Nightmare!", actionsPerSec: 20, skill: 0.9, specialAggr: 0.55, specialMinInv: 1 },
  ultra_nightmare: { label: "Ultra-Nightmare!", actionsPerSec: 40, skill: 0.98, specialAggr: 0.8, specialMinInv: 1 },
};

/** Von der Room bereitgestellter Kontext für einen Bot-Tick. */
export interface BotContext {
  opponents: { id: string; name: string; height: number }[];
  fireSpecial: (targetId: string, type: SpecialType) => void;
}

/**
 * Ein intelligenter Spieler-Bot. Die Room erzeugt Instanzen und ruft
 * `update(elapsedMs, ctx)` in jeder Game-Loop-Iteration auf.
 */
export class BotAI {
  readonly player: Player;
  readonly id: string;
  name: string;
  difficulty: BotDifficulty;

  private rng: () => number;
  private actionQueue: PlayerAction[] = [];
  private plannedFor = "";
  private specialAcc = 0;

  constructor(id: string, name: string, seed: number, difficulty: BotDifficulty) {
    this.id = id;
    this.name = name;
    this.difficulty = difficulty;
    this.player = new Player(id, name, seed);

    // Eigenes, vom Queue-RNG unabhängiges Entscheidungs-RNG.
    let s = (seed ^ 0x9e3779b9) >>> 0;
    this.rng = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s >>> 0) / 4294967296;
    };
  }

  setDifficulty(d: BotDifficulty): void {
    this.difficulty = d;
  }

  /** Rematch: Plan & Timer zurücksetzen. */
  reset(): void {
    this.actionQueue = [];
    this.plannedFor = "";
    this.specialAcc = 0;
  }

  /** Ein KI-Tick. `elapsedMs` seit letztem Tick (≈50ms). */
  update(elapsedMs: number, ctx: BotContext): void {
    const preset = BOT_PRESETS[this.difficulty];
    const piece = this.player.activePiece;

    // 1) Neues Stück erkannt (oben am Spawn)? → einmalig eine Plazierung planen.
    if (piece && piece.y <= 1) {
      const key = `${piece.type}:${piece.rotation}:${piece.y}`;
      if (this.actionQueue.length === 0 && key !== this.plannedFor) {
        this.plannedFor = key;
        this.actionQueue = this.plan(this.player.grid, piece.type);
      }
    } else if (!piece) {
      this.actionQueue = [];
    }

    // 2) Ausstehende Aktionen nach Reaktions-Tempo der Stufe drosseln.
    if (this.actionQueue.length > 0 && this.player.status === "active") {
      const prob = Math.min(1, (preset.actionsPerSec * elapsedMs) / 1000);
      if (this.rng() < prob) {
        const action = this.actionQueue.shift();
        if (action) this.player.handleAction(action);
      }
    }

    // 3) Specials abfeuern (Sekundentakt).
    this.specialAcc += elapsedMs;
    while (this.specialAcc >= 1000) {
      this.specialAcc -= 1000;
      this.maybeFireSpecial(preset, ctx);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Plazierungs-KI                                                      */
  /* ------------------------------------------------------------------ */

  /** Erzeugt die Aktionssequenz, um das aktuelle Stück (an Spawn) abzustellen. */
  private plan(grid: Matrix, type: number): PlayerAction[] {
    const preset = BOT_PRESETS[this.difficulty];
    const all = this.enumeratePlacements(grid, type);
    if (all.length === 0) return [];

    let choice: { x: number; rotation: number; score: number };
    if (this.rng() < preset.skill) {
      choice = all.reduce((a, b) => (b.score > a.score ? b : a));
    } else {
      choice = all[Math.floor(this.rng() * all.length)];
    }

    const seq: PlayerAction[] = [];
    let rot = 0;
    const targetRot = ((choice.rotation % 4) + 4) % 4;
    while (rot < targetRot) {
      seq.push("ROTATE");
      rot++;
    }
    const dx = choice.x - SPAWN_X;
    if (dx > 0) for (let i = 0; i < dx; i++) seq.push("RIGHT");
    else for (let i = 0; i < -dx; i++) seq.push("LEFT");
    seq.push("HARD_DROP");
    return seq;
  }

  /** Alle legalen Abstell-Positionen (x, rotation) evaluieren. */
  private enumeratePlacements(
    grid: Matrix,
    type: number,
  ): { x: number; rotation: number; score: number }[] {
    const results: { x: number; rotation: number; score: number }[] = [];
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let x = -6; x <= GRID_WIDTH + 6; x++) {
        const g = cloneGrid(grid);
        const piece = { type, rotation, x, y: 0 };
        if (collides(g, type, rotation, x, 0)) continue;
        hardDrop(g, piece);
        results.push({ x, rotation, score: this.scoreGrid(g) });
      }
    }
    return results;
  }

  /** Heuristischer Score eines abgestellten Felds (höher = besser). */
  private scoreGrid(grid: Matrix): number {
    let lines = 0;
    let holes = 0;
    let bumpy = 0;
    let height = 0;
    const cols: number[] = [];
    for (let x = 0; x < GRID_WIDTH; x++) {
      let top = GRID_HEIGHT;
      for (let y = 0; y < GRID_HEIGHT; y++) {
        if (grid[y][x] !== 0) {
          top = y;
          break;
        }
      }
      const h = GRID_HEIGHT - top;
      cols.push(h);
      height += h;
      if (top < GRID_HEIGHT) {
        for (let y = top + 1; y < GRID_HEIGHT; y++) if (grid[y][x] === 0) holes++;
      }
    }
    for (let x = 0; x < GRID_WIDTH - 1; x++) bumpy += Math.abs(cols[x] - cols[x + 1]);
    for (let y = 0; y < GRID_HEIGHT; y++) if (grid[y].every((v) => v !== 0)) lines++;
    return lines * 100 - holes * 8 - height - bumpy * 2;
  }

  /* ------------------------------------------------------------------ */
  /* Special-Auswahl (offensiv)                                          */
  /* ------------------------------------------------------------------ */

  private maybeFireSpecial(preset: BotPreset, ctx: BotContext): void {
    const inv = this.player.specialsInventory;
    if (inv.length < preset.specialMinInv) return;
    if (this.rng() > preset.specialAggr) return;

    const targets = ctx.opponents.filter((o) => o.id !== this.id);
    if (targets.length === 0) return;
    targets.sort((a, b) => b.height - a.height);
    const target = targets[0];

    // Nur feuern, wenn das Ziel gefährdet ist (oder Bot sehr aggressiv).
    const threatened = target.height >= GRID_HEIGHT * 0.45;
    if (!threatened && this.rng() > preset.specialAggr * 0.5) return;

    // NACHT 19.7 (inventory-addon.md §1.1): STRIKTES FIFO — Bots dürfen nur
    // das Front-Special (Index 0) wählen; keine Prioritäts-Auswahl mehr.
    const choice = inv[0];
    if (choice) ctx.fireSpecial(target.id, choice);
  }
}

/** Höhe (oberste besetzte Zeile, 0 = leer) eines Felds. */
export function gridHeight(grid: Matrix): number {
  for (let y = 0; y < GRID_HEIGHT; y++) {
    if (grid[y].some((v) => v !== 0)) return GRID_HEIGHT - y;
  }
  return 0;
}
