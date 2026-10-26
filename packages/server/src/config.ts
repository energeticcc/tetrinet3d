/**
 * Server-Konfiguration (via Environment-Variablen).
 *
 * DEV-Modus:  TETRIS_BOTS=true  →  Lobby wird automatisch mit Bots aufgefüllt
 *              TETRIS_BOT_DIFF   →  Default-Schwierigkeit (siehe BotDifficulty)
 *
 * RELEASE:     TETRIS_BOTS unset →  Bots nur manuell über die Lobby-Leader-UI
 */
import type { BotDifficulty } from "@tetrinet3d/shared";

const env = (process.env as Record<string, string | undefined>);

/** true, wenn die Lobby beim Beitritt automatisch mit Bots aufgefüllt werden soll. */
export const BOT_AUTOFILL: boolean =
  env["TETRIS_BOTS"] === "true" || env["TETRIS_BOTS"] === "1";

/**
 * Default-Schwierigkeit der Auto-Fill-Bots.
 * DEV-Phase: standardmäßig "ultra_nightmare" (Brutal) — via `TETRIS_BOT_DIFF` überschreibbar.
 */
export const BOT_DEFAULT_DIFFICULTY: BotDifficulty =
  (env["TETRIS_BOT_DIFF"] as BotDifficulty) || "ultra_nightmare";

/** Validierte Liste der Bot-Namen (DOOM-Charaktere). */
export const BOT_NAMES: string[] = [
  "Cacodemon", "Baron", "HellKnight", "Pinky", "Imp", "Revenant",
  "Arachnotron", "SpiderMaster", "Mancubus", "PainElemental",
  "ArmedSoul", "LostSoul", "DoomImp", "Brutus", "Caber", "DoomBot",
];

/**
 * Lobby-Leader: Wenn dieser Spielername im Raum existiert, erhält er
 * VORRANG als Leader (Bot-Panel, Bots verwalten). Empty/undef = kein
 * Vorrang (erster Menschlicher Spieler wie bisher).
 */
export const LOBBY_LEADER_NAME: string =
  env["TETRIS_LEADER"] ?? "energetic";

/* ------------------------------------------------------------------ */
/* Nacht 19 (mainmenu.md §2.1): Ready-Check-Konfiguration              */
/* ------------------------------------------------------------------ */
/** Dauer des Ready-Check-Overlays in ms (Spec: exakt 15 Sekunden). */
export const READY_CHECK_MS: number =
  (Number(env["TETRIS_READY_MS"]) || 15) * 1000;

/** AFK-Penalty-Dauer in ms (Spec: `penaltyEndsAt = Date.now() + 60000`). */
export const AFK_PENALTY_MS: number =
  (Number(env["TETRIS_AFK_PENALTY_MS"]) || 60) * 1000;

/** Max. Länge eines Team-Namens (Spec §3: max. 24 Zeichen). */
export const TEAM_NAME_MAX_LEN: number = 24;
