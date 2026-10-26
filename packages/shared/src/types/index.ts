/**
 * Gemeinsame Typen für Client & Server (Tetrinet3D).
 */

/** Zellen-Codes für eine Spielfeld-Matrix. */
export const Cell = {
  EMPTY: 0,
  // Tetromino-Farben (1-7)
  TETRO_I: 1,
  TETRO_O: 2,
  TETRO_T: 3,
  TETRO_S: 4,
  TETRO_Z: 5,
  TETRO_J: 6,
  TETRO_L: 7,
  // Tetrinet-Specials (ab 101, damit keine Kollision mit Tetromino O/I)
  SPECIAL_A: 101,
  SPECIAL_C: 102,
  SPECIAL_B: 103,
  SPECIAL_R: 104,
  SPECIAL_O: 105,
  SPECIAL_S: 106, // Switch Fields (ersetzt Invert Matrix)
  SPECIAL_G: 107,
  SPECIAL_Q: 108,
  SPECIAL_N: 109,
  // Garbage-Linie (attack-addlines.md): graue Strafzeile mit genau 1 Loch.
  // Wird vom Server bei Multi-Line-Clear (>=2) an Gegner-Teams gesendet.
  // Wert 8 = zwischen Tetromino(1-7) und Specials(101+) — keine Kollision.
  GARBAGE: 8,
} as const;

export type CellValue = (typeof Cell)[keyof typeof Cell];

/** Eine Spielfeld-Matrix: GRID_HEIGHT Zeilen x GRID_WIDTH Spalten. */
export type Matrix = number[][];

/** Buchstaben der klassischen Tetrinet-Specials. */
export type SpecialType = "A" | "C" | "B" | "R" | "O" | "S" | "G" | "Q" | "N";

/** Eingaben des lokalen Spielers. */
export type PlayerAction =
  | "LEFT"
  | "RIGHT"
  | "ROTATE"
  | "SOFT_DROP"
  | "HARD_DROP";

/** Status eines Spielers. */
export type PlayerStatus = "active" | "spectator" | "winner";

/**
 * Nacht 19 (mainmenu.md §2): Raum-Zustandsmaschine.
 *  - LOBBY        : Warten, Spiel pausiert (GameLoop tickt nicht).
 *  - READY_CHECK  : 15s-Overlay, jeder muss „Bereit" oder abbrechen.
 *  - INGAME       : aktives Spiel (GameLoop tickt).
 *  - POST_GAME    : Siegerehrung, Spiel pausiert bis neuer Ready-Check.
 */
export type RoomStatus = "LOBBY" | "READY_CHECK" | "INGAME" | "POST_GAME";

/** Nacht 19: Grund, warum der Ready-Check abgebrochen wurde. */
export type ReadyAbortReason = "PLAYER_DECLINED" | "TIMEOUT_AFK" | "LEADER_CANCEL";

/**
 * Nacht 18: Spielmodus.
 *  - "solo"  : jeder Spieler für sich — gewinnt der letzte aktive Spieler
 *  - "team2" : Teams zu 2 (max. 3 Teams in einer 6-Spieler-Arena)
 *  - "team3" : Teams zu 3 (2 Teams in einer 6-Spieler-Arena)
 * Team-Zuweisung: automatisch nach Beitrittsreihenfolge, Server-Authoritative.
 * Gewinnteams-Regel: gewinnt das Team, dessen LETZTER aktiver Spieler übrig
 * bleibt (alle Gegner-Teams ohne aktiven Spieler).
 */
export type TeamMode = "solo" | "team2" | "team3";

/** Team-Kennung (A..F, max. 3 Teams in team2-Modus). */
export type TeamId = "A" | "B" | "C";

/**
 * Nacht 18.1: Garbage-Linien-Attacke (attack-addlines.md).
 * Server → Ziel-Spieler: Anzahl an Straflinien, die dem Zielfeld
 * hinzuzufügen sind (jede Zeile 11 graue Blöcke + genau 1 Loch,
 * Loch-Position zufällig je Zeile).
 */
export interface LinesAttackMessage {
  /** Anzahl der zu erzeugenden Straflinien (1, 2 oder 4). */
  count: number;
  /** Wer hat angegriffen (für Eventlog). */
  attackerId: string;
  attackerName: string;
  /** Wie viele Zeilen wurden gleichzeitig gelöscht (1-4, nur >=2 löst Attacke aus). */
  cleared: number;
}

/** Aktives (fallendes) Tetromino. */
export interface ActivePiece {
  /** Tetromino-Typ als Zell-Code (1-7). */
  type: number;
  /** Drehzustand 0-3. */
  rotation: number;
  /** X-Position (Spalte, 0-basiert). */
  x: number;
  /** Y-Position (Zeile, 0 = oberste sichtbare Zeile des Spielbaren Felds). */
  y: number;
}

