import * as THREE from "three";
import { GRID_WIDTH, GRID_HEIGHT, isSpecialCell, CELL_TO_SPECIAL_CHAR, pieceOffsets } from "@tetrinet3d/shared";
import type { ActivePiece } from "@tetrinet3d/shared";
import { createNeonCube, createSpecialSphere, rotateSpecialSphere, NEON_COLORS, SPECIAL_COLORS } from "./cubes";

/** Farbpalette je Zell-Code (Tetromino + Garbage) — auf 0xRRGGBB. */
const CELL_COLORS: Record<number, number> = {
  1: NEON_COLORS.I, // Cyan
  2: NEON_COLORS.O, // Gelb
  3: NEON_COLORS.T, // Lila
  4: NEON_COLORS.S, // Grün
  5: NEON_COLORS.Z, // Rot
  6: NEON_COLORS.J, // Blau
  7: NEON_COLORS.L, // Orange
  8: NEON_COLORS.GARBAGE, // Nacht 18.1: graue Strafzeile (attack-addlines.md)
};

/* ------------------------------------------------------------------ */
/* Nacht 17.8: Animierter GLOW für Special-Steine am Spielfeld        */
/* ------------------------------------------------------------------ */
/** Radiale Glow-Texture pro Farbe (gecacht). */
const GLOW_TEXTURE_CACHE: Record<number, THREE.CanvasTexture> = {};

function glowTexture(colorHex: number): THREE.CanvasTexture {
  const tex = GLOW_TEXTURE_CACHE[colorHex];
  if (tex) return tex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const r = (colorHex >> 16) & 255, g = (colorHex >> 8) & 255, b = colorHex & 255;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  GLOW_TEXTURE_CACHE[colorHex] = t;
  return t;
}

/**
 * Rendert ein einzelnes Spielfeld (12x22) als 3D-Würfel.
 * Instanzen: ein THREE.Group, darin je gefüllte Zelle ein Neon-Kube.
 * Nacht 17.8: Special-Zellen tragen zusätzlich einen pulsierenden Glow-Sprite.
 */
export class Grid3D {
  readonly group: THREE.Group;
  private meshMatrix: (THREE.Object3D | null)[][];
  /** Nacht 17.8: Glow-Sprites pro Zelle (y, x) — animiert in pulseSpecials(). */
  private specialGlows: Map<string, THREE.Sprite> = new Map();
  /** NACHT 19.10: Special-KUGELN pro Zelle (y, x) — rotieren in pulseSpecials(). */
  private specialSpheres: Map<string, THREE.Group> = new Map();
  /** Nacht 17.8: eigene Elapsed-Time für den Glow-Puls. */
  private elapsed = 0;
  /** Gruppe für das aktive (fallende) Stück — separat vom eingefrorenen Feld. */
  private activePieceGroup: THREE.Group | null = null;
  /**
   * NACHT 19.6 (ghostpiece-addon.md): Halbtransparenter Schattenstein (Landepunkt
   * bei Hard-Drop) — reine Client-Hilfsdarstellung, 20% Opazität, entsättigte
   * Steinfarbe. `setGhost(piece, ghostY)` pro Update; `clearGhost()` bei
   * Deaktivierung/Stückwechsel-Ende.
   */
  private ghostGroup: THREE.Group | null = null;
  private ghostKey = "";
  /** Rahmen-Material (farbbar: Spieler-/Teamfarbe, Nacht 12). */
  private frameMat: THREE.LineBasicMaterial | null = null;
  /** Gitter-/Rahmen-Geometrie + Materialien (für sauberes dispose, GPU-Leak-Fix). */
  private gridGeo: THREE.BufferGeometry | null = null;
  private gridMat: THREE.LineBasicMaterial | null = null;
  private frameGeo: THREE.BufferGeometry | null = null;
  /** Letzter Zellwert pro Zelle (damit Wert-Wechsel erkannt werden). */
  private values: number[][];
  /**
   * Nacht 15: true = Spieler hat verloren — Feld bleibt sichtbar, aber GRAU
   * (Rahmen-Farbe bleibt, Nacht 15). false = normaler Farbton.
   */
  public lost = false;

  /**
   * Snapshot der aktuellen Zellwerte (für Re-Render nach lost/Statuswechsel,
   * ohne den Server-Zustand neu anfragen zu müssen).
   */
  public valuesSnapshot(): number[][] {
    return this.values.map((row) => row.slice());
  }

