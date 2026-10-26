import {
  MAX_SPECIALS,
  getTimings,
  calculateTetriNet3DScore,
  clearLinesAndCollectSpecials,
  createEmptyGrid,
  TetriNet3DRandomizer,
  levelFromLines,
  lockPiece,
  hardDrop,
  collides,
  spawnCollision,
  spawnPiece,
  tryMove,
  tryRotate,
} from "@tetrinet3d/shared";
import type {
  ActivePiece,
  Matrix,
  PlayerAction,
  PlayerStatus,
  SpecialType,
  TeamId,
} from "@tetrinet3d/shared";

/**
 * Server-seitiger Zustand eines einzelnen Spielers.
 * Hält Grid, aktives Stück, Queue und Special-Inventory und führt die
 * 20Hz-Fall-Physik (Server-Authoritative) aus.
 */
export class Player {
  readonly id: string;
  name: string;

  grid: Matrix;
  activePiece: ActivePiece | null = null;
  queue: number[] = [];

  specialsInventory: SpecialType[] = [];
  status: PlayerStatus = "active";
  score = 0;
  /**
   * Nacht 18: Team-Kennung (nur im Team-Modus, sonst undefined).
   * Wird vom Raum beim (Neu-)Zuteilen der Teams gesetzt (assignTeams).
   */
  team: TeamId | undefined = undefined;

  /** ms seit letztem Auto-Drop (für die Fall-Physik). */
  private dropAccumulator = 0;
  /**
   * Aktuelle Fall-Intervall (ms). Steigt mit dem RAUM-LEVEL (levels.md).
   * Initial: Level 0 = 800ms. Wird vom GameLoop pro Tick aus dem
   * berechneten Raum-Level gesetzt (getTimings("CLASSIC", roomLevel).tickMs).
   */
  public dropInterval: number = 800;
  /**
   * 7-Bag-Randomizer (Nacht 16, md/Randomizer.ts): deterministisch pro Spieler
   * (Seed = Spieler-ID), Server-Authoritative. Client nutzt den gleichen Seed
   * für Client-Side-Prediction (wenn nötig) — aktuell nur Server.
   */
  private bag: TetriNet3DRandomizer;
  /**
   * Nacht 18.1 (attack-addlines.md): Callback an den Raum, wenn der Spieler
   * 2+ Zeilen gleichzeitig gelöscht hat. Der Room verteilt die Garbage-Linien
   * an alle aktiven Spieler AUSSERHALB des eigenen Teams.
   * Wird in `addPlayer`/`spawnBots` gesetzt.
   */
  public onClearedLines: ((cleared: number) => void) | null = null;

  /** Individuelles Spieler-Level (aus gelöschten Zeilen, levels.md). */
  level = 0;
  /** Gesammelte gelöschte Zeilen dieses Spiels (für das Level-System). */
  linesCleared = 0;

  constructor(id: string, name: string, seed: number) {
    this.id = id;
    this.name = name;
    this.grid = createEmptyGrid();
    this.bag = new TetriNet3DRandomizer(seed);
    this.queue = this.nextQueue(5);
    // Level-0-Geschwindigkeit (Tetrinet-Klassik: 800ms/Zeile)
    this.dropInterval = getTimings("CLASSIC", 0).tickMs;
    this.nextPiece();
  }

  /**
   * Holt die nächsten N Stück-Typen aus dem 7-Bag (Nacht 16).
   * Ersetzt `generateQueue(N, rng)` — der Bag-Algorithmus ist jetzt Teil der
   * TetriNet3DRandomizer-Klasse (deterministisch + faire Verteilung).
   */
  private nextQueue(count: number): number[] {
    return Array.from({ length: count }, () => this.bag.nextPiece());
  }

