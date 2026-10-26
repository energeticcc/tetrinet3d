/**
 * Reine 2D-Spielfeld-Mathematik (Tetris + Tetrinet-Specials).
 *
 * Diese Modul ist bewusst framework-frei, damit es sowohl auf dem Client
 * (Client-Side Prediction) als auch auf dem Server (Server-Authoritative)
 * identisch laufen kann.
 */
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  isSpecialCell,
  SPECIAL_CHAR_TO_CELL,
  CELL_TO_SPECIAL_CHAR,
} from "../constants.js";
import type { Matrix, ActivePiece, SpecialType } from "../types/index.js";
import { Cell } from "../types/index.js";

/* ------------------------------------------------------------------ */
/* Grundlegende Matrix-Helfer                                          */
/* ------------------------------------------------------------------ */

export function createEmptyGrid(): Matrix {
  return Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(0));
}

/** Erzeugt eine tiefe Kopie einer Matrix. */
export function cloneGrid(grid: Matrix): Matrix {
  return grid.map((row) => row.slice());
}

/** Prüft, ob ein Feld innerhalb der Grid-Grenzen liegt. */
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT;
}

/** Liest einen Zell-Wert (außerhalb = Blocker, d.h. "gefüllt"). */
export function readCell(grid: Matrix, x: number, y: number): number {
  if (!inBounds(x, y)) return 1; // außerhalb zählt als Kollision
  return grid[y][x];
}

/** Schreibt einen Zell-Wert (nur innerhalb der Grenzen). */
export function writeCell(grid: Matrix, x: number, y: number, value: number): void {
  if (inBounds(x, y)) grid[y][x] = value;
}

/* ------------------------------------------------------------------ */
/* Tetromino-Definitionen                                              */
/* ------------------------------------------------------------------ */

/**
 * Tetromino-Formen als 4x4-Bitmaps pro Drehzustand.
 * Jede Form ist ein Array von 4 Rotationen, jeweils ein 4x4-Raster
 * (1 = Block, 0 = leer).
 */
type Shape = number[][];

/**
 * Wandelt 4 Zeilen zu je 4 Bit-Zeichen ("1111") in ein 4x4-Zahlenraster um.
 * 1 = Block, 0 = leer. Leerzeichen werden als 0 behandelt.
 */
function shape(rows: string[]): Shape {
  return rows.map((r) => r.padStart(4, "0").slice(-4).split("").map((c) => (c === "1" ? 1 : 0)));
}

// Jede Tetromino-Farbe (1–7) → **Spawn-Form** (Rotation 0) in der 4×4-Box.
// Die übrigen 3 Rotationszustände werden in `pieceOffsets()` über die
// 90°-Drehung (Pivot = 4×4-Box, md/pieces.md §2) berechnet — dadurch sind
// alle Zustände garantiert konsistent (Formel (x,y)→(3−y,x)).
const SPAWN_SHAPES: Record<number, Shape> = {
  1: shape(["", "1111", "", ""]),   // I
  2: shape(["", "0110", "0110", ""]), // O (2×2)
  3: shape(["", "010", "111", ""]),  // T
  4: shape(["", "011", "110", ""]),  // S
  5: shape(["", "110", "011", ""]),  // Z
  6: shape(["", "100", "111", ""]),  // J
  7: shape(["", "001", "111", ""]),  // L
};

/**
 * Wendet eine 90°-Uhrzeigersinn-Drehung auf eine 4×4-Box an.
 * Pivot: Mitte der 4×4-Box. Koordinaten-Transformation: (x, y) → (3 − y, x).
 * (Keine Float-Fehler — exakte Gitter-Drehung, md/pieces.md §2.)
 */
function rotateShape(m: Shape): Shape {
  const out: Shape = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      // 90°-Uhrzeigersinn: (row=y, col=x) → (row=x, col=3−y).
      if (m[y][x] === 1) out[x][3 - y] = 1;
    }
  }
  return out;
}

