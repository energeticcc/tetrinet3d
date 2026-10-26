import * as THREE from "three";

/**
 * Erzeugt einen kombinierten 3D-Neon-Würfel (Solid Block + glühende Kanten).
 * (Vorlage: md/Grid3D.ts)
 */
export function createNeonCube(colorHex: number): THREE.Group {
  const cubeGroup = new THREE.Group();
  const size = 0.95;

  // 1. Der solide Innenkern (leicht transparentes Glas-Aussehen)
  const geometry = new THREE.BoxGeometry(size, size, size);
  const material = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.1,
    metalness: 0.8,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  const coreMesh = new THREE.Mesh(geometry, material);
  cubeGroup.add(coreMesh);

  // 2. Die glühenden Außenkanten (Neon Wireframe)
  const edgesGeometry = new THREE.EdgesGeometry(geometry);
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: colorHex,
    blending: THREE.AdditiveBlending,
  });
  const wireframe = new THREE.LineSegments(edgesGeometry, edgeMaterial);
  cubeGroup.add(wireframe);

  return cubeGroup;
}

/**
 * Farb-Palette für die verschiedenen Blöcke und Specials im Tetrinet.
 * (Vorlage: md/Grid3D.ts)
 */
export const NEON_COLORS = {
  // Standard Tetris Blöcke
  I: 0x00f0f0, // Cyan
  O: 0xf0f000, // Gelb
  T: 0xa000f0, // Lila
  S: 0x00f000, // Grüner Neon-Glow
  Z: 0xf00000, // Rot
  J: 0x0000f0, // Blau
  L: 0xf0a000, // Orange

  // Nacht 18.1: Garbage-Linie (attack-addlines.md §3: "einfarbige, graue
  // Standardblöcke" — deutlich dunkler als der Neon-Look der Tetrominos).
  GARBAGE: 0x556066, // Graublau (dunkel, nicht zu dezent)

  // Tetrinet Specials (Knalliges Pink/Weiß für Aufmerksamkeit)
  SPECIAL_BOMB: 0xff0055, // Intensives Neon-Pink
  SPECIAL_GENERIC: 0xffffff, // Kaltweißes Glühen
};

/**
 * Eigene Farbe pro Tetrinet-Special-Buchstabe (Zell-Code 101–109).
 * Alle 9 Farben sind distincte Neon-Farben — keine Überlappung mit den
 * Tetromino-Farben (Cyan/Gelb/Lila/Grün/Rot/Blau/Orange) oder Spieler-Farben.
 */
export const SPECIAL_COLORS: Record<number, number> = {
  101: 0xff6600, // A — Orange-Rot
  102: 0x00aaff, // C — Hellblau
  103: 0xffff44, // B — Gelb
  104: 0xff00cc, // R — Magenta
  105: 0x44ffff, // O — Hellcyan
  106: 0xffcc00, // S — Gold (Switch Fields)
  107: 0x66ff33, // G — Hellgrün
  108: 0xcc88ff, // Q — Hellviolet
  109: 0xff2222, // N — Rot
};

/* ------------------------------------------------------------------ */
/* Special-Cube mit Buchstabe-Texture (Nacht 12)                      */
/* ------------------------------------------------------------------ */
const LETTER_TEXTURE_CACHE: Record<string, THREE.Texture> = {};

/**
 * Erzeugt eine Canvas-Texture mit dem Buchstaben (weiß, fett) auf
 * transparentem Hintergrund. Wird pro (letter, color) gecacht.
 */
function letterTexture(letter: string, colorHex: number): THREE.Texture {
  const key = `${letter}-${colorHex}`;
  if (LETTER_TEXTURE_CACHE[key]) return LETTER_TEXTURE_CACHE[key];
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Transparenter Hintergrund (Cube-Kern liefert die Farbe)
  ctx.clearRect(0, 0, size, size);
  // Weiße Buchstaben mit schwarzem Outline für Lesbarkeit
  ctx.font = "bold 92px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(letter, size / 2, size / 2);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(letter, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  LETTER_TEXTURE_CACHE[key] = tex;
  return tex;
}

/**
 * NACHT 19.10 (RETIRED): Special-Würfel mit Buchstaben-Platten — ersetzt durch
 * `createSpecialSphere` (Kugel + Rotation). Funktion bleibt als Referenz für
 * das alte Rendering (Fallback / Debug).
 * @deprecated seit Nacht 19.10 — nutze `createSpecialSphere`.
 */
