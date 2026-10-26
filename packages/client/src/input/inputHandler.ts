import type { SocketClient } from "../network/socketClient";
import type { PlayerAction, PlayerStatus, SpecialType } from "@tetrinet3d/shared";

export interface InputOptions {
  /** Liefert das aktuell ausgewählte Special aus dem eigenen Inventory. */
  getActiveSpecial: () => SpecialType | null;
  /** Anzahl der verfügbaren Ziel-Felder (eigene + Gegner). */
  getTargetCount: () => number;
  /**
   * NIGHT 17.8: Status des Zielspielers am Raum-Index (0 = selbst).
   * Ermöglicht die Client-seitige Ablehnung von Specials auf
   * ausgeschiedene (spectator/winner) Gegner — Inventar bleibt erhalten.
   */
  getTargetStatus?: (targetIndexInRoom: number) => PlayerStatus | null;
  /**
   * NIGHT 17.8: Wird aufgerufen, wenn ein Special auf ein nicht-aktives
   * Ziel abgelehnt wird (Feedback/Log — statt stiller Abweisung).
   */
  onRejectedTarget?: (special: SpecialType, targetStatus: PlayerStatus) => void;
  /**
   * Client-Side Prediction: wird VOR dem Network-Send aufgerufen.
   * Der App-Kontext mutiert dort den lokalen Zustand (grid/activePiece)
   * und rendert sofort — ohne auf den Server zu warten.
   * Gibt false zurück, wenn die Aktion lokal abgelehnt wurde (keine Kollision).
   */
  onPredict?: (action: PlayerAction) => boolean;
  /** Wird aufgerufen, wenn die lokale Prediction scheitert (z.B. Hard Drop ohne Stück). */
  onInvalid?: () => void;
  /** Wird beim Abfeuern eines Specials aufgerufen (z.B. Sound). */
  onSpecialFire?: () => void;
}

/**
 * Tastatur-Steuerung:
 *  - Pfeiltasten / Space: Tetris-Eingaben (mit Client-Side Prediction)
 *  - 1–6: Front-Special (Index 0, FIFO) auf Ziel (0 = lokal, 1–5 = Gegner) abfeuern
 */
export class InputHandler {
  /** Abstand zwischen zwei Soft-Drops, wenn ArrowDown gehalten wird (ms). */
  static readonly SOFT_DROP_REPEAT_MS = 70;

  private socket: SocketClient;
  private options: InputOptions;
  private attached = false;

  constructor(socket: SocketClient, options: InputOptions) {
    this.socket = socket;
    this.options = options;
  }

  /** Weiche-Drop-Repeat (Taste halten → schneller Fallen, KEIN Hard-Drop). */
  private softDropTimer: number | null = null;

  attach(): void {
    if (this.attached) return;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.stopSoftDrop();
    this.attached = false;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // Nicht reagieren, wenn im Chat-Feld getippt wird
    const target = event.target as HTMLElement | null;
    const typing =
      target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if (typing) return;

    switch (event.code) {
      case "ArrowLeft":
        this.act("LEFT");
        break;
      case "ArrowRight":
        this.act("RIGHT");
        break;
      case "ArrowUp":
        this.act("ROTATE");
        break;
      case "ArrowDown":
        // Taste HALTEN → beschleunigtes Fallen (kein Hard-Drop wie bei Space).
        // Einmal sofort + dann wiederholen, solange die Taste runter ist.
        if (!event.repeat) this.startSoftDrop();
        break;
      case "Space":
        this.act("HARD_DROP");
        break;

      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4":
      case "Digit5":
      case "Digit6": {
        const targetIndex = parseInt(event.key, 10) - 1; // 0–5
        this.fireSpecial(targetIndex);
        break;
      }
    }
  };

  /** Bei Tasten-Loslassen: Soft-Drop-Repeat stoppen (nur bei ArrowDown relevant). */
  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "ArrowDown") this.stopSoftDrop();
  };

  /**
   * Startet das beschleunigte Fallen (Soft-Drop): sofort ein Fall + dann
   * alle SOFT_DROP_REPEAT_MS ein weiteres, solange die Taste gehalten wird.
   * WICHTIG: Das ist KEIN Hard-Drop — das Stück bleibt kontrollierbar.
   */
  private startSoftDrop(): void {
    this.stopSoftDrop();
    this.act("SOFT_DROP"); // sofort der erste Fall
    this.softDropTimer = window.setInterval(() => this.act("SOFT_DROP"), InputHandler.SOFT_DROP_REPEAT_MS);
  }

  /** Stoppt den Soft-Drop-Repeat (Taste losgelassen / detach). */
  private stopSoftDrop(): void {
    if (this.softDropTimer !== null) {
      clearInterval(this.softDropTimer);
      this.softDropTimer = null;
    }
  }

  /** Führt eine Tetris-Aktion aus (Prediction + Socket) — für Tastatur UND Touch. */
  public act(action: PlayerAction): void {
    // Client-Side Prediction (game.md §3.1): Zuerst lokal ausführen & rendern,
    // dann an den Server schicken (Server validiert, ggf. Snap-Back).
    const ok = this.options.onPredict ? this.options.onPredict(action) : true;
    if (ok === false) {
      this.options.onInvalid?.();
      return;
    }
    this.socket.sendAction(action);
  }

  public fireSpecial(targetIndexInRoom: number): void {
    const activeSpecial = this.options.getActiveSpecial();
    if (!activeSpecial) return;
    if (targetIndexInRoom < 0 || targetIndexInRoom >= this.options.getTargetCount()) return;
    // NIGHT 17.8: Game-Regel (game.md §2, serverseitig seit 17.2):
    // Specials wirken NUR auf AKTIVE Gegner. Client lehnt vorab ab
    // (Inventar bleibt lokal erhalten, kein unnötiges Netzwerk-Runden-Trip).
    const targetStatus = this.options.getTargetStatus?.(targetIndexInRoom);
    if (targetIndexInRoom !== 0 && targetStatus && targetStatus !== "active") {
      this.options.onRejectedTarget?.(activeSpecial, targetStatus);
      return;
    }
    this.options.onSpecialFire?.();
    this.socket.useSpecial(targetIndexInRoom, activeSpecial);
  }
}
