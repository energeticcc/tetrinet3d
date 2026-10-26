/**
 * NACHT 19.6 + 19.7 (ghostpiece-addon.md + inventory-addon.md):
 *  - ghostPosition: korrekte Hard-Drop-Position (pure, non-mutating)
 *  - clearLinesAndCollectSpecials: MULTIPLIKATOR (Single ×1 / Double ×2 / Tetris ×4)
 *  - MAX_SPECIALS = 18 (Overflow-Kappe)
 *  - handleUseSpecial: STRICT FIFO (nur Index 0 feuert; alles andere verworfen)
 *  - Player.afterLock: Multiplikator durchläuft bis ins Inventory
 *
 * Aufruf: node scripts/test-ghost-fifo.mjs
 */
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  MAX_SPECIALS,
  createEmptyGrid,
  ghostPosition,
  clearLinesAndCollectSpecials,
  SPECIAL_CHAR_TO_CELL,
} from "../packages/shared/dist/index.js";
import { Player } from "../packages/server/dist/game/Player.js";
import { GameRoom } from "../packages/server/dist/game/Room.js";
import { GameLoop } from "../packages/server/dist/game/GameLoop.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${detail}`); failures++; }
}

/* ---------------------------------------------------------------- */
console.log("\n[1] ghostPosition: Hard-Drop-Landing-Position");
{
  // Leeres Feld: O-Block (type=2, rot=0) hat seine 2×2-Blöcke bei Box-Zeilen 1+2
  // (pieceOffsets: y=1,2) → Landepunkt y = GRID_HEIGHT - 1 - 2 = 19.
  const g = createEmptyGrid();
  const piece = { type: 2, rotation: 0, x: 5, y: 10 };
  const gy = ghostPosition(g, piece);
  check("leeres Feld: O-Block landet bei y=19", gy === 19, `got ${gy}`);
  // Stück bewegt sich NICHT (non-mutating).
  check("Stück nach Aufruf unverändert", piece.y === 10 && piece.x === 5 && piece.rotation === 0);

  // 2 Zellen Stack in den Blockspalten (x=5 → Spalten 6,7; y=20,21)
  // → O-Block (2 Zeilen hoch, Box-Rows 1-2) landet bei y = 19 - 2 = 17.
  const g2 = createEmptyGrid();
  for (let y = 20; y <= 21; y++) g2[y][6] = 1, g2[y][7] = 1;
  const gy2 = ghostPosition(g2, piece);
  check("2-Zeilen-Stack: O-Block landet bei y=17", gy2 === 17, `got ${gy2}`);

  // 3 Zellen Stack → O-Block landet bei y=16.
  const g2b = createEmptyGrid();
  for (let y = 19; y <= 21; y++) g2b[y][6] = 1, g2b[y][7] = 1;
  const gy2b = ghostPosition(g2b, piece);
  check("3-Zeilen-Stack: O-Block landet bei y=16", gy2b === 16, `got ${gy2b}`);

  // Ghost Y ist IMMER >= Stück-y (nie über dem aktuellen Ort).
  const g3 = createEmptyGrid();
  for (let y = 20; y <= 21; y++) g3[y][5] = 1, g3[y][6] = 1;
  const pieceLow = { type: 2, rotation: 0, x: 5, y: 20 }; // direkt über Stack
  const gy3 = ghostPosition(g3, pieceLow);
  check("niedriges Stück: ghostY >= piece.y", gy3 >= pieceLow.y, `ghost=${gy3} piece=${pieceLow.y}`);
}

/* ---------------------------------------------------------------- */
console.log("\n[2] Multiplikator: Specials auf gelöschter Zeile × cleared");
{
  // SINGLE (cleared=1): 2 Specials → 2 gesammelt.
  const g1 = createEmptyGrid();
  g1[21] = Array(GRID_WIDTH).fill(3);
  g1[21][2] = SPECIAL_CHAR_TO_CELL.A;
  g1[21][5] = SPECIAL_CHAR_TO_CELL.C;
  const r1 = clearLinesAndCollectSpecials(g1, 0, MAX_SPECIALS, () => 0.5);
  check("Single: cleared=1, 2 Specials → 2 gesammelt", r1.cleared === 1 && r1.collected.length === 2,
    `cleared=${r1.cleared} collected=${r1.collected.length}`);

  // DOUBLE (cleared=2): 1 Special → 2 gesammelt (Multiplikator).
  const g2 = createEmptyGrid();
  g2[20] = Array(GRID_WIDTH).fill(3);
  g2[21] = Array(GRID_WIDTH).fill(3);
  g2[21][2] = SPECIAL_CHAR_TO_CELL.B;
  const r2 = clearLinesAndCollectSpecials(g2, 0, MAX_SPECIALS, () => 0.5);
  check("Double: cleared=2, 1 Special → 2 gesammelt", r2.cleared === 2 && r2.collected.length === 2,
    `cleared=${r2.cleared} collected=${r2.collected.length} (${r2.collected.join("")})`);

  // TETRIS (cleared=4): 1 Special → 4 gesammelt.
  const g4 = createEmptyGrid();
  for (let i = 0; i < 4; i++) g4[21 - i] = Array(GRID_WIDTH).fill(3);
  g4[20][3] = SPECIAL_CHAR_TO_CELL.G;
  const r4 = clearLinesAndCollectSpecials(g4, 0, MAX_SPECIALS, () => 0.5);
  check("Tetris: cleared=4, 1 Special → 4 gesammelt", r4.cleared === 4 && r4.collected.length === 4,
    `cleared=${r4.cleared} collected=${r4.collected.length} (${r4.collected.join("")})`);

  // 2 Specials × Triple (cleared=3) → 6 gesammelt.
  const g3 = createEmptyGrid();
  for (let i = 0; i < 3; i++) g3[21 - i] = Array(GRID_WIDTH).fill(3);
  g3[21][2] = SPECIAL_CHAR_TO_CELL.A;
  g3[20][4] = SPECIAL_CHAR_TO_CELL.C;
  const r3 = clearLinesAndCollectSpecials(g3, 0, MAX_SPECIALS, () => 0.5);
  check("Triple: cleared=3, 2 Specials → 6 gesammelt", r3.cleared === 3 && r3.collected.length === 6,
    `cleared=${r3.cleared} collected=${r3.collected.length} (${r3.collected.join("")})`);
}