  /** Holt das nächste Stück aus der Queue und spawnt es. */
  private nextPiece(): void {
    const type = this.queue.shift();
    if (type === undefined) {
      // Queue auffüllen (deterministisch via 7-Bag-Randomizer)
      this.queue = this.nextQueue(7);
      const fallback = this.queue.shift();
      if (fallback === undefined) return;
      this.activePiece = spawnPiece(fallback);
      return;
    }
    // Game Over Check: kein Platz beim Spawn?
    if (spawnCollision(this.grid, type)) {
      this.status = "spectator";
      this.activePiece = null;
      return;
    }
    this.activePiece = spawnPiece(type);
    // Queue wieder auffüllen (gleicher RNG-Stream)
    this.queue.push(...this.nextQueue(1));
  }

  /**
   * Ein Tick der Server-Physik (alle TICK_MS).
   */
  tick(elapsedMs: number): { gridChanged: boolean; locked: boolean } {
    // SAFETY-NET (Nacht 16.1): Spieler ist aktiv, hat aber KEIN aktives Stück.
    // Das ist ein Stall-Zustand (z. B. wenn `afterLock`/`nextPiece` aus irgendeinem
    // Grund ein Stück nicht gespawnt hat). Ohne diesen Check würde der Spieler
    // für IMMER eingefroren bleiben (nichts spawnt neu). Wir spawnen hier den
    // nächsten Stein und fangen jede Exception ab, die der Spawn werfen könnte.
    if (this.status === "active" && !this.activePiece) {
      try {
        this.nextPiece();
      } catch {
        // Spawn fehlgeschlagen (z. B. Spawn-Collision) — Status wird in
        // nextPiece() auf "spectator" gesetzt, wenn das Feld voll ist.
      }
      return { gridChanged: false, locked: false };
    }

    if (this.status !== "active" || !this.activePiece) {
      return { gridChanged: false, locked: false };
    }

    // Schutz: nach Tab-Wechsel nicht hunderte Zeilen auf einmal fallen lassen
    const dt = Math.min(elapsedMs, 250);
    this.dropAccumulator += dt;
    let locked = false;

    // NACHT 20 (TETRIFAST): dropInterval = 0 → KEIN Auto-Fall. Das Stück
    // bleibt stehen, bis der Spieler SOFT_DROP/HARD_DROP drückt.
    // (Schützt vor Endlosschleife: while(acc >= 0 && ...) würde unendlich drehen.)
    if (this.dropInterval > 0) {
    while (this.dropAccumulator >= this.dropInterval && this.activePiece) {
      this.dropAccumulator -= this.dropInterval;
      if (tryMove(this.grid, this.activePiece, 0, 1)) {
        // weiter unten, OK
      } else {
        // Blockiert -> feststellen
        lockPiece(this.grid, this.activePiece);
        this.afterLock();
        locked = true;
        break;
      }
    }
    } // NACHT 20: end of `if (this.dropInterval > 0)` — TETRIFAST: kein Auto-Fall.

    return { gridChanged: true, locked };
  }

  /** Verarbeitet eine Spieler-Eingabe (Server-Validierung). */
  handleAction(action: PlayerAction): boolean {
    if (this.status !== "active" || !this.activePiece) return false;
    let changed = false;

    switch (action) {
      case "LEFT":
        changed = tryMove(this.grid, this.activePiece, -1, 0);
        break;
      case "RIGHT":
        changed = tryMove(this.grid, this.activePiece, 1, 0);
        break;
      case "ROTATE":
        changed = tryRotate(this.grid, this.activePiece);
        break;
      case "SOFT_DROP":
        if (tryMove(this.grid, this.activePiece, 0, 1)) {
          this.score += 1;
          this.dropAccumulator = 0; // Drop-Intervall zurücksetzen
          changed = true;
        }
        break;
      case "HARD_DROP": {
        const dist = hardDrop(this.grid, this.activePiece);
        this.score += dist * 2;
        this.afterLock();
        changed = true;
        break;
      }
    }
    return changed;
  }

