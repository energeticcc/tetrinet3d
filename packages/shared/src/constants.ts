import type { SpecialType, TeamMode, TeamId } from "./types/index.js";

/** Spielfeld-Geometrie (Tetrinet-Standard). */
export const GRID_WIDTH = 12;
export const GRID_HEIGHT = 22;
/** Oberste Zeilen, die als Puffer/Spawn dienen. */
export const BUFFER_ROWS = 2;

/** Netzwerk / Physik. */
export const TICK_RATE_HZ = 20; // 20mal pro Sekunde
export const TICK_MS = 1000 / TICK_RATE_HZ; // 50ms
/** Fallgeschwindigkeit: ms pro Zeile (Basis, steigt mit Level). */
export const BASE_DROP_INTERVAL_MS = 650;

/**
 * Inventory-Kapazität (inventory-addon.md §1.2): Harte Obergrenze der
 * FIFO-Queue. Volle Queue → jedes weitere gesammelte Special verfällt sofort
 * (ersatzlos, keine Zwischenlagerung).
 */
export const MAX_SPECIALS = 18;
/** Maximale Spieler pro Raum (6-Player-Arena). */
export const MAX_PLAYERS = 6;

/**
 * Nacht 18.1: Garbage-Linien-Matrix (attack-addlines.md §1).
 * Bei gleichzeitiger Löschung von N Zeilen wird an JEDE aktives Gegner-Team
 * diese Anzahl an Straflinien gesendet. 1 Zeile = 0 Garbage (kein Angriff).
 *   2 (Double)  → 1
 *   3 (Triple)  → 2
 *   4 (Tetris)  → 4
 */
export const GARBAGE_LINES: Record<number, number> = {
  1: 0,
  2: 1,
  3: 2,
  4: 4,
};

/**
 * Nacht 18: Team-Modi.
 *  - "solo"  : kein Team, letzter aktiver Spieler gewinnt.
 *  - "team2" : Teams zu 2 (bis zu 3 Teams à 2 = 6 Spieler).
 *  - "team3" : Teams zu 3 (2 Teams à 3 = 6 Spieler).
 * Team-Zuweisung = Beitrittsreihenfolge (1. Spieler → Team A, usw.).
 * Gewinnt das Team, dessen LETZTER aktiver Spieler übrig bleibt.
 */
export const TEAM_SIZE: Record<TeamMode, number> = {
  solo: 0,
  team2: 2,
  team3: 3,
};

/** Anzeigename + Team-Farbe pro Team-ID (dunkle UI, leuchtende Akzente). */
export interface TeamInfo {
  id: TeamId;
  label: string;
  color: number;
}

export const TEAMS: Record<TeamId, TeamInfo> = {
  A: { id: "A", label: "Team A", color: 0x22ccff },
  B: { id: "B", label: "Team B", color: 0xffcc22 },
  C: { id: "C", label: "Team C", color: 0xff44cc },
};

/** Spezial-Definitionen (Name + kurze Beschreibung). */
export interface SpecialDefinition {
  type: SpecialType;
  name: string;
  description: string;
}

export const SPECIALS: Record<SpecialType, SpecialDefinition> = {
  A: { type: "A", name: "Add Line", description: "Fügt unten eine Zeile mit Lücke hinzu." },
  C: { type: "C", name: "Clear Line", description: "Löscht die unterste Zeile." },
  B: { type: "B", name: "Clear Specials", description: "Wandelt Special-Blöcke in Normale um." },
  R: { type: "R", name: "Random Clear", description: "Löscht 10 zufällige Blöcke." },
  O: { type: "O", name: "Block Bomb", description: "Explodiert O-Blöcke (Radius 3x3)." },
  S: { type: "S", name: "Switch Fields", description: "Tauscht das eigene mit dem Zielfeld." },
  G: { type: "G", name: "Block Gravity", description: "Zieht alle Blöcke nach unten." },
  Q: { type: "Q", name: "Quake", description: "Verschiebt Zeilen zufällig links/rechts." },
  N: { type: "N", name: "Nuke", description: "Löscht das komplette Spielfeld." },
};

/**
 * Negativ-Specials (1–5): werden NORMALERWEISE gegen den GEGNER eingesetzt.
 * (game.md §2 — klassische Tetrinet-Einteilung)
 */
export const NEGATIVE_SPECIALS: SpecialType[] = ["A", "B", "R", "O", "Q"];
/**
 * Positiv-Specials (6–9): werden ÜBLICHERWEISE auf das EIGENE Feld angewendet.
 */
export const POSITIVE_SPECIALS: SpecialType[] = ["C", "G", "S", "N"];

/** Ist das Special "negativ" (Gegner) oder "positiv" (eigenes Feld)? */
export function isNegativeSpecial(type: SpecialType): boolean {
  return NEGATIVE_SPECIALS.includes(type);
}

/** Buchstaben -> Zell-Code für das eingefrorene Feld (Specials). */
export const SPECIAL_CHAR_TO_CELL: Record<SpecialType, number> = {
  A: 101, C: 102, B: 103, R: 104, O: 105, S: 106, G: 107, Q: 108, N: 109,
};

/** Zell-Code → Special-Buchstabe (umgekehrte Map zu SPECIAL_CHAR_TO_CELL). */
export const CELL_TO_SPECIAL_CHAR: Record<number, SpecialType> = {
  101: "A", 102: "C", 103: "B", 104: "R", 105: "O", 106: "S", 107: "G", 108: "Q", 109: "N",
};

/** Ist ein Zell-Wert ein Special? */
export function isSpecialCell(value: number): boolean {
  return value >= 101 && value <= 109;
}

/** Ist ein Zell-Wert ein Tetromino (1-7)? */
export function isTetroCell(value: number): boolean {
  return value >= 1 && value <= 7;
}

/**
 * Team-/Spielerfarben (6 Slot-Positionen, zirkulär wiederverwendbar).
 * Index = Position in der Room-Liste (0 = lokal, 1–5 = Gegner).
 * Benutzt für: Rahmen der gegnerischen Felder, Namens-/Score-Labels, Leaderboard.
 */
export const PLAYER_COLORS: number[] = [
  0x00e5ff, // 0 lokal   — Cyan
  0xff5500, // 1 Gegner  — Orange
  0x00ff88, // 2 Gegner  — Grün
  0xff2288, // 3 Gegner  — Pink
  0xffe14a, // 4 Gegner  — Gelb
  0xaa66ff, // 5 Gegner  — Violett
];