/** Vollständiger, serialisierbarer Zustand eines Spielers (Server -> Client). */
export interface PlayerState {
  id: string;
  name: string;
  /** Das eingefrorene Spielfeld (ohne das aktive Stück). */
  grid: Matrix;
  /** Aktives Stück oder null. */
  activePiece: ActivePiece | null;
  /** Reihenfolge der nächsten Stücke (Zell-Codes). */
  queue: number[];
  /** Inventory (max. MAX_SPECIALS). */
  specialsInventory: SpecialType[];
  status: PlayerStatus;
  /** Punkte (optional). */
  score: number;
}

/** Kurze Spieler-Referenz für die Room-Liste. */
export interface PlayerRef {
  id: string;
  name: string;
  /** Aktueller Score (für das Live-Leaderboard). */
  score?: number;
  /** true, wenn der Spieler ein Bot ist (Lobby-Auffüllung / Dev-Test). */
  isBot?: boolean;
  /** Schwierigkeitsstufe des Bots (nur für Bots). */
  botDifficulty?: BotDifficulty;
  /**
   * Nacht 17.2: Aktueller Status (active/spectator/winner) — damit der Client
   * Ausschiedene Felder GRAU rendert, auch wenn der `player_status`-Event
   * bereits vor dem (Re-)Join gesendet wurde.
   */
  status?: PlayerStatus;
  /**
   * Nacht 19: true, wenn der Spieler im Ready-Check auf „Bereit" geklickt hat
   * (Bots readyen automatisch). Fehlt/undefined außerhalb des Ready-Checks.
   */
  ready?: boolean;
  /**
   * Nacht 18: Team-Kennung (nur im Team-Modus "team2"/"team3").
   * undefined = Solo-Modus.
   */
  team?: TeamId;
}

/**
 * Bot-Schwierigkeitsstufen (DOOM-artig, von leicht bis hart).
 * Die Werte steuern Reaktionszeit, Plazierungs-Konstanz und Special-Aggressivität.
 */
export type BotDifficulty =
  | "too_young"   // I'm too young to die
  | "not_rough"   // Hey, not too rough
  | "hurt_me"     // Hurt me plenty
  | "ultraviolence" // Ultraviolence
  | "nightmare"   // Nightmare!
  | "ultra_nightmare"; // Ultra-Nightmare!

/** Anzeigename + kurze Beschreibung pro Stufe. */
export interface BotPresetInfo {
  key: BotDifficulty;
  label: string;
  desc: string;
}

export const BOT_DIFFICULTIES: BotPresetInfo[] = [
  { key: "too_young",       label: "I'm too young to die", desc: "Sanft — lernt gerade erst" },
  { key: "not_rough",       label: "Hey, not too rough",   desc: "Locker — ab und zu Patzer" },
  { key: "hurt_me",         label: "Hurt me plenty",       desc: "Fordert — solides Spiel" },
  { key: "ultraviolence",   label: "Ultraviolence",        desc: "Hart — präzise & aggressiv" },
  { key: "nightmare",       label: "Nightmare!",           desc: "Sehr hart — kaum Fehler" },
  { key: "ultra_nightmare", label: "Ultra-Nightmare!",     desc: "Brutal — nahezu perfekt" },
];

/* ------------------------------------------------------------------ */
/* Nachrichten: Client -> Server                                       */
/* ------------------------------------------------------------------ */

export interface JoinRoomMessage {
  name: string;
}

export interface RenamePlayerMessage {
  name: string;
}

export interface PlayerInputMessage {
  action: PlayerAction;
  timestamp: number;
}

export interface UseSpecialMessage {
  /** Index des Ziels in der Room-Liste (0 = lokal, 1-5 = Gegner). */
  targetIndex: number;
  specialType: SpecialType;
}

export interface ChatMessage {
  text: string;
}

/** Bots in die Lobby füllen (Anzahl + Schwierigkeitsstufe). */
export interface AddBotsMessage {
  /** Wie viele Bots hinzufügen (1…5). */
  count: number;
  /** Schwierigkeitsstufe für die Bots. */
  difficulty: BotDifficulty;
}

/** Schwierigkeitsstufe aller Bots im Raum ändern (nur Lobby-Leader). */
export interface SetBotDifficultyMessage {
  difficulty: BotDifficulty;
}

/** Spielmodus wechseln (nur Lobby-Leader): solo / team2 / team3. */
export interface SetGameModeMessage {
  mode: TeamMode;
}

/* ------------------------------------------------------------------ */
/* Nacht 19 (mainmenu.md §2.1/§3): Ready-Check, Start, Teamname         */
/* ------------------------------------------------------------------ */

/** C2S: Leader startet den Ready-Check (mindestens 2 Spieler, kein Penalty). */
export interface StartReadyCheckMessage {
  roomId: string;
}

/** C2S: Reaktion auf den Ready-Check. confirmed=true = „Bereit", false = Abbruch. */
export interface PlayerReadyMessage {
  roomId: string;
  confirmed: boolean;
}