  constructor() {
    this.group = new THREE.Group();
    this.meshMatrix = Array.from({ length: GRID_HEIGHT }, () =>
      Array(GRID_WIDTH).fill(null),
    );
    this.values = Array.from({ length: GRID_HEIGHT }, () =>
      Array(GRID_WIDTH).fill(0),
    );

    const hw = GRID_WIDTH / 2;
    const hh = GRID_HEIGHT / 2;

    // Interne Gitterlinien (OHNE Außenrand — der Rand ist der farbige Rahmen).
    const pts: number[] = [];
    for (let i = 1; i < GRID_WIDTH; i++) {
      const x = -hw + i;
      pts.push(x, -hh, 0, x, hh, 0);
    }
    for (let j = 1; j < GRID_HEIGHT; j++) {
      const y = -hh + j;
      pts.push(-hw, y, 0, hw, y, 0);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x262626,
      transparent: true,
      opacity: 0.55,
    });
    this.gridGeo = gridGeo;
    this.gridMat = gridMat;
    this.group.add(new THREE.LineSegments(gridGeo, gridMat));

    // Rahmen: rechteckige Umrandung des Spielfelds (Nacht 12: Spielerfarbe).
    const framePts = new Float32Array([
      -hw, -hh, 0,  hw, -hh, 0,
      hw, -hh, 0,   hw,  hh, 0,
      hw,  hh, 0,  -hw,  hh, 0,
      -hw,  hh, 0,  -hw, -hh, 0,
    ]);
    const frameGeo = new THREE.BufferGeometry();
    frameGeo.setAttribute("position", new THREE.BufferAttribute(framePts, 3));
    this.frameGeo = frameGeo;
    this.frameMat = new THREE.LineBasicMaterial({
      color: 0x444444,
      transparent: true,
      opacity: 0.95,
    });
    this.group.add(new THREE.LineSegments(frameGeo, this.frameMat));
  }

  /** Setzt die Rahmenfarbe (Spieler-/Teamfarbe, z.B. PLAYER_COLORS[i]). */
  public setFrameColor(colorHex: number): void {
    if (this.frameMat) this.frameMat.color.setHex(colorHex);
  }

  /* ---------------------------------------------------------------- */
  /* NIGHT 17.8: Animierter Glow für Special-Steine                   */
  /* ---------------------------------------------------------------- */

  /** Erzeugt einen Glow-Sprite (radiale Textur, additive Blendung). */
  private makeSpecialGlow(colorHex: number): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: glowTexture(colorHex),
      color: colorHex,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(1.6);
    return sprite;
  }

  /**
   * Nacht 17.8: Pulsierender Glow + leichtes Schweben der Special-Blöcke.
   * Von der Render-Schleife mit Delta-Time aufrufen (no-op ohne Specials).
   */
  public pulseSpecials(dt: number): void {
    if (this.specialGlows.size === 0 && this.specialSpheres.size === 0) return;
    this.elapsed += dt;
    // NACHT 19.10: Special-Kugeln rotieren nach rechts (Y-Achse) mit ≈ 0.6 rad/s
    if (this.specialSpheres.size > 0) {
      const angle = this.elapsed * 0.6;
      for (const [key, sphere] of this.specialSpheres) {
        if (!sphere.parent) continue; // wurde zwischenzeitlich entfernt
        rotateSpecialSphere(sphere, angle);
      }
    }
    // Puls: 0.75–1.25 um Basis-Skala 1.6; Glow-Opazität 0.35–0.7
    const t = this.elapsed;
    const pulse = 1 + Math.sin(t * 4.2) * 0.25;
    for (const [key, sprite] of this.specialGlows) {
      if (!sprite.parent) continue; // wurde zwischenzeitlich entfernt
      sprite.scale.setScalar(1.6 * pulse);
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.opacity = (this.lost ? 0.25 : 0.5) * (0.8 + 0.2 * Math.sin(t * 4.2 + 1.3));
      // Leichte Y-Schwebung des GLOWS (Cube bleibt statisch → Substanz)
      const parts = key.split(",");
      const y = Number(parts[0]), x = Number(parts[1]);
      sprite.position.y = GRID_HEIGHT / 2 - y - 0.5 + Math.sin(t * 2.6 + x * 0.7 + y * 0.5) * 0.08;
    }
  }

  /** Entfernt den Glow-Sprite einer Zelle (aufräumen + dispose). */
  private removeSpecialGlow(y: number, x: number): void {
    const key = `${y},${x}`;
    const glow = this.specialGlows.get(key);
    if (!glow) return;
    this.specialGlows.delete(key);
    if (glow.parent) glow.parent.remove(glow);
    (glow.material as THREE.Material).dispose?.();
    // Textur ist GECACT — NICHT hier dispossen!
  }

  /**
   * Aktualisiert die Würfel aus einer 2D-Matrix (y = Zeile, x = Spalte).
   * @param dimmed färbt das gesamte Feld dunkel (Game-Over / Spectator).
   */
  update(matrix: number[][], dimmed = false): void {
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const cellValue = matrix[y]?.[x] ?? 0;
        const existing = this.meshMatrix[y][x];
        const prevValue = this.values[y][x];

        // Neuen Cube erstellen, wenn: leer→gefüllt ODER Wert gewechselt (z.B. 1→101)
        if (cellValue > 0 && (!existing || prevValue !== cellValue)) {
          if (existing) this.removeAt(y, x);
          const cube = isSpecialCell(cellValue)
            ? createSpecialSphere(
                SPECIAL_COLORS[cellValue] ?? NEON_COLORS.SPECIAL_BOMB,
                CELL_TO_SPECIAL_CHAR[cellValue] ?? "?",
              )
            : createNeonCube(this.colorForCell(cellValue, dimmed || this.lost));
          cube.position.set(x - GRID_WIDTH / 2 + 0.5, GRID_HEIGHT / 2 - y - 0.5, 0);
          this.group.add(cube);
          this.meshMatrix[y][x] = cube;
          this.values[y][x] = cellValue;

          // NACHT 19.10: Special = KUGEL (statt Würfel) + Rotation in pulseSpecials
          if (isSpecialCell(cellValue) && cube.userData.isSpecialSphere) {
            this.specialSpheres.set(`${y},${x}`, cube as THREE.Group);
          }

          // NIGHT 17.8: Glow-Sprite für Special-Steine (pulsierend in pulseSpecials())
          if (isSpecialCell(cellValue)) {
            const colorHex = SPECIAL_COLORS[cellValue] ?? NEON_COLORS.SPECIAL_BOMB;
            const glow = this.makeSpecialGlow(colorHex);
            glow.position.set(x - GRID_WIDTH / 2 + 0.5, GRID_HEIGHT / 2 - y - 0.5, -0.05);
            this.group.add(glow);
            this.specialGlows.set(`${y},${x}`, glow);
          }
        } else if (cellValue === 0 && existing) {
          this.removeAt(y, x);
          this.values[y][x] = 0;
        } else if (cellValue > 0 && existing && prevValue === cellValue) {
          // Kein Wechsel — nur Dimmen ggf. anpassen (wird unten global gemacht)
        }
      }
    }

    // Dimmen (Spectator / Game Over / lost — Nacht 15: Rahmen-Farbe bleibt!)
    const dim = dimmed || this.lost;
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        (mesh.material as THREE.MeshStandardMaterial).opacity = dim ? 0.3 : 0.85;
      }
    });
  }

  /**
   * Rendert das aktive Stück (Client-Side Prediction / Interpolation).
   * null = kein Stück (stück feststellte, Game Over).
   */
  setActivePiece(piece: ActivePiece | null): void {
    if (piece === null) {
      this.disposeActivePiece();
      this.clearGhost(); // NACHT 19.6: kein Stück → kein Schattenstein
      return;
    }
    // Wieder verwenden, wenn sich nur die Position geändert hat (Interpolation)
    if (this.activePieceGroup && (this as any)._lastKey === this.pieceKey(piece)) {
      this.positionActivePiece(piece);
      return;
    }
    this.disposeActivePiece();

    const g = new THREE.Group();
    const color = this.colorForCell(piece.type, false);
    for (const [ox, oy] of pieceOffsets(piece.type, piece.rotation)) {
      const cube = createNeonCube(color);
      // Lokal am Ursprung ausrichten; Position kommt über group.position
      cube.position.set(ox - GRID_WIDTH / 2 + 0.5, GRID_HEIGHT / 2 - oy - 0.5, 0);
      g.add(cube);
    }
    // NACHT 19.5 (BUG-FIX): ZUERST registrieren, DANN positionieren —
    // `positionActivePiece` bricht bei `activePieceGroup === null` ab,
    // und das war hier noch der Fall → Gruppe sass für EINE Frame bei
    // (0,0) → sichtbares Artefakt links oben beim Spawn/Rotation.
    this.group.add(g);
    this.activePieceGroup = g;
    this.positionActivePiece(piece);
    (this as any)._lastKey = this.pieceKey(piece);
  }

  /** Positioniert die aktive Stück-Gruppe (ohne Re-Build) — für Interpolation. */
  public moveActivePiece(piece: ActivePiece): void {
    if (!this.activePieceGroup) return;
    this.positionActivePiece(piece);
  }

  /* ---------------------------------------------------------------- */
  /* NACHT 19.6 (ghostpiece-addon.md): Ghost Piece (Schattenstein)     */
  /* ---------------------------------------------------------------- */

  /**
   * Rendert den Schattenstein auf der Landeposition (ghostY).
   * Gleitet ohne Verzögerung mit — wird bei JEDEM Update des aktiven
   * Steins aufgerufen (Bewegung/Rotation/Spawn). `ghostY = null` → ausblenden.
   * Visuell: gleiche Form/Rotation, ~20% Opazität, entsättigte Farbe (§1.1).
   */
  public setGhost(piece: ActivePiece | null, ghostY: number | null): void {
    if (!piece || ghostY === null || ghostY === undefined) {
      this.clearGhost();
      return;
    }
    // Rebuild nur, wenn sich die FORM ändert (Typ/Drehung) — Position wird
    // unten immer aktualisiert (bewegt sich mit dem Stein, ghostpiece-addon §1.2).
    const key = `${piece.type}:${piece.rotation}`;
    if (this.ghostGroup && this.ghostKey === key) {
      this.ghostGroup.position.set(piece.x, -ghostY, -0.02);
      return;
    }
    this.clearGhost();

    const g = new THREE.Group();
    const color = dimColor(this.colorForCell(piece.type, false), 0.5);
    for (const [ox, oy] of pieceOffsets(piece.type, piece.rotation)) {
      const geo = new THREE.BoxGeometry(0.95, 0.95, 0.95);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2, // ghostpiece-addon §1.1: 20–30% Opazität
        depthWrite: false,
      });
      const cube = new THREE.Mesh(geo, mat);
      cube.position.set(ox - GRID_WIDTH / 2 + 0.5, GRID_HEIGHT / 2 - oy - 0.5, 0);
      g.add(cube);
    }
    // Gruppe erst registrieren, dann positionieren (Nacht-19.5-Lektion:
    // Guard-Abbruch bei unregistriertem Ziel → Ein-Frame-Artefakt).
    this.group.add(g);
    this.ghostGroup = g;
    g.position.set(piece.x, -ghostY, -0.02); // leicht hinter dem aktiven Stein
    this.ghostKey = key;
  }

  /** Schattenstein entfernen + Geometrie/Material räumen (GPU-Leak-Schutz). */
  public clearGhost(): void {
    if (!this.ghostGroup) return;
    this.group.remove(this.ghostGroup);
    this.ghostGroup.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose?.();
        (mesh.material as THREE.Material).dispose?.();
      }
    });
    this.ghostGroup = null;
    this.ghostKey = "";
  }

  private pieceKey(p: ActivePiece): string {
    return `${p.type}:${p.rotation}`;
  }

  /** Grid-Koordinaten (x→rechts, y→unten) → Welt-Koordinaten der Gruppe. */
  private positionActivePiece(piece: ActivePiece): void {
    if (!this.activePieceGroup) return;
    this.activePieceGroup.position.set(piece.x, -piece.y, 0.06);
  }

  /** Entfernt alle Blöcke (z.B. bei Nuke). */
  clear(): void {
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        if (this.meshMatrix[y][x]) this.removeAt(y, x);
      }
    }
    // NIGHT 17.8: alle Glow-Sprites aufräumen
    for (const glow of this.specialGlows.values()) {
      if (glow.parent) glow.parent.remove(glow);
      (glow.material as THREE.Material).dispose?.();
    }
    this.specialGlows.clear();
    this.specialSpheres.clear();
    this.disposeActivePiece();
    this.clearGhost(); // NACHT 19.6
  }

  private disposeActivePiece(): void {
    if (!this.activePieceGroup) return;
    this.group.remove(this.activePieceGroup);
    this.activePieceGroup.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose?.();
        (mesh.material as THREE.Material).dispose?.();
      }
    });
    this.activePieceGroup = null;
  }

  private removeAt(y: number, x: number): void {
    const cube = this.meshMatrix[y][x];
    if (!cube) return;
    this.group.remove(cube);
    cube.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        (mesh.material as THREE.Material).dispose?.();
      }
    });
    this.meshMatrix[y][x] = null;
    // NIGHT 17.8: Glow-Sprite der Zelle aufräumen
    this.removeSpecialGlow(y, x);
    // NACHT 19.10: Kugel-Referenz aus der Rotations-Map entfernen (Geometrie wird
    // oben per traverse() disposal'd).
    this.specialSpheres.delete(`${y},${x}`);
  }

  private colorForCell(cellValue: number, dimmed: boolean): number {
    if (isSpecialCell(cellValue)) {
      // Jeder Special-Buchstabe hat eine eigene Farbe
      return SPECIAL_COLORS[cellValue] ?? NEON_COLORS.SPECIAL_BOMB;
    }
    const base = CELL_COLORS[cellValue] ?? 0xffffff;
    if (dimmed) return dimColor(base, 0.3);
    return base;
  }

  dispose(): void {
    this.clear();
    this.gridGeo?.dispose();
    this.gridMat?.dispose();
    this.frameGeo?.dispose();
    this.frameMat?.dispose();
    this.gridGeo = this.gridMat = this.frameGeo = this.frameMat = null;
  }
}

function dimColor(hex: number, factor: number): number {
  const r = ((hex >> 16) & 255) * factor;
  const g = ((hex >> 8) & 255) * factor;
  const b = (hex & 255) * factor;
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b);
}
