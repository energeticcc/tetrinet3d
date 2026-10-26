import * as THREE from "three";
import { GRID_WIDTH, GRID_HEIGHT } from "@tetrinet3d/shared";
import type { Matrix, ActivePiece, TeamId } from "@tetrinet3d/shared";
import { Grid3D } from "./Grid3D";

export interface GridInstance {
  playerId: string;
  group: THREE.Group;
  grid: Grid3D;
  /** Namens-/Score-Label (Sprite über dem GEGNER-Feld, Nacht 13). Hauptfeld: null. */
  label: THREE.Sprite | null;
  /** Nacht 15: true = Spieler hat verloren (Feld grau, Rahmen-Farbe bleibt). */
  lost: boolean;
  /** Nacht 18.1: Team-Kennung (undefined = Solo) — für Caption in Teamfarbe. */
  teamId: TeamId | undefined;
}

/**
 * Positioniert die 6 Spielfelder im 3D-Raum (Hufeisen).
 * Spieler 1 (lokal) steht im Fokus, Gegner 1–5 auf einem Kreisbogen dahinter.
 * (Vorlage: md/Arena.ts)
 */
export class Arena {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  public grids: Map<string, GridInstance> = new Map();

  /** Basis-Kamera-Distanz (z) bei Standard-Viewport (Breitbild). */
  private static readonly CAMERA_Z = 7;
  /** Maximale Kamera-Distanz (Portrait: weit genug zurück, damit nichts abgeschnitten wird). */
  private static readonly CAMERA_Z_MAX = 60;
  /** LookAt-Z (Tiefe bei der die Felder stehen: Hauptfeld -11, Gegner -14). */
  private static readonly LOOK_Z = -12;
  /** Leichte Top-Down-Kippung (Kamera-Y über der Szene-Mitte). */
  private static readonly CAM_Y_OFFSET = 2.0;

  /* ---------------------------------------------------------------- */
  /* Layout-Konstanten (Welt-Einheiten)                                */
  /* ---------------------------------------------------------------- */
  /** Hauptfeld: links, groß (Skala 0.95). */
  static readonly MAIN_X = -6.0;
  static readonly MAIN_Y = 0;
  static readonly MAIN_SCALE = 0.95;
  /** Nächste Steine: horizontale Reihe OBEN über dem Hauptfeld (Nacht 12: etwas tiefer,
   *  damit das „NÄCHSTE STEINE"-Label darüber noch im Bild ist). */
  static readonly NEXT_Y = (GRID_HEIGHT / 2) * Arena.MAIN_SCALE + 1.1;
  /** Gegner-Felder: RECHTS, 2 pro Reihe (2 + 2 + 1 zentriert), Skala 0.34. */
  static readonly OP_SCALE = 0.34;
  static readonly OP_CX = 6.5;

  /** Bounding-Box der Szene (für die Kamera-Framing). */
  private bound = { minX: -10, maxX: 10, minY: -11, maxY: 11 };

  /**
   * Nacht 17.6: STABILE Slot-Zuordnung (playerId → 1..5).
   * BUG-FIX „Gegnerische Felder überlappen/springen nach einiger Zeit":
   * Vorher bekam jeder Gegner seine Position aus seiner LAGE in der
   * room_state-Reihenfolge + der ANZAHL (nOpp) — beides wechselt bei
   * jedem Join/Leave/Umbenennen/Rematch (Ghost-LAN-Client, AI-Re-Registrierung)
   * → das 2+2+1-Layout floss um und Felder überschnitten sich.
   * Jetzt: Jeder Spieler behält seinen Slot (1..5) über Re-Layouts;
   * neue Spieler bekommen den ersten freien Slot; verlassene Slots werden
   * bereinigt. Die Positionen sind FIXIERT (2+2+1), unabhängig von nOpp.
   */
  private opponentSlots = new Map<string, number>();