/** Liefert die 4 Rotationszustände einer Tetromino (Spawn + 3×90°). */
export function rotations(type: number): Shape[] {
  const spawn = SPAWN_SHAPES[type];
  if (!spawn) return [];
  return [spawn, rotateShape(spawn), rotateShape(rotateShape(spawn)), rotateShape(rotateShape(rotateShape(spawn)))];
}

/** Liefert die Block-Offsets (relative x,y) eines Tetromino in einer Rotation. */
export function pieceOffsets(type: number, rotation: number): Array<[number, number]> {
  const shapeDef = rotations(type);
  if (shapeDef.length === 0) return [];
  const rot = ((rotation % 4) + 4) % 4;
  const matrix = shapeDef[rot];
  const offsets: Array<[number, number]> = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (matrix[y][x] === 1) offsets.push([x, y]);
    }
  }
  return offsets;
}

/* ------------------------------------------------------------------ */
/* Kollision & Bewegung                                                */
/* ------------------------------------------------------------------ */

/**
 * Prüft, ob ein aktives Stück an Position (px, py) mit Rotation kollidiert.
 */
export function collides(grid: Matrix, type: number, rotation: number, px: number, py: number): boolean {
  for (const [ox, oy] of pieceOffsets(type, rotation)) {
    const cx = px + ox;
    const cy = py + oy;
    if (!inBounds(cx, cy)) return true;
    if (grid[cy][cx] !== 0) return true;
  }
  return false;
}

/**
 * Versucht das Stück eine Zelle zu verschieben (x- oder y-Delta).
 * Gibt true zurück, wenn die Bewegung legal war (und `piece` wurde gemutet).
 */
export function tryMove(grid: Matrix, piece: ActivePiece, dx: number, dy: number): boolean {
  if (collides(grid, piece.type, piece.rotation, piece.x + dx, piece.y + dy)) {
    return false;
  }
  piece.x += dx;
  piece.y += dy;
  return true;
}

/** Rotiert das Stück im Uhrzeigersinn (mit einfachem Wall-Kick). */
export function tryRotate(grid: Matrix, piece: ActivePiece): boolean {
  const next = (piece.rotation + 1) % 4;
  const kicks: Array<[number, number]> = [
    [0, 0], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1],
  ];
  for (const [kx, ky] of kicks) {
    if (!collides(grid, piece.type, next, piece.x + kx, piece.y + ky)) {
      piece.rotation = next;
      piece.x += kx;
      piece.y += ky;
      return true;
    }
  }
  return false;
}

/**
 * NACHT 19.6 (ghostpiece-addon.md §2): Berechnet die FINALE Y-Position des
 * aktiven Steins (Hard-Drop-Landepunkt) — pur, ohne das Stück zu mutieren.
 * Rein lokal auf dem Client (keine Netzwerk-Payloads, ghostpiece-addon §3):
 * Der Server validiert den Hard-Drop selbst mit seiner eigenen Feldinstanz.
 */
export function ghostPosition(grid: Matrix, piece: ActivePiece): number {
  let gy = piece.y;
  while (!collides(grid, piece.type, piece.rotation, piece.x, gy + 1)) {
    gy += 1;
  }
  return gy;
}

/**
 * Hard Drop: Stück so weit wie möglich fallen lassen und feststellen.
 * Gibt die Anzahl der gefallenen Zeilen zurück.
 */
export function hardDrop(grid: Matrix, piece: ActivePiece): number {
  let distance = 0;
  while (!collides(grid, piece.type, piece.rotation, piece.x, piece.y + 1)) {
    piece.y += 1;
    distance += 1;
  }
  lockPiece(grid, piece);
  return distance;
}

/** Schreibt das Stück in die Matrix (Blocker-Zeilen werden nicht überschrieben). */
export function lockPiece(grid: Matrix, piece: ActivePiece): void {
  for (const [ox, oy] of pieceOffsets(piece.type, piece.rotation)) {
    writeCell(grid, piece.x + ox, piece.y + oy, piece.type);
  }
}

