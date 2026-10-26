/**
 * Mobile/Touch-Steuerung:
 *  - Swipe auf dem Spielfeld: Links / Rechts / Rotieren (oben) / Soft-Drop (unten)
 *  - Tap (kurz, ohne Bewegung): Hard-Drop
 *  - On-Screen-Buttons: gleiche Aktionen für Spieler, die Gesten schwer finden
 *
 * Wird nur bei coarse-Pointer (Mobile/Tablet) angezeigt (CSS).
 * Funktioniert aber auch per Klick auf Desktop (nützlich für Tests).
 */
import type { PlayerAction } from "@tetrinet3d/shared";

export interface TouchInputAPI {
  /** Führt eine Aktion lokal + per Socket aus (z. B. "LEFT", "HARD_DROP"). */
  act: (a: PlayerAction) => void;
  /** Das Front-Special (Index 0, FIFO) auf Ziel-Index (0=lokal, 1–5=Gegner) abfeuern. */
  fireSpecial: (targetIndex: number) => void;
}

interface SwipeState {
  id: number;
  startX: number;
  startY: number;
  moved: number;
  t0: number;
  axis: "none" | "x" | "y";
}

export class TouchControls {
  private root: HTMLDivElement;
  private api: TouchInputAPI;
  private swipe: SwipeState | null = null;

  /** Schwelle in px, ab der ein Swipe gezählt wird. */
  private static readonly SWIPE_THRESHOLD = 24;
  /** Max. Zeitspanne (ms), innerhalb derer ein Tap gilt (sonst: Halten). */
  private static readonly TAP_MAX_MS = 220;

  constructor(root: HTMLDivElement, api: TouchInputAPI) {
    this.root = root;
    this.api = api;
    this.buildButtons();
  }

  /** Fügt den On-Screen-Button-Block in den root-Container ein. */
  private buildButtons(): void {
    this.root.classList.add("touch-controls");

    const mk = (label: string, cls: string, onTap: () => void, aria: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `touch-btn ${cls}`;
      b.textContent = label;
      b.setAttribute("aria-label", aria);
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        onTap();
      });
      return b;
    };

    // Zeile 1: Basis-Tetris-Steuerung
    const row1 = document.createElement("div");
    row1.className = "touch-row";
    row1.appendChild(mk("◀", "move", () => this.api.act("LEFT"), "Nach links"));
    row1.appendChild(mk("▼", "soft", () => this.api.act("SOFT_DROP"), "Soft-Drop"));
    row1.appendChild(mk("▶", "move", () => this.api.act("RIGHT"), "Nach rechts"));
    row1.appendChild(mk("⟳", "rot", () => this.api.act("ROTATE"), "Rotieren"));
    this.root.appendChild(row1);

    // Zeile 3: Ziel auswählen (1=lokal, 2–6=Gegner) — feuert das gewählte Special ab.
    const row3 = document.createElement("div");
    row3.className = "touch-row targets";
    for (let i = 0; i < 6; i++) {
      const label = i === 0 ? "ME" : String(i + 1);
      row3.appendChild(mk(label, "target", () => this.api.fireSpecial(i), `Special auf Ziel ${i + 1} abfeuern`));
    }
    this.root.appendChild(row3);
  }

  /**
   * Bindet Swipe-/Tap-Gesten an ein beliebiges Element (z. B. das Game-Canvas).
   * Verwendet Pointer-Events (deckt Touch + Maus ab).
   */
  public attachGestures(target: HTMLElement): void {
    target.style.touchAction = "none"; // verhindert, dass der Browser Scrollen übernimmt

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      // Gestur nur starten, wenn die Geste NICHT von einer UI-Überlagerung
      // (Touch-Panel, Chat, Leaderboard …) ausgeht — sonst würde ein Button-
      // Tipp versehentlich einen Hard-Drop auslösen.
      const src = e.target as HTMLElement;
      if (src.closest("#touch-panel") || src.closest("#ui-container")) return;
      this.swipe = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        moved: 0,
        t0: performance.now(),
        axis: "none",
      };
      target.setPointerCapture?.(e.pointerId);
    });

    target.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.swipe || this.swipe.id !== e.pointerId) return;
      const dx = e.clientX - this.swipe.startX;
      const dy = e.clientY - this.swipe.startY;
      this.swipe.moved = Math.max(this.swipe.moved, Math.hypot(dx, dy));
      if (this.swipe.axis === "none" && this.swipe.moved > TouchControls.SWIPE_THRESHOLD) {
        this.swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
    });

    const onUp = (e: PointerEvent) => {
      if (!this.swipe || this.swipe.id !== e.pointerId) return;
      const s = this.swipe;
      this.swipe = null;
      target.releasePointerCapture?.(e.pointerId);

      const dur = performance.now() - s.t0;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;

      // Kurzer, ruhiger Finger = Tap → Hard-Drop
      if (s.moved < TouchControls.SWIPE_THRESHOLD && dur < TouchControls.TAP_MAX_MS) {
        this.api.act("HARD_DROP");
        return;
      }
      // Swipe erkannt?
      if (s.axis === "x" && Math.abs(dx) > TouchControls.SWIPE_THRESHOLD) {
        this.api.act(dx > 0 ? "RIGHT" : "LEFT");
      } else if (s.axis === "y" && Math.abs(dy) > TouchControls.SWIPE_THRESHOLD) {
        this.api.act(dy > 0 ? "SOFT_DROP" : "ROTATE");
      }
    };

    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", () => (this.swipe = null));
  }
}