export function createSpecialCube(colorHex: number, letter: string): THREE.Group {
  const g = new THREE.Group();
  const size = 0.95;
  const geo = new THREE.BoxGeometry(size, size, size);

  // 1) Solider Innenkern (wie Neon-Cube)
  const coreMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.15,
    metalness: 0.7,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  g.add(new THREE.Mesh(geo, coreMat));

  // 2) Neon-Kanten (wie Neon-Cube)
  const edges = new THREE.EdgesGeometry(geo);
  g.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
    color: colorHex,
    blending: THREE.AdditiveBlending,
  })));

  // 3) Buchstaben-Overlay (leicht vor der Cube-Oberfläche, Z-fach)
  const letterMat = new THREE.MeshBasicMaterial({
    map: letterTexture(letter, colorHex),
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const letterPlaneSize = size * 0.78;
  const letterGeo = new THREE.PlaneGeometry(letterPlaneSize, letterPlaneSize);
  const offset = size / 2 + 0.005;
  // 4 Seiten (vorne/hinten/links/rechts) — Buchstaben sind auf allen Seiten sichtbar.
  const planes: Array<[number, number, number, number]> = [
    // pos.x, pos.y, pos.z, rotY
    [0, 0, offset, 0],
    [0, 0, -offset, Math.PI],
    [offset, 0, 0, Math.PI / 2],
    [-offset, 0, 0, -Math.PI / 2],
  ];
  for (const [px, py, pz, ry] of planes) {
    const plane = new THREE.Mesh(letterGeo, letterMat);
    plane.position.set(px, py, pz);
    plane.rotation.y = ry;
    g.add(plane);
  }

  return g;
}

/**
 * NACHT 19.10 (Sonder-UI): Special-KUGEL statt Würfel. Kugelform + Buchstaben-
 * Platten, die mitrotieren. `rotateSpecialSphere(group, angle)` dreht Kugel +
 * Buchstaben zusammen um die Y-Achse (wird pro Frame aus `pulseSpecials`
 * gerufen).
 */
export function createSpecialSphere(colorHex: number, letter: string): THREE.Group {
  const g = new THREE.Group();
  g.userData.isSpecialSphere = true;
  const r = 0.48;
  const geo = new THREE.SphereGeometry(r, 24, 16);

  // 1) Solider Innenkern
  const coreMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.15,
    metalness: 0.7,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  g.add(new THREE.Mesh(geo, coreMat));

  // 2) Neon-Kontur: additiver Ring (Kugelsilhouette) — 32-Punkte-Loop.
  const ringMat = new THREE.LineBasicMaterial({
    color: colorHex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.9,
  });
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 32 }, (_, i) => {
        const a = (i / 32) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * r * 1.01, Math.sin(a) * r * 1.01, 0);
      }),
    ),
    ringMat,
  );
  g.add(ring);

  // 3) Buchstaben-Platten — 4 Seiten + obere + untere, leicht VOR der Kugelfläche.
  const letterMat = new THREE.MeshBasicMaterial({
    map: letterTexture(letter, colorHex),
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const size = r * 1.5;
  const letterGeo = new THREE.PlaneGeometry(size, size);
  const offset = r + 0.01;
  const planes: Array<[number, number, number, number, number]> = [
    // pos.x, pos.y, pos.z, rotY, rotX
    [0, 0, offset, 0, 0],
    [0, 0, -offset, Math.PI, 0],
    [offset, 0, 0, Math.PI / 2, 0],
    [-offset, 0, 0, -Math.PI / 2, 0],
    [0, offset, 0, 0, -Math.PI / 2],
    [0, -offset, 0, 0, Math.PI / 2],
  ];
  for (const [px, py, pz, ry, rx] of planes) {
    const plane = new THREE.Mesh(letterGeo, letterMat);
    plane.position.set(px, py, pz);
    plane.rotation.y = ry;
    plane.rotation.x = rx;
    g.add(plane);
  }

  return g;
}

/**
 * NACHT 19.10: Dreht Special-Kugel + Buchstaben-Platten um die Y-Achse.
 * (Kugelsymmetrie → Kern sieht unverändert aus, Platten rotieren sichtbar mit;
 * Kinder der Gruppe erben die Rotation automatisch.)
 */
export function rotateSpecialSphere(group: THREE.Group, angle: number): void {
  if (!group.userData.isSpecialSphere) return;
  group.rotation.y = angle;
}