/**
 * Prüft, ob ein Spawn an der Standard-Position kollidiert (Game Over).
 */
export function spawnCollision(grid: Matrix, type: number): boolean {
  return collides(grid, type, 0, SPAWN_X, SPAWN_Y);
}

/* ------------------------------------------------------------------ */
/* Zeilen-Clear & Score                                                */
/* ------------------------------------------------------------------ */

/**
 * Entfernt volle Zeilen und gibt die Anzahl der gelöschten Zeilen zurück.
 * Neue, leere Zeilen werden oben ergänzt.
 */
export function clearLines(grid: Matrix): number {
  let cleared = 0;
  for (let y = GRID_HEIGHT - 1; y >= 0; y--) {
    if (grid[y].every((v) => v !== 0)) {
      grid.splice(y, 1);
      grid.unshift(Array(GRID_WIDTH).fill(0));
      cleared += 1;
      y++; // Zeile erneut prüfen, da alles nachgerückt ist
    }
  }
  return cleared;
}

/**
 * Tetrinet-Klassik: Zeilen-Clear + Special-Logik (game.md §2).
 *
 *  1. Buchstaben auf einer gelöschten Zeile wandern in das INVENTORY
 *     (max. `maxInventory`; Überschuss wird verworfen).
 *  2. Volle Zeilen werden entfernt.
 * 3. Für jede gelöschte Zeile erscheint ein NEUER Special-Buchstabe, indem
 *     er einen bestehenden Block (Werte 1–7) im Feld ersetzt — Specials
 *     tauchen NICHT frei auf. (wird bei seinem Zeilen-Clear wiederum eingesammelt).
 *
 * Rückgabe: { cleared, collected } — gelöschte Zeilen + neu eingesammelte
 * Specials (für das Inventory).
 */
export function clearLinesAndCollectSpecials(
  grid: Matrix,
  inventoryLength: number,
  maxInventory: number,
  rng: () => number = Math.random,
): { cleared: number; collected: SpecialType[] } {
  const collected: SpecialType[] = [];

  // 1) Vollständige Zeilen (von oben nach unten)
  const fullRows: number[] = [];
  for (let y = 0; y < GRID_HEIGHT; y++) {
    if (grid[y].every((v) => v !== 0)) fullRows.push(y);
  }
  const cleared = fullRows.length;
  if (cleared === 0) return { cleared, collected };

  // 2) Buchstaben in diesen Zeilen einsammeln (bevor die Zeile weg ist).
  // NACHT 19.7 (inventory-addon.md §1.3): MULTIPLIKATOR-Regel — die Anzahl
  // gleichzeitig gelöschter Zeilen bestimmt die Gutschrift JE Special-Block:
  //   Single +1, Double +2, Triple +3, Tetris +4.
  // Volle Queue (maxInventory) → Überlauf verfällt ersatzlos (§1.2).
  for (const y of fullRows) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const v = grid[y][x];
      if (isSpecialCell(v)) {
        const ch = CELL_TO_SPECIAL_CHAR[v];
        if (ch) {
          for (let k = 0; k < cleared; k++) {
            if (inventoryLength + collected.length >= maxInventory) break;
            collected.push(ch);
          }
        }
      }
    }
  }

  // 3) Zeilen entfernen — zuerst ALLE vollen Zeilen von unten nach oben splicen,
  //    dann oben N leere Zeilen einfügen. (In-Loop unshift würde die Indices
  //    der noch zu löschenden Zeilen verschieben und eine volle Zeile übrig lassen.)
  for (const y of fullRows.sort((a, b) => b - a)) {
    grid.splice(y, 1);
  }
  for (let i = 0; i < fullRows.length; i++) {
    grid.unshift(Array(GRID_WIDTH).fill(0));
  }

  // 4) Pro gelöschter Zeile: einen neuen Buchstaben erzeugen, der einen
  //    bestehenden Block ersetzt (nur wenn im unteren 2/3 noch Blocks liegen)
  for (let i = 0; i < cleared; i++) {
    if (rng() < 0.85) {
      const special = rollSpecial(inventoryLength + collected.length, maxInventory, rng);
      if (special) placeSpecialBlock(grid, special, rng);
    }
  }

  return { cleared, collected };
}

