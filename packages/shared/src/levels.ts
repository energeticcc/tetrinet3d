/**
 * Tetrinet-Levels & Fallgeschwindigkeit (Quelle: md/levels.md).
 *
 * Reine, framework-freie Logik — läuft identisch auf Client & Server.
 *
 * Kern-Idee (Tetrinet-Klassik):
 *  - Jeder Spieler hat ein INDIVIDUELLES Level (steigt alle 10 gelöschten Zeilen).
 *  - Das RAUM-LEVEL ("Active Level") ist der gerundete Durchschnitt aller Spieler.
 *  - Die Fallgeschwindigkeit hängt vom Raum-Level ab (0–9).
 *  - Im TETRIFAST-Modus gibt es keine künstliche Verzögerung (Sofort-Fall).
 */

export type GameMode = "CLASSIC" | "TETRIFAST";

export interface GameConfig {
  mode: GameMode;
  /** Start-Level des Raums (0–9). */
  startLevel: number;
}

/** Höchstmögliches Level. */
export const MAX_LEVEL = 9;

/** Zeilen pro Level-Up (Tetrinet-Klassik: alle 10 Zeilen). */
export const LINES_PER_LEVEL = 10;

/**
 * Original-Tetrinet-Timings pro Raum-Level (0–9).
 * `tickMs`: ms pro Zeile (Fallgeschwindigkeit).
 * `lockDelayMs`: ms Lock-Delay nach dem Aufkommen/Fall.
 */
export const CLASSIC_SPEEDS: Record<number, { tickMs: number; lockDelayMs: number }> = {
  0: { tickMs: 800, lockDelayMs: 500 },
  1: { tickMs: 720, lockDelayMs: 480 },
  2: { tickMs: 630, lockDelayMs: 450 },
  3: { tickMs: 550, lockDelayMs: 420 },
  4: { tickMs: 470, lockDelayMs: 380 },
  5: { tickMs: 380, lockDelayMs: 350 },
  6: { tickMs: 300, lockDelayMs: 300 },
  7: { tickMs: 220, lockDelayMs: 250 },
  8: { tickMs: 130, lockDelayMs: 200 },
  9: { tickMs: 50, lockDelayMs: 100 }, // Level 9 ist extrem knackig
};

/** Klemmt einen Level-Wert in 0…MAX_LEVEL. */
export function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(0, level));
}

/**
 * Individuelles Spieler-Level aus gelöschten Zeilen.
 * Klassisch: alle 10 Zeilen ein Level (ab `startLevel`).
 */
export function levelFromLines(linesCleared: number, startLevel: number): number {
  return clampLevel(startLevel + Math.floor(linesCleared / LINES_PER_LEVEL));
}

/**
 * Raum-Level = gerundeter Durchschnitt der individuellen Spieler-Level.
 * Leere Liste → `fallback` (Start-Level).
 */
export function activeLevel(playerLevels: number[], fallback = 0): number {
  if (playerLevels.length === 0) return clampLevel(fallback);
  const total = playerLevels.reduce((a, b) => a + b, 0);
  return clampLevel(Math.round(total / playerLevels.length));
}

/**
 * Exakte Timing-Werte für einen Raum-Level + Modus (an die Clients).
 * TETRIFAST: sofortiger Fall (0ms) — Tastatur-Repeat übernimmt.
 */
export function getTimings(mode: GameMode, activeLevelValue: number): { tickMs: number; lockDelayMs: number } {
  if (mode === "TETRIFAST") return { tickMs: 0, lockDelayMs: 0 };
  return CLASSIC_SPEEDS[clampLevel(activeLevelValue)] ?? CLASSIC_SPEEDS[0];
}

/** Kurze, menschenlesbare Tempo-Beschreibung (z.B. "630ms/Zeile"). */
export function describeTimings(mode: GameMode, activeLevelValue: number): string {
  if (mode === "TETRIFAST") return "TETRIFAST · sofortiger Fall";
  const t = getTimings(mode, activeLevelValue);
  return `Lvl ${activeLevelValue} · ${t.tickMs}ms/Zeile`;
}