  /**
   * Nach dem Feststellen eines Blocks (Tetrinet-Klassik, game.md §2):
   *  1. Zeilen-Clear → Buchstaben auf gelöschten Zeilen wandern ins Inventory.
   *  2. Score.
   *  3. Neue Special-Buchstaben erscheinen im Feld (bei 85% pro Zeile).
   *  4. Fallgeschwindigkeit steigt leicht.
   */
  /**
   * Nacht 18.1: gibt die Anzahl gleichzeitig gelöschter Zeilen zurück
   * (0 = kein Clear, 1-4 = Single/Double/Triple/Tetris). Der Raum nutzt
   * diesen Wert, um Garbage-Linien an Gegner-Teams zu verteilen
   * (attack-addlines.md §1: 1 Zeile → 0 Garbage, 2→1, 3→2, 4→4).
   */
  private afterLock(): number {
    // NIGHT-16.1: Clear-/Special-Logik kann in Edge-Cases werfen. Wenn hier
    // eine Exception durchgeht, würde `nextPiece()` NIE laufen → der Spieler
    // friert ein (kein aktives Stück, Status aktiv). Deshalb isolieren wir die
    // "feinen" Effekte und stellen sicher, dass der NEUE STEIN IMMER spawnt.
    let cleared = 0;
    let collected: SpecialType[] = [];
    try {
      const res = clearLinesAndCollectSpecials(
        this.grid,
        this.specialsInventory.length,
        MAX_SPECIALS,
        () => this.bag.random(), // deterministisch via 7-Bag-LCG (Nacht 16)
      );
      cleared = res.cleared;
      collected = res.collected;
    } catch {
      // Clear-Logik fehlgeschlagen → Feld bleibt, wie es ist. Spiel läuft weiter.
    }

    try {
      if (cleared > 0) {
        // Score (md/score.md): Basiswert × (Level + 1), Level 0–10.
        this.score += calculateTetriNet3DScore(cleared, this.level);
        // Gesammelte Specials ins Inventory (max. MAX_SPECIALS)
        for (const sp of collected) {
          if (this.specialsInventory.length < MAX_SPECIALS) {
            this.specialsInventory.push(sp);
          }
        }
        this.linesCleared += cleared;
        this.level = levelFromLines(this.linesCleared, 0);
      }
    } catch {
      // Score-/Level-Fehler dürfen das Spiel nicht stoppen.
    }

    this.dropAccumulator = 0;
    try {
      this.nextPiece(); // ← MUST: neues Stück (sonst Stall → Safety-Net in tick())
    } catch {
      // nextPiece warf (Spawn-Collision) → Status wird auf "spectator" gesetzt.
    }

    // Nacht 18.1: Anzahl gelöschter Zeilen an den Raum melden, damit er
    // Garbage-Linien an die Gegner-Teams verteilen kann (attack-addlines.md).
    // NUR bei 2+ Zeilen (1 Zeile = 0 Garbage, attack-addlines.md §1).
    if (cleared >= 2 && this.onClearedLines) {
      try { this.onClearedLines(cleared); } catch { /* darf nicht crashen */ }
    }
    return cleared;
  }

  /**
   * Nach einem Special: Falls das aktive Stück jetzt mit dem geänderten
   * Feld kollidiert (z.B. Add Line schiebt alles nach oben), sofort feststellen.
   */
  settleIfColliding(): void {
    if (this.status !== "active" || !this.activePiece) return;
    const p = this.activePiece;
    if (
      collides(this.grid, p.type, p.rotation, p.x, p.y)
    ) {
      lockPiece(this.grid, p);
      this.afterLock();
    }
  }

  /**
   * Reset für Rematch: leeres Feld, Score/Inventory zurück, Status aktiv,
   * frische Queue aus dem gleichen (deterministischen) RNG-Stream.
   */
  reset(): void {
    this.grid = createEmptyGrid();
    this.queue = this.nextQueue(5);
    this.specialsInventory = [];
    this.status = "active";
    this.score = 0;
    this.linesCleared = 0;
    this.level = 0;
    this.dropAccumulator = 0;
    this.dropInterval = getTimings("CLASSIC", 0).tickMs;
    this.activePiece = null;
    this.nextPiece();
  }

  /** Ist das Feld noch bespielbar? */
  get isActive(): boolean {
    return this.status === "active";
  }
}

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

/** Deterministischer Seed aus einer (willkürlichen) Spieler-ID. */
function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