/** C2S: Team-Umbenennung (max 24 Zeichen, Server-sanitisiert). */
export interface EditTeamNameMessage {
  roomId: string;
  /** Team-ID des EIGENEN Teams (der Sender muss Teil des Teams sein). */
  teamId: TeamId;
  newName: string;
}

/** S2C: Ready-Check gestartet — Overlay mit 15s-Countdown (endsAt). */
export interface ReadyCheckInitMessage {
  endsAt: number;
  /** Alle Spieler + deren aktuellen Ready-Status (Bots = sofort ready). */
  players: Array<{ id: string; name: string; ready: boolean; team?: TeamId }>;
}

/** S2C: Ein Spieler hat seinen Ready-Status geändert (live-Update im Overlay). */
export interface PlayerReadyUpdateMessage {
  playerId: string;
  playerName: string;
  isReady: boolean;
}

/** S2C: Ready-Check abgebrochen (Decline, AFK-Timeout oder Leader-Cancel). */
export interface ReadyCheckAbortedMessage {
  reason: ReadyAbortReason;
  /** IDs der AFK-Spieler (nur bei TIMEOUT_AFK), sonst leer. */
  afkPlayerIds: string[];
}

/** S2C: Alle ready — Spiel startet jetzt (Seed für deterministische Randomizer). */
export interface GameStartMessage {
  seed: number;
}

/** S2C: Aktueller Raum-Status (LOBBY/READY_CHECK/INGAME/POST_GAME). */
export interface RoomStatusMessage {
  status: RoomStatus;
}

/* ------------------------------------------------------------------ */
/* Nachrichten: Server -> Client                                       */
/* ------------------------------------------------------------------ */

export interface RoomStateMessage {
  players: PlayerRef[];
  /** Index des lokalen Spielers in `players` (immer 0 im sortierten Overlay). */
  selfIndex: number;
  /** true, wenn der lokale Spieler Lobby-Leader ist (darf Bots verwalten). */
  isLeader?: boolean;
  /**
   * Nacht 18: Aktueller Spielmodus. Solo = undefined, sonst "team2"/"team3".
   */
  gameMode?: TeamMode;
  /**
   * Nacht 19 (mainmenu.md §2): Aktueller Raum-Status (LOBBY/READY_CHECK/INGAME/
   * POST_GAME). Client rendert entsprechend (Overlay, Start-Button).
   */
  roomStatus?: RoomStatus;
  /**
   * Nacht 19 (mainmenu.md §3): Custom-Teamnamen (je TeamId, sonst undefined →
   * Standard-Label "Team A/B/C"). Realtime-Update via `team_name_updated`.
   */
  teamNames?: Partial<Record<TeamId, string>>;
  /**
   * NACHT 19.7 (Team-Leader-Regel): Team-Leader pro TeamId = erster Spieler,
   * der das Team gejoint hat (Beitrittsreihenfolge). NUR der Leader darf den
   * Team-Namen ändern (serverseitig erzwungen, s. `Room.editTeamName`).
   */
  teamLeaders?: Partial<Record<TeamId, string>>;
}

export interface GridUpdateMessage {
  playerId: string;
  grid: Matrix;
  activePiece: ActivePiece | null;
  /** Nächste Stücke in der Queue (Index 0 = sofort nächstes, Tetromino-Codes 1–7). */
  queue?: number[];
  /** Aktueller Score (Live-Leaderboard). */
  score?: number;
  /**
   * NACHT 19.11: Aktuelles RAUM-LEVEL (Ø der individuellen Spieler-Level, levels.md)
   * — identisch für alle Spieler im Raum. Client zeigt es im HUD an.
   */
  level?: number;
}

export interface SpecialsUpdateMessage {
  playerId: string;
  inventory: SpecialType[];
}

export interface SpecialTriggeredMessage {
  byPlayerId: string;
  targetPlayerId: string;
  type: SpecialType;
  updatedTargetGrid: Matrix;
  /** Nur bei Special "S" (Switch Fields): auch das ANGREIFER-Feld hat sich geändert. */
  updatedAttackerGrid?: Matrix;
}

export interface PlayerStatusMessage {
  playerId: string;
  status: PlayerStatus;
}

export interface GameOverMessage {
  winnerId: string | null;
  /**
   * Nacht 18: Team-Kennung des gewinnenden Teams (nur im Team-Modus).
   * undefined/null = Solo-Winner (nur winnerId zählt).
   */
  winnerTeamId?: TeamId | null;
}

export interface ChatMessageOut {
  from: string;
  text: string;
}

/** Aktuellen Bot-Stand melden (Anzahl + Stufe) — für das Bot-Panel. */
export interface BotsUpdatedMessage {
  botCount: number;
  difficulty: BotDifficulty | null;
  /** Ids der aktiven Bots (für Anzeige/Entfernen). */
  botIds: string[];
}