/**
 * Erzeugt einen Special-Buchstaben, indem er einen **bereits bestehenden
 * Block** (Tetromino, Werte 1–7) im unteren 2/3 des Felds ersetzt.
 *
 * Specials erscheinen NICHT frei im Feld, sondern setzen sich in bestehende
 * Stacks, sodass sie beim Löschen der Zeile eingesammelt werden.
 * Gibt `false` zurück, wenn im Zielbereich kein Block zum Ersetzen vorhanden ist.
 */
export function placeSpecialBlock(
  grid: Matrix,
  special: SpecialType,
  rng: () => number = Math.random,
): boolean {
  const candidates: Array<[number, number]> = [];
  const minY = Math.floor(GRID_HEIGHT * 0.35);
  for (let y = minY; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const v = grid[y][x];
      if (v !== 0 && !isSpecialCell(v)) candidates.push([y, x]);
    }
  }
  if (candidates.length === 0) return false;
  const [cy, cx] = candidates[Math.floor(rng() * candidates.length)];
  grid[cy][cx] = SPECIAL_CHAR_TO_CELL[special];
  return true;
}

/**
 * TetriNET3D-Scoring (Quelle: md/score.md).
 *
 * Punkte = TETRINET3D_SCORE_BASE[Zeilen] × (Level + 1).
 * Level 0 = x1, Level 1 = x2, … bis **Special Level 10 = x11**.
 *
 * Basiswerte (TETRINET3D_SCORE_BASE):
 *   1 Zeile (Single)  : 40
 *   2 Zeilen (Double) : 100
 *   3 Zeilen (Triple) : 300
 *   4 Zeilen (Tetris) : 1200
 *
 * Beispiel (Level 0): 40 / 100 / 300 / 1200.
 * Beispiel (Level 10): 440 / 1100 / 3300 / 13200.
 */
export const TETRINET3D_SCORE_BASE = {
  baseSingle: 40,
  baseDouble: 100,
  baseTriple: 300,
  baseTetris: 1200,
} as const;

/** Maximales Level für den Score-Multiplikator (inklusive Special-Level 10). */
export const SCORE_MAX_LEVEL = 10;

/**
 * Berechnet die Punkte für gelöschte Zeilen (md/score.md).
 * `lines`: Anzahl gleichzeitig gelöschter Zeilen (1–4, sonst 0).
 * `level`: aktives Level 0…10 (wird geclampt; Multiplikator = level + 1).
 */