  /**
   * Nacht 15: Pixel-Position der freien Lücke (Zentrum) zwischen Hauptfeld
   * und Gegnerfeldern — wird von applyCameraFraming() berechnet und vom
   * Client genutzt, um das HTML-Inventar exakt dort zu positionieren.
   * (0,0 = nicht berechnet)
   */
  public inventoryScreenPos: { x: number; y: number } | null = null;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
  }

  /**
   * Rahmt die Szene so, dass ALLE Felder (Hauptfeld + Gegner-Raster + Next)
   * bei JEDER Viewport-Größe vollständig sichtbar sind.
   *
   * Perspektive (2.5D) ist KERN-SPEZIFIKATION (Nacht 17.4: Ortho-Experiment
   * reverted). Die Fluchtlinien-Verzerrung wird dadurch in Grenzen gehalten,
   * dass die Kamera NUR SENKRECHT VOR dem Hauptfeld (Fokus-Feld) steht —
   * das Hauptfeld selbst bleibt ein Rechteck; nur die weiter entfernten
   * Gegner-Felder bekommen die gewünschte 3D-Tiefenwirkung.
   */
  public applyCameraFraming(viewportWidthPx: number, viewportHeightPx: number): void {
    const cam = this.camera;
    const aspect = viewportWidthPx / viewportHeightPx;
    const tanHalfFov = Math.tan((cam.fov * Math.PI) / 360);

    const b = this.bound;
    const sceneW = b.maxX - b.minX;
    const sceneH = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;

    // Nacht 15 (Root-Cause-Fix): Freie Fläche aus den ECHTEN Panel-Rändern
    // (bounding box, inkl. 16px-Margin) berechnen — vorher wurden nur die
    // Panel-Breiten vom Viewport abgezogen, die 16px-Margins wurden ignoriert
    // → Szene 32px zu breit + 16px nach links verschoben (Hauptfeld überlappte
    // linke Liste, Gegner rutschten an den Chat, Inventar lag auf Hauptfeld).
    const rect = (id: string): DOMRect | null => (typeof document !== "undefined"
      ? (document.getElementById(id)?.getBoundingClientRect() ?? null) : null);
    const left = rect("left-panel");
    const chat = rect("chat-box");
    const freeLeft = (left ? left.right : 0) + 8;        // rechter Rand links + Atemraum
    const freeRight = (chat ? chat.left : viewportWidthPx) - 8; // linker Rand rechts − Atemraum
    const freeW = Math.max(80, freeRight - freeLeft);     // freie Breite in px
    const freeCenterPx = (freeLeft + freeRight) / 2;       // Mittelpunkt (px von links)

    // Nacht 17.4: Kamera zentriert auf das HAUPTFELD (Fokus-Feld, Index 0),
    // NICHT auf das Szenen-Zentrum. Damit sind die Raster-Blöcke im Hauptfeld
    // QUADRATISCH (keine Fluchtlinien-Verzerrung); nur die weiter rechts
    // stehenden Gegner-Felder bekommen die gewünschte 3D-Tiefenwirkung.
    const mainHalfW = (GRID_WIDTH / 2) * Arena.MAIN_SCALE;
    const mainHalfH = (GRID_HEIGHT / 2) * Arena.MAIN_SCALE;
    // Hauptfeld-Zentrum in Welt-Koordinaten
    const mainCx = Arena.MAIN_X;
    const mainCy = Arena.MAIN_Y;

    // Distanz: so wählen, dass das HAUPTFELD in die freie Fläche passt.
    // (Gegner-Felder ragen rechts raus — bei 60° FOV und ~15 Distanz ist
    //  die zusätzliche Breite kein Problem; das Free-Clamp unten schützt.)
    const distForMainW = (mainHalfW * 1.5) / ((freeW / viewportWidthPx) * tanHalfFov * aspect);
    const distForMainH = (mainHalfH * 1.2) / tanHalfFov;
    const dist = Math.max(distForMainW, distForMainH, 8);

    // Hauptfeld-Mitte (mainCx) auf den LINKEN Teil der freien Fläche legen —
    // Gegner-Felder haben Platz rechts. (Nicht auf freier Mitte!)
    const freeNdcX = (2 * (freeLeft + freeW * 0.38) / viewportWidthPx) - 1;
    const camX = mainCx - freeNdcX * tanHalfFov * aspect * dist;
    // Nacht 17.4: NUR SEHR KLEINE Kamera-Höhe — jede senkrechte Verschiebung
    // erzeugt ein Vertikales-Trapez (Steine wirken flach). 1.2 statt 2.0.
    const camY = mainCy + 0.8;
    const camZ = -11 + dist;  // LOOK_Z für Hauptfeld = -11

    cam.position.set(camX, camY, camZ);
    cam.lookAt(camX, mainCy, -11);

    // Nacht 15: Position der freien Lücke (Zentrum) in Pixeln merken —
    // Hauptfeld-RECHTE Kante und Gegner-LINKE Kante projizieren, Mitte dazwischen.
    const worldToScreenPx = (worldX: number): number => {
      const ndcX = (worldX - camX) / (tanHalfFov * aspect * dist);
      return (ndcX / 2 + 0.5) * viewportWidthPx;
    };
    // Hauptfeld: rechte Kante (mainHalfW bereits oben für die Kamera definiert).
    const mainRightWorld = Arena.MAIN_X + mainHalfW;
    // Gegner-Spalte: linke Kante = (OP_CX − Spaltenbreite/2) − Feldbreite/2.
    const oppFieldW = Arena.OP_SCALE * GRID_WIDTH;
    const oppColHalf = (oppFieldW + 1.0) / 2;       // COL_SPACING/2 (GAP=1.0)
    const oppLeftWorld = Arena.OP_CX - oppColHalf - oppFieldW / 2;
    const mainRightPx = worldToScreenPx(mainRightWorld);
    const oppLeftPx = worldToScreenPx(oppLeftWorld);
    // Fallback, falls Panels fehlen (Test-/SSR-Umgebung): Zentrum der freien Fläche.
    const gapCenter = (Number.isFinite(mainRightPx) && Number.isFinite(oppLeftPx))
      ? (mainRightPx + oppLeftPx) / 2
      : freeCenterPx;
    this.inventoryScreenPos = { x: gapCenter, y: viewportHeightPx / 2 };
  }

  /**
   * Layout (Nacht 11):
   *  - HAUPTFELD: links, groß (Skala 0.95), frontal. MAIN_X=-6.
   *    - ÜBER: "Nächste Steine" horizontal (3D).
   *    - UNTER: Specials-Panel (HTML).
   *  - GEGNER 1–5: RECHTS, 2 pro Reihe (wie gewünscht: „2 nebeneinander,
   *    darunter die nächsten 2"):
   *      Reihe 0:  Gegner 1, 2
   *      Reihe 1:  Gegner 3, 4
   *      Reihe 2:  Gegner 5 (zentriert)
   *    Skala 0.34, GAP 1.0 (klare Abstände).
   *  - LINKE SEITE: HTML-UI (#left-panel).
   *
   * Die Kamera-Framing rechnet automatisch die Bounding-Box aus.
   * @param players Liste der Spieler-IDs (Index 0 = lokaler Spieler)
   * @param playerTeams playerId → TeamId (optional). Nacht 18.1: Wenn der
   *   lokale Spieler (players[0]) in einem Team ist, werden die TEAMMATES in
   *   die vordere Reihe (Slots 1-2) gesetzt und die anderen Gegner dahinter
   *   (Slots 3-5). Ohne Team-Info bleibt das 2+2+1-Layout wie bisher.
   */
  public setupArena(players: string[], playerTeams?: Map<string, TeamId | undefined>): void {
    this.clearArena();
    this.bound = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

    // Gegner-Layout: 2 pro Reihe, die 5. zentriert in Reihe 2.
    const OP_Z = -14;
    const OP_FIELD_W = Arena.OP_SCALE * 12;             // 4.08
    const OP_FIELD_H = Arena.OP_SCALE * GRID_HEIGHT;    // 7.48
    const GAP = 1.0;
    const COL_SPACING = OP_FIELD_W + GAP;               // 5.08
    const ROW_SPACING = OP_FIELD_H + GAP;               // 8.48
    const COL_L = Arena.OP_CX - COL_SPACING / 2;        // 3.96
    const COL_R = Arena.OP_CX + COL_SPACING / 2;        // 9.04

    // NIGHT 17.6 (Bug-Fix „Gegner-Felder überlappen/springen nach einiger Zeit"):
    // FIXIERTE 2+2+1-Positionen (inverted Pyramid) — UNABHÄNGIG von der
    // Gegner-Anzahl (nOpp). Vorher floss das Layout bei jedem Join/Leave/
    // Rematch um (rowOffset-Formel + Slot=index) → Felder sprangen/überschnitten.
    const OP_POS: Record<number, { x: number; y: number }> = {
      1: { x: COL_L, y: -ROW_SPACING },   // unten links
      2: { x: COL_R, y: -ROW_SPACING },   // unten rechts
      3: { x: COL_L, y: 0 },              // mitte links
      4: { x: COL_R, y: 0 },              // mitte rechts
      5: { x: Arena.OP_CX, y: ROW_SPACING }, // oben zentriert
    };
    // STABILE Slot-Zuordnung (playerId → 1..5): Jeder Gegner behält seinen
    // Platz über Re-Layouts; neue Gegner nehmen den ersten freien Slot;
    // verlassene Slots werden bereinigt. → Felder bleiben IMMER am gleichen Platz.
    const oppIds = players.slice(1);

    // NACHT 18.1: Team-Gruppierung. Wenn der lokale Spieler (players[0]) in
    // einem Team ist, werden seine TEAMMATES in die VORDERE Reihe (Slots 1-2,
    // "unten" = näher an der Kamera) gesetzt und die übrigen Gegner dahinter
    // (Slots 3-5). Ohne Team-Info bleibt die Beitrittsreihenfolge.
    const selfTeam = playerTeams?.get(players[0]);
    const priority = (id: string): number => {
      if (selfTeam) {
        const t = playerTeams?.get(id);
        if (t === selfTeam) return 0; // Teammate → vordere Reihe
        return 1;                     // anderer Gegner → hintere Reihe
      }
      return 0;
    };
    // Teammates zuerst, bei gleicher Priorität: Beitrittsreihenfolge (stabil).
    const sortedOppIds = oppIds.slice().sort((a, b) => {
      const pa = priority(a) - priority(b);
      if (pa !== 0) return pa;
      return oppIds.indexOf(a) - oppIds.indexOf(b);
    });
    for (const key of [...this.opponentSlots.keys()]) {
      if (!oppIds.includes(key)) this.opponentSlots.delete(key);
    }
    const taken = new Set(this.opponentSlots.values());
    for (const id of sortedOppIds) {
      if (!this.opponentSlots.has(id)) {
        for (let s = 1; s <= 5; s++) {
          if (!taken.has(s)) { this.opponentSlots.set(id, s); taken.add(s); break; }
        }
      }
    }

    players.forEach((playerId, index) => {
      const group = new THREE.Group();
      const grid = new Grid3D();
      group.add(grid.group);

      let px: number, py: number;

      if (index === 0) {
        // Hauptfeld: links, groß.
        // Nacht 17.4: LEICHTE 3D-NEGUNG (Kern-Spezifikation 2.5D/3D):
        //   - YAW -8°   → Feld nach rechts geneigt (rechter Rand näher)
        //   - PITCH +3° → leichte Top-Down-Kippung
        // Die Raster-Steine sollen dabei möglichst QUADRATISCH wirken →
        // kleine Winkel + Kamera nahe senkrecht vor dem Feld (siehe
        // applyCameraFraming: Fokus auf Hauptfeld, kleine CAM_Y_OFFSET).
        // Die Gegner-Felder bleiben FLACH (2D), wie gewünscht (Nacht 17.4).
        px = Arena.MAIN_X;
        py = Arena.MAIN_Y;
        group.position.set(px, py, -11);
        group.scale.setScalar(Arena.MAIN_SCALE);
        group.rotation.set(0.035, 0.10, 0, "YXZ");
      } else {
        // NIGHT 17.6: Position aus dem STABILEN Slot (1..5) — fixierte 2+2+1,
        // unabhängig von der Gegner-Anzahl. Der Slot bleibt über Re-Layouts
        // erhalten → jedes Gegner-Feld steht IMMER am gleichen Platz.
        const slot = this.opponentSlots.get(playerId) ?? 1;
        const pos = OP_POS[slot] ?? OP_POS[1];
        px = pos.x;
        py = pos.y;

        group.position.set(px, py, OP_Z);
        group.scale.setScalar(Arena.OP_SCALE);
      }

      // Alle Felder stehen frontal (XY-Ebene, Blickrichtung +Z) — die Kamera
      // kommt mittig davor → stabiles, unverzerrtes 2.5D-Layout.
      const hw = (group.scale.x * 12) / 2;
      const hh = (group.scale.y * GRID_HEIGHT) / 2;

      // Namens-/Score-Label (Nacht 13): NUR GEGNER — OBEN über dem Feld,
      // GENAU SO BREIT wie das Spielfeld, Name linksbündig + Score rechtsbündig
      // in einer Reihe. Beim HAUPTFELD gibt es KEIN Label (Nacht 13).
      let labelSprite: THREE.Sprite | null = null;
      let labelY = 0;
      if (index !== 0) {
        labelSprite = Arena.createLabelSprite("");
        const labelW = hw * 2;      // gleiche Breite wie das Feld
        const labelH = labelW * 0.14;
        labelSprite.scale.set(labelW, labelH, 1);
        labelY = py + hh + labelH * 0.75;   // OBEN über dem Feld
        labelSprite.position.set(px, labelY, OP_Z + 0.1);
        this.scene.add(labelSprite);
      }

      this.scene.add(group);
      const teamId = playerTeams?.get(playerId) ?? undefined;
      this.grids.set(playerId, { playerId, group, grid, label: labelSprite, lost: false, teamId });

      // Bounding-Box aktualisieren (Label-Position mit einbeziehen)
      this.bound.minX = Math.min(this.bound.minX, px - hw);
      this.bound.maxX = Math.max(this.bound.maxX, px + hw);
      this.bound.minY = Math.min(this.bound.minY, py - hh);
      this.bound.maxY = Math.max(this.bound.maxY, py + hh, labelSprite ? labelY + labelSprite.scale.y / 2 : 0);
    });

    // Next-Piece (über dem Hauptfeld) in die Bounding-Box einbeziehen
    const nextY = Arena.NEXT_Y;
    const nextHW = 3.5;
    this.bound.maxY = Math.max(this.bound.maxY, nextY + 2);
    this.bound.minX = Math.min(this.bound.minX, Arena.MAIN_X - nextHW);
    this.bound.maxX = Math.max(this.bound.maxX, Arena.MAIN_X + nextHW);
  }

  /** Aktualisiert die Blöcke eines Felds. */
  public updateGrid(playerId: string, matrix: Matrix, dimmed = false): void {
    this.grids.get(playerId)?.grid.update(matrix, dimmed);
  }

  /** Aktualisiert das aktive Stück eines Felds (null = nichts). */
  public setActivePiece(playerId: string, piece: ActivePiece | null): void {
    this.grids.get(playerId)?.grid.setActivePiece(piece);
  }

  /** Bewegt das aktive Stück eines Felds ohne Re-Build (Interpolation). */
  public moveActivePiece(playerId: string, piece: ActivePiece): void {
    this.grids.get(playerId)?.grid.moveActivePiece(piece);
  }

  /** Liefert die 3D-Gruppe eines Felds (für Effekte). */
  public getGroup(playerId: string): THREE.Group | null {
    return this.grids.get(playerId)?.group ?? null;
  }

  /** Liefert die Grid3D-Instanz (z.B. zum Dimmen). */
  public getGrid(playerId: string): Grid3D | null {
    return this.grids.get(playerId)?.grid ?? null;
  }

  /**
   * Aktualisiert das Namens-/Score-Label eines GEGNER-Felds (Nacht 13).
   * Hauptfeld: kein Label.
   * Nacht 17.2: `fieldNo` = Feld-Nummer (1 = eigenes Feld, 2–6 = Gegner) als
   *  Badge links im Label — der Spieler kann so Tasten 1–6 zuordnen.
   * `lost` = Spieler ausgeschieden → graue Caption (Rahmen-Farbe bleibt, Nacht 15).
   * NACHT 18.1: `teamColor` = Team-Farbe (0xRRGGBB, undefined = Solo) — die
   *  Caption-Rahmen-/Badge-Farbe wird in der Teamfarbe gezeichnet.
   */
  public updateLabel(playerId: string, name: string, score: number, fieldNo = 0, lost = false, teamColor?: number): void {
    const inst = this.grids.get(playerId);
    if (!inst || !inst.label) return;
    const tex = (inst.label.material as THREE.SpriteMaterial).map as THREE.Texture | null;
    if (!tex) return;
    const canvas = (tex as any).__canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;
    Arena.drawLabel(canvas, name, score, fieldNo, lost, teamColor);
    tex.needsUpdate = true;
  }

  /** Setzt die Rahmenfarbe eines Spielfelds (Spieler-/Teamfarbe, Nacht 12). */
  public setFrameColor(playerId: string, colorHex: number): void {
    this.grids.get(playerId)?.grid.setFrameColor(colorHex);
  }

  /** Erzeugt ein Sprite mit weißem Text auf abgerundetem dunklem Panel. */
  private static createLabelSprite(_text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    // Breit/flach (Nacht 13): Name + Score in einer Reihe. Aspect ~7:1 passt
    // zum Sprite-Scale (labelH = labelW * 0.14).
    canvas.width = 700;
    canvas.height = 100;
    Arena.drawLabel(canvas, "", 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    (tex as any).__canvas = canvas;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 10;
    return sprite;
  }

  /** Erzeugt ein einzeiliges Text-Label-Sprite (z.B. „NÄCHSTE STEINE“). */
  static createTextLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    Arena.drawTextLabel(canvas, text);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    (tex as any).__canvas = canvas;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 10;
    return sprite;
  }

  /** Zeichnet einen einzeiligen Text auf die Canvas (zentriert, auf dunklem Panel). */
  private static drawTextLabel(canvas: HTMLCanvasElement, text: string): void {
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(8,10,14,0.75)";
    ctx.strokeStyle = "rgba(100,120,150,0.4)";
    ctx.lineWidth = 2;
    const pad = 4, r = 16;
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.arcTo(W - pad, pad, W - pad, H - pad, r);
    ctx.arcTo(W - pad, H - pad, pad, H - pad, r);
    ctx.arcTo(pad, H - pad, pad, pad, r);
    ctx.arcTo(pad, pad, W - pad, pad, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#c0c8d8";
    ctx.font = "700 42px system-ui, sans-serif";
    ctx.letterSpacing = "3px";
    ctx.fillText(text, W / 2, H / 2);
    ctx.letterSpacing = "0px";
  }

  /**
   * Zeichnet Name (linksbündig) + Score (rechtsbündig) in EINER REIHE (Nacht 13).
   * Nacht 17.2: optionales Feld-Nummern-Badge (entspricht Taste 1–6) am linken
   * Rand + graue Hintergrund-/Textfarbe bei `lost` (ausgeschiedener Spieler).
   * NACHT 18.1: `teamColor` (0xRRGGBB, undefined = Solo) → Caption-Rahmen +
   * Badge in der Teamfarbe (deutlich sichtbarer als der graue Standard).
   */
  private static drawLabel(canvas: HTMLCanvasElement, name: string, score: number, fieldNo = 0, lost = false, teamColor?: number): void {
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Nacht 18.1: Rahmen-Farbe: Solo = Blau (Standard), Team = Teamfarbe,
    // lost = grau (Rahmen bleibt, Nacht 15).
    const frameStroke = lost
      ? "rgba(160,165,175,0.65)"
      : teamColor !== undefined
        ? rgbaHex(teamColor, 0.85)
        : "rgba(120,140,170,0.55)";
    // abgerundetes dunkles Panel (Nacht 17.2: grau bei ausgeschiedenen)
    const pad = 6, r = 18;
    ctx.fillStyle = lost ? "rgba(70,74,82,0.9)" : "rgba(8,10,14,0.82)";
    ctx.strokeStyle = frameStroke;
    ctx.lineWidth = teamColor !== undefined && !lost ? 3 : 2;
    const rr = (x: number, y: number, w: number, h: number, rad: number) => {
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    };
    rr(pad, pad, W - pad * 2, H - pad * 2, r);
    ctx.fill();
    ctx.stroke();
    // EINER REIHE: [Badge #n] Name linksbündig, Score rechtsbündig — mittig vertikal.
    ctx.textBaseline = "middle";
    // Nacht 17.2: Feld-Nummern-Badge (entspricht Taste 1–6) am linken Rand.
    let nameX = pad + 14;
    if (fieldNo >= 1) {
      ctx.font = "800 44px system-ui, sans-serif";
      const bw = ctx.measureText(String(fieldNo)).width + 26;
      const bh = 58;
      const bx = pad + 8, by = (H - bh) / 2;
      // Nacht 18.1: Badge-Farbe = Teamfarbe (falls Team), sonst Standard.
      const badgeFill = lost
        ? "rgba(40,42,48,0.9)"
        : teamColor !== undefined
          ? rgbaHex(teamColor, 0.35)
          : "rgba(30,40,60,0.9)";
      const badgeText = lost ? "#aab0ba" : teamColor !== undefined ? rgbaHex(teamColor, 1) : "#7fd4ff";
      ctx.fillStyle = badgeFill;
      const r2 = 12;
      ctx.beginPath();
      ctx.moveTo(bx + r2, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, r2);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, r2);
      ctx.arcTo(bx, by + bh, bx, by, r2);
      ctx.arcTo(bx, by, bx + bw, by, r2);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = badgeText;
      ctx.fillText(String(fieldNo), bx + bw / 2, H / 2 + 2);
      nameX = bx + bw + 12;
    }
    ctx.font = "600 46px system-ui, sans-serif";
    // Name: linksbündig, bei Bedarf kürzen (dass er Score nicht berührt)
    let displayName = name.length > 20 ? name.slice(0, 19) + "…" : name;
    ctx.textAlign = "left";
    ctx.fillStyle = lost ? "#9aa0aa" : "#e8ecf2";
    const nameMaxW = (W * 0.62) - (nameX - (pad + 14));
    while (ctx.measureText(displayName).width > nameMaxW && displayName.length > 3) {
      displayName = displayName.slice(0, -2) + "…";
    }
    ctx.fillText(displayName, nameX, H / 2);
    // Score: rechtsbündig
    ctx.textAlign = "right";
    ctx.fillStyle = lost ? "#b8bdc6" : "#ffffff";
    ctx.font = "700 52px system-ui, sans-serif";
    ctx.fillText(String(score), W - pad - 14, H / 2);
  }

  public clearArena(): void {
    for (const inst of this.grids.values()) {
      this.scene.remove(inst.group);
      // Nacht 15: Wais-Labels mit entfernen (Bug-Fix: Label bleibt sonst stehen,
      // wenn das zugehörige Spielfeld entfernt wurde — z.B. nach removePlayer/Rematch).
      if (inst.label) {
        this.scene.remove(inst.label);
        const mat = inst.label.material as THREE.SpriteMaterial;
        mat.map?.dispose?.();
        mat.dispose?.();
      }
      inst.grid.dispose();
    }
    this.grids.clear();
  }
}

/**
 * Nacht 18.1: Wandelt eine 0xRRGGBB-Farbe in eine CSS-RGBA-String um.
 * Alpha 0..1. Verwendet für die Teamfarbige Caption im Leaderboard-Label.
 */
function rgbaHex(color: number, alpha: number): string {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
