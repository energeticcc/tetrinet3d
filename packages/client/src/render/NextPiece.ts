import * as THREE from "three";
import { pieceOffsets } from "@tetrinet3d/shared";
import { createNeonCube, NEON_COLORS } from "./cubes";

const CELL_COLORS: Record<number, number> = {
  1: NEON_COLORS.I,
  2: NEON_COLORS.O,
  3: NEON_COLORS.T,
  4: NEON_COLORS.S,
  5: NEON_COLORS.Z,
  6: NEON_COLORS.J,
  7: NEON_COLORS.L,
};

/**
 * 3D-Vorschau der nächsten Stücke (Next-Piece-Queue).
 * Rendert bis zu 3 Tetrominos vertikal übereinander:
 *  - Index 0 (nächstes): oben, Skala 1.0
 *  - Index 1:  Mitte, Skala 0.75
 *  - Index 2:  unten, Skala 0.55
 * Jedes Stück ist zentriert in seinem Slot.
 * Steht im freien Platz zwischen Hauptfeld (links) und Gegnern (rechts).
 */
export class NextPiecePreview {
  readonly group: THREE.Group;
  private holders: THREE.Group[] = [];
  private currentTypes: number[] = [];

  /** Max. Anzahl der gezeigten Stücke (aktuell 3). */
  static readonly MAX_SLOTS = 3;
  /**
   * Distanz zwischen den Slots.
   * Nacht 17.8: 3.2 → 4.0 — Stücke (besonders die großen I/O) wirkten zu
   * eng/überschnitten; deutlich mehr Luft zwischen den 3 Vorschau-Blöcken.
   */
  private static readonly SLOT_SPACING = 4.0;

  constructor() {
    this.group = new THREE.Group();
  }

  /** Zeigt die nächsten N Stücke (Tetromino-Codes 1–7). */
  setQueue(types: number[]): void {
    // Kein Re-Build, wenn sich nichts geändert hat
    if (this.typesEqual(this.currentTypes, types.slice(0, NextPiecePreview.MAX_SLOTS))) return;
    this.clearAll();
    this.currentTypes = types.slice(0, NextPiecePreview.MAX_SLOTS);

    const n = this.currentTypes.length;
    // HORIZONTAL zentriert — Nacht 15: **nächstes Stück (Index 0) rechts**, ältere links.
    // i=0 → x = +(n-1)/2 * spacing (rechts), i=n-1 → x = -(n-1)/2 * spacing (links)
    for (let i = 0; i < n; i++) {
      const type = this.currentTypes[i];
      const scale = i === 0 ? 1.0 : i === 1 ? 0.75 : 0.55;
      const xOffset = (n - 1) / 2 - i; // i=0 → +(n-1)/2 (rechts), i=n-1 → -(n-1)/2 (links)

      const g = this.buildPiece(type, scale);
      g.position.set(xOffset * NextPiecePreview.SLOT_SPACING, 0, 0);
      this.group.add(g);
      this.holders.push(g);
    }
  }

  private typesEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private buildPiece(type: number, scale: number): THREE.Group {
    const color = CELL_COLORS[type] ?? 0xffffff;
    const g = new THREE.Group();
    const offsets = pieceOffsets(type, 0);

    // Zentrieren
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [ox, oy] of offsets) {
      minX = Math.min(minX, ox); maxX = Math.max(maxX, ox);
      minY = Math.min(minY, oy); maxY = Math.max(maxY, oy);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    for (const [ox, oy] of offsets) {
      const cube = createNeonCube(color);
      cube.position.set(ox - cx, cy - oy, 0);
      g.add(cube);
    }
    g.scale.setScalar(scale);
    return g;
  }

  private clearAll(): void {
    for (const h of this.holders) {
      this.group.remove(h);
      h.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          (mesh.material as THREE.Material).dispose?.();
        }
      });
    }
    this.holders = [];
  }

  dispose(): void {
    this.clearAll();
  }
}