export function calculateTetriNet3DScore(lines: number, level: number): number {
  const lvl = Math.min(Math.max(0, level), SCORE_MAX_LEVEL);
  const multiplier = lvl + 1;
  switch (lines) {
    case 1: return TETRINET3D_SCORE_BASE.baseSingle * multiplier;
    case 2: return TETRINET3D_SCORE_BASE.baseDouble * multiplier;
    case 3: return TETRINET3D_SCORE_BASE.baseTriple * multiplier;
    case 4: return TETRINET3D_SCORE_BASE.baseTetris * multiplier;
    default: return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Spawn & Queue (Random Bag)                                          */
/* ------------------------------------------------------------------ */

export const SPAWN_X = 4;
export const SPAWN_Y = 0;

/** Erzeugt ein aktives Stück an der Spawn-Position. */
export function spawnPiece(type: number): ActivePiece {
  return { type, rotation: 0, x: SPAWN_X, y: SPAWN_Y };
}

/** Standard-Tetromino-Set (eine Runde "7-Bag"). */
const BAG_TYPES = [1, 2, 3, 4, 5, 6, 7];

/**
 * Fisher-Yates-Shuffle einer Kopie. `rng` erlaubt deterministische Seeds.
 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Deterministischer PRNG (mulberry32) für seedbare Tetromino-Reihenfolgen.
 */
export function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Erzeugt die nächste N Tetromino-Typen per 7-Bag (kompatibel mit alten Aufrufen). */
export function generateQueue(count: number, rng: () => number = Math.random): number[] {
  const queue: number[] = [];
  while (queue.length < count) {
    queue.push(...shuffle(BAG_TYPES, rng));
  }
  return queue.slice(0, count);
}

/* ------------------------------------------------------------------ */
/* 7-Bag Randomizer (Nacht 16 — Referenz: md/Randomizer.ts)            */
/* ------------------------------------------------------------------ */

/**
 * Klassische 7-Bag-Logik: Jeder der 7 Tetromino-Typen kommt genau **einmal**
 * pro Bag (7 Stücke) vor. Das garantiert eine faire Verteilung und begrenzt
 * die "Dürreperiode" eines bestimmten Steins auf max. 12 Blöcke
 * (2 volle Bags = 14, abzüglich der 2 bereits gezogenen = 12).
 *
 * Die Shuffle-Permutation wird über einen **LCG** (Linear Congruential
 * Generator, POSIX/glibc-Konstanten) erzeugt — deterministisch bei gleichem
 * Seed. Der LCG-Seed wird aus dem Spieler-Seed abgeleitet, sodass Server
 * und Client bei gleichem Seed identische Stück-Reihenfolgen sehen.
 *
 * (Vorlage: md/Randomizer.ts, `TetriNet3DRandomizer`)
 */
export class TetriNet3DRandomizer {
  private bag: number[] = [];
  private allTypes: number[] = [1, 2, 3, 4, 5, 6, 7];
  private lcg: number;

  /**
   * @param seed 32-Bit-Ganzzahl-Seed (deterministisch pro Spieler).
   */
  constructor(seed: number = (Math.random() * 0x7fffffff) | 0) {
    this.lcg = seed >>> 0;
    this.refillBag();
  }

  /**
   * POSIX/glibc LCG: `seed = (seed * 1103515245 + 12345) & 0x7fffffff`.
   * Gibt 0 ≤ r < 1 zurück.
   */
  private next(): number {
    this.lcg = (Math.imul(this.lcg, 1103515245) + 12345) & 0x7fffffff;
    return this.lcg / 0x7fffffff;
  }

  /** Neuer 7-Bag per LCG-basiertem Fisher-Yates-Shuffle. */
  private refillBag(): void {
    this.bag = [...this.allTypes];
    for (let i = this.bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = this.bag[i];
      this.bag[i] = this.bag[j];
      this.bag[j] = t;
    }
  }

  /** Nächstes Stück (Zahl 1–7). Bag wird automatisch aufgefüllt. */
  nextPiece(): number {
    if (this.bag.length === 0) this.refillBag();
    return this.bag.pop()!;
  }

  /** Deterministische Zufallszahl (0 ≤ r < 1) aus dem LCG — z. B. für Special-Placement. */
  random(): number {
    return this.next();
  }

  /** Blick in die Zukunft (ohne State zu verändern) — für die Next-Preview. */
  peek(count: number): number[] {
    const out: number[] = [];
    const bag = [...this.bag];
    const seed = this.lcg;
    for (let i = 0; i < count; i++) {
      if (bag.length === 0) {
        const fresh = [...this.allTypes];
        for (let k = fresh.length - 1; k > 0; k--) {
          const r = (seed * 1103515245 + 12345) & 0x7fffffff;
          const j = Math.floor((r / 0x7fffffff) * (k + 1));
          const t = fresh[k]; fresh[k] = fresh[j]; fresh[j] = t;
        }
        bag.push(...fresh);
      }
      out.push(bag.pop()!);
    }
    return out;
  }

  /** State zurücksetzen (z. B. bei Rematch). */
  reset(seed: number): void {
    this.lcg = seed >>> 0;
    this.refillBag();
  }
}

/* ------------------------------------------------------------------ */
/* Tetrinet-Specials (2D-Matrix-Manipulation)                          */
/* ------------------------------------------------------------------ */

/**
 * Führt die reine Matrix-Manipulation eines Specials auf dem Zielfeld aus.
 * Die Matrix wird IN PLACE gemutet. Rückgabe: true wenn erfolgreich.
 */
export function applySpecialToGrid(grid: Matrix, type: SpecialType, rng: () => number = Math.random): boolean {
  switch (type) {
    case "A": {
      // Add Line (md/specials.md): unten eine UNVOLLSTÄNDIGE Zeile hinzufügen
      // (ca. 80% befüllt, 20% Lücken), oberste Zeile fällt weg.
      const newLine: number[] = new Array(GRID_WIDTH).fill(1);
      // ~20% Lücken (zufällig) — Zeile bleibt lösbar
      for (let i = 0; i < GRID_WIDTH; i++) if (rng() < 0.2) newLine[i] = 0;
      // Sicherstellen, dass die Zeile nicht voll wird (sonst sofort Game-Over)
      if (newLine.every((v): boolean => v === 1)) newLine[Math.floor(rng() * GRID_WIDTH)] = 0;
      grid.shift();
      grid.push(newLine);
      return true;
    }

    case "C": {
      // Clear Line: unterste Zeile entfernen, oben leere Zeile ergänzen
      grid.pop();
      grid.unshift(Array(GRID_WIDTH).fill(0));
      // Alle Blöcke danach nachrücken (Gravity auf die Zeile anwenden)
      return true;
    }

    case "B": {
      // Clear Specials: alle Special-Blöcke in normale (graue) Blöcke verwandeln
      for (let y = 0; y < GRID_HEIGHT; y++) {
        for (let x = 0; x < GRID_WIDTH; x++) {
          if (isSpecialCell(grid[y][x])) grid[y][x] = 0;
        }
      }
      return true;
    }

    case "R": {
      // Random Blocks Clear: 10 zufällige Blöcke entfernen
      const filled: Array<[number, number]> = [];
      for (let y = 0; y < GRID_HEIGHT; y++) {
        for (let x = 0; x < GRID_WIDTH; x++) {
          if (grid[y][x] !== 0) filled.push([y, x]);
        }
      }
      const count = Math.min(10, filled.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(rng() * filled.length);
        const [y, x] = filled.splice(idx, 1)[0];
        grid[y][x] = 0;
      }
      return true;
    }

    case "O": {
      // Block Bomb: alle "O"-Blöcke (Zell-Code 2) finden und 3x3 explodieren
      const oBlocks: Array<[number, number]> = [];
      for (let y = 0; y < GRID_HEIGHT; y++) {
        for (let x = 0; x < GRID_WIDTH; x++) {
          if (grid[y][x] === 2) oBlocks.push([y, x]);
        }
      }
      const radius = 3;
      for (const [cy, cx] of oBlocks) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            writeCell(grid, cx + dx, cy + dy, 0);
          }
        }
      }
      return true;
    }

    case "S": {
      // Switch Fields: DAS EIGENE Feld wird mit dem Zielfeld getauscht.
      // Braucht BEIDE Grids → wird auf Raum-Ebene per swapGridContents() abgewickelt.
      // Hier: bewusst kein Einzel-Grid-Effekt.
      return false;
    }

    case "G": {
      // Block Gravity: alle Blöcke nach unten rutschen lassen
      for (let x = 0; x < GRID_WIDTH; x++) {
        const column: number[] = [];
        for (let y = GRID_HEIGHT - 1; y >= 0; y--) {
          if (grid[y][x] !== 0) column.push(grid[y][x]);
        }
        for (let y = GRID_HEIGHT - 1; y >= 0; y--) {
          grid[y][x] = column[GRID_HEIGHT - 1 - y] ?? 0;
        }
      }
      return true;
    }

    case "Q": {
      // Quake: jede Zeile zufällig links/rechts verschieben
      for (let y = 0; y < GRID_HEIGHT; y++) {
        const shift = Math.floor(rng() * 5) - 2; // -2..+2
        if (shift === 0) continue;
        const row = grid[y].slice();
        if (shift > 0) {
          for (let x = 0; x < GRID_WIDTH - shift; x++) grid[y][x] = row[x + shift];
          for (let x = GRID_WIDTH - shift; x < GRID_WIDTH; x++) grid[y][x] = 0;
        } else {
          const s = -shift;
          for (let x = s; x < GRID_WIDTH; x++) grid[y][x] = row[x - s];
          for (let x = 0; x < s; x++) grid[y][x] = 0;
        }
      }
      return true;
    }

    case "N": {
      // Nuke: komplettes Feld löschen
      for (let y = 0; y < GRID_HEIGHT; y++) {
        for (let x = 0; x < GRID_WIDTH; x++) grid[y][x] = 0;
      }
      return true;
    }

    default:
      return false;
  }
}