/* ---------------------------------------------------------------- */
console.log("\n[3] Overflow-Kappe: Inventory max. MAX_SPECIALS");
{
  check("MAX_SPECIALS ist 18 (inventory-addon.md §1.2)", MAX_SPECIALS === 18, `got ${MAX_SPECIALS}`);

  // 4 volle Zeilen, jede mit 5 Specials → 20 × 4 = 80 → kappt auf 18.
  const g = createEmptyGrid();
  for (let i = 0; i < 4; i++) {
    g[21 - i] = Array(GRID_WIDTH).fill(3);
    for (let x = 0; x < 5; x++) g[21 - i][x] = SPECIAL_CHAR_TO_CELL.A;
  }
  const r = clearLinesAndCollectSpecials(g, 0, MAX_SPECIALS, () => 0.5);
  check("Overflow: 80 mögliche → kappt auf 18", r.collected.length === 18, `got ${r.collected.length}`);
}

/* ---------------------------------------------------------------- */
console.log("\n[4] Player.afterLock: Multiplikator + FIFO-Queue wächst korrekt");
{
  const p = new Player("t1", "T", 1);
  p.status = "active";
  p.grid = createEmptyGrid();
  // 2 volle Zeilen am Boden (Double), je 1 Special → +2 gesammelt.
  p.grid[20] = Array(GRID_WIDTH).fill(3);
  p.grid[21] = Array(GRID_WIDTH).fill(3);
  p.grid[21][3] = SPECIAL_CHAR_TO_CELL.C;
  p.activePiece = { type: 2, rotation: 0, x: 0, y: 15 };
  const before = p.specialsInventory.length;
  p.handleAction("HARD_DROP");
  const after = p.specialsInventory.length;
  check("Double-Clear: Inventory +2 (Multiplikator ×2)", after === before + 2, `${before}→${after}`);
}

/* ---------------------------------------------------------------- */
console.log("\n[5] STRICT FIFO: nur Index 0 ist abfeuerbar");
{
  const io = { to: () => ({ emit: () => {} }), use: () => ({ emit: () => {} }) };
  const room = new GameRoom("test-room", io);
  room.status = "INGAME";
  room.loop = new GameLoop(io, room);

  const pa = new Player("A", "Alice", 1);
  const pb = new Player("B", "Bob", 2);
  room.players = [pa, pb];
  pa.status = "active";

  const fakeSocket = { id: "B" };

  // Bob: [A, C, N] → nur "A" (Index 0) ist erlaubt.
  pb.specialsInventory = ["A", "C", "N"];
  const before = () => pa.grid.flat().filter((v) => v !== 0).length;

  // (a) Nicht-Front "C" wird verworfen → Grid & Inventory unverändert.
  const beforeC = before();
  room.handleUseSpecial(fakeSocket, 1, "C");
  check("FIFO: Special 'C' (Index 1) verworfen — Grid unverändert", before() === beforeC);
  check("FIFO: 'C' bleibt in Queue", pb.specialsInventory.length === 3 && pb.specialsInventory[0] === "A",
    `inv=${JSON.stringify(pb.specialsInventory)}`);

  // (b) Front "A" wird akzeptiert → verschwindet, C rückt nach.
  room.handleUseSpecial(fakeSocket, 1, "A");
  check("FIFO: Front 'A' feuert → C wird neues Front", pb.specialsInventory.length === 2 && pb.specialsInventory[0] === "C",
    `inv=${JSON.stringify(pb.specialsInventory)}`);

  // (c) Leeres Inventory → nichts passiert, kein Crash.
  pb.specialsInventory = [];
  room.handleUseSpecial(fakeSocket, 1, "N"); // soll still verschwinden
  check("FIFO: leeres Inventory → keine Exception, Inventory bleibt leer", pb.specialsInventory.length === 0);
}

/* ---------------------------------------------------------------- */
console.log(failures === 0 ? "\n🎉 Alle Tests bestanden" : `\n💥 ${failures} Test(s) fehlgeschlagen`);
process.exit(failures === 0 ? 0 : 1);