/** Die 9 möglichen Special-Buchstaben. */
export const SPECIAL_TYPES: SpecialType[] = ["A", "B", "C", "R", "O", "S", "G", "Q", "N"];

/**
 * Tauscht den INHALT zweier Spielfelder (Special "S" — Switch Fields, game.md §2).
 * Beide Matrizen behalten ihre Größe (12x22), nur die Zellen werden getauscht.
 * IN PLACE (die Array-Referenzen bleiben gleich, damit der Room sie weiter nutzen kann).
 */
export function swapGridContents(a: Matrix, b: Matrix): void {
  const n = Math.min(a.length, b.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const tmp = a[y][x];
      a[y][x] = b[y][x];
      b[y][x] = tmp;
    }
  }
}

/**
 * Nacht 18.1 (attack-addlines.md §3): Hängt `count` Garbage-Linien ans
 * UNTERE Ende eines Spielfelds an. Jede Zeile besteht aus 11 grauen
 * Blöcken (Cell.GARBAGE=8) + genau 1 Loch (leere Zelle). Die Loch-Position
 * wird für JEDE Zeile separat zufällig berechnet (attack-addlines.md §3:
 * "Die Löcher müssen versetzt generiert werden").
 *
 * Das oberste Element fällt weg (Feld bleibt 12x22). IN PLACE (Array-Referenz
 * bleibt gleich, damit der Room sie weiter nutzen kann).
 *
 * `rng` ist injizierbar für deterministische Tests.
 */
export function addGarbageLines(grid: Matrix, count: number, rng: () => number = Math.random): void {
  if (count <= 0) return;
  for (let i = 0; i < count; i++) {
    // Feld um 1 Zeile "nach oben schieben": oberste Zeile entfernen
    grid.shift();
    // Neue Grauzelle mit genau 1 Loch am unteren Ende
    const line: number[] = new Array(GRID_WIDTH).fill(Cell.GARBAGE);
    const hole = Math.floor(rng() * GRID_WIDTH);
    line[hole] = 0;
    grid.push(line);
  }
}

/**
 * Wirft ein zufälliges Special (Tetrinet-Klassik: nach gelöschten Zeilen
 * erscheint ein Buchstabe im Feld). Gibt null zurück, wenn `inventoryLength`
 * bereits `maxInventory` erreicht (kein Platz mehr im Inventory).
 */
export function rollSpecial(
  inventoryLength: number,
  maxInventory: number,
  rng: () => number = Math.random,
): SpecialType | null {
  if (inventoryLength >= maxInventory) return null;
  return SPECIAL_TYPES[Math.floor(rng() * SPECIAL_TYPES.length)];
}

/** Mappt ein Special auf seinen Zell-Code (zur Anzeige im Feld). */
export function specialToCell(type: SpecialType): number {
  return SPECIAL_CHAR_TO_CELL[type];
}

/** Ist ein Zell-Wert ein regulärer Block (Tetromino) oder leer? */
export function isSolidCell(value: number): boolean {
  return value !== 0;
}
