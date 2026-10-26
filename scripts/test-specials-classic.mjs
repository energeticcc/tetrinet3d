/**
 * Test: Tetrinet-Specials-Klassik (game.md §2)
 *  - Buchstaben auf gelöschten Zeilen → Inventory
 *  - Neue Buchstaben erscheinen im Feld
 *  - placeSpecialBlock platziert in freie Zelle
 *
 * Aufruf: node scripts/test-specials-classic.mjs
 */
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  createEmptyGrid,
  SPECIAL_CHAR_TO_CELL,
  CELL_TO_SPECIAL_CHAR,
  isSpecialCell,
  clearLinesAndCollectSpecials,
  placeSpecialBlock,
  rollSpecial,
} from "../packages/shared/dist/index.js";
import { Player } from "../packages/server/dist/game/Player.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${detail}`); failures++; }
}

/* ---------------------------------------------------------------- */
console.log("\n[1] placeSpecialBlock: ersetzt einen bestehenden Block");
{
  const g = createEmptyGrid();
  // Auf leere Zelle geht es NICHT mehr:
  const onEmpty = placeSpecialBlock(g, "A", () => 0.5);
  check("auf leerem Feld abgelehnt", onEmpty === false);

  // Jetzt einen Block (T, Wert 3) ins untere 2/3 legen → Special ersetzt ihn
  const y = 10, x = 4;
  g[y][x] = 3;
  const ok = placeSpecialBlock(g, "A", () => 0.5);
  check("platzieren erfolgreich", ok === true);
  check("alter Block ist weg (Zelle nun Special)", g[y][x] === SPECIAL_CHAR_TO_CELL.A);
  // Genau eine Zelle mit Special-Code, sonst nur der eine Block
  let count = 0;
  for (const row of g) for (const v of row) if (isSpecialCell(v)) count++;
  check("genau 1 Special-Zelle", count === 1);
}

/* ---------------------------------------------------------------- */
console.log("\n[2] clearLinesAndCollectSpecials: Buchstaben auf gelöschter Zeile → Inventory");
{
  const g = createEmptyGrid();
  // Untere Zeile (y=21) füllen, mit 2 Special-Buchstaben (A=101, C=102)
  g[21] = Array(GRID_WIDTH).fill(3); // alle Zellen gefüllt (T-Blöcke)
  g[21][2] = SPECIAL_CHAR_TO_CELL.A;
  g[21][5] = SPECIAL_CHAR_TO_CELL.C;
  const res = clearLinesAndCollectSpecials(g, 0, 15, () => 0.5);
  check("1 Zeile gelöscht", res.cleared === 1);
  check("2 Specials eingesammelt", res.collected.length === 2);
  check("gesammelt = A + C", res.collected.includes("A") && res.collected.includes("C"));
  // Nach dem Clear: Feld hat eine leere Zeile oben, die übrigen 21 Zeilen identisch
  check("Feld ist nach Clear 22 Zeilen", g.length === GRID_HEIGHT);
  // Obere Zeile (y=0) ist leer
  check("obere Zeile leer nach Clear", g[0].every((v) => v === 0));
}

/* ---------------------------------------------------------------- */
console.log("\n[3] clearLinesAndCollectSpecials: neue Buchstaben ersetzen Blocks");
{
  // 3x volle Zeilen (wird gelöscht) + eine TEILGEFÜLLTE Zeile (verbleibt im Feld)
  const g = createEmptyGrid();
  for (let i = 0; i < 3; i++) {
    g[GRID_HEIGHT - 1 - i] = Array(GRID_WIDTH).fill(5); // y=21,20,19 → gelöscht
  }
  // Zeile 15: NUR 6 Spalten gefüllt → wird NICHT gelöscht, bleibt als Ersatz-Blocks
  for (let x = 0; x < 6; x++) g[15][x] = 5;
  const res = clearLinesAndCollectSpecials(g, 0, 15, () => 0.5);
  check("3 Zeilen gelöscht", res.cleared === 3);
  // Es MÜSSEN neue Special-Blocks im Feld liegen (ersetzen verbleibende Blocks)
  let newSpecials = 0;
  for (const row of g) for (const v of row) if (isSpecialCell(v)) newSpecials++;
  check("mind. 1 neuer Special-Buchstabe im Feld", newSpecials >= 1);
  console.log(`    (neue Specials im Feld: ${newSpecials})`);

  // Kontrast: nur volle Zeilen → nach Clear komplett leer → KEIN Special möglich
  const gEmpty = createEmptyGrid();
  for (let i = 0; i < 3; i++) gEmpty[GRID_HEIGHT - 1 - i] = Array(GRID_WIDTH).fill(5);
  clearLinesAndCollectSpecials(gEmpty, 0, 15, () => 0.5);
  let emptySpecials = 0;
  for (const row of gEmpty) for (const v of row) if (isSpecialCell(v)) emptySpecials++;
  check("leeres Feld → kein Special", emptySpecials === 0);
}

/* ---------------------------------------------------------------- */
console.log("\n[4] Player.afterLock: Inventory wächst bei Zeilen-Clear");
{
  const p = new Player("test", "Tester", 42);
  p.status = "active";
  // Feld so aufbauen, dass Zeile 20 nach dem Drop voll wird
  p.grid = createEmptyGrid();
  // Zeile 20: alle Spalten gefüllt AUCHER Spalten 1,2 (die der O-Block füllen wird)
  p.grid[20] = Array(GRID_WIDTH).fill(3);
  p.grid[20][1] = 0;
  p.grid[20][2] = 0;
  // Zusätzlich: ein Special-Buchstabe (C) in Zeile 20 → muss beim Clear gesammelt werden
  p.grid[20][3] = SPECIAL_CHAR_TO_CELL.C;
  p.grid[20] = p.grid[20].map((v, i) => (i === 3 ? SPECIAL_CHAR_TO_CELL.C : v));
  // Aktives Stück: 2x2 O-Block, x=0 → bedeckt Spalten 1,2
  p.activePiece = { type: 2, rotation: 0, x: 0, y: 10 };
  const invBefore = p.specialsInventory.length;
  p.handleAction("HARD_DROP");
  const invAfter = p.specialsInventory.length;
  check("Hard Drop → Zeile voll → Special C gesammelt ins Inventory", invAfter === invBefore + 1);
  check("Score steigt", p.score > 0);
  console.log(`    (Inventory: ${invBefore} → ${invAfter}, Score: ${p.score})`);
}

/* ---------------------------------------------------------------- */
console.log("\n[5] rollSpecial: deterministic (0.5 → immer dasselbe Special)");
{
  const a = rollSpecial(0, 15, () => 0.5);
  const b = rollSpecial(0, 15, () => 0.5);
  check("deterministisch", a === b);
  console.log(`    (rollSpecial(0,15,()=>0.5) = ${a})`);
}

console.log(failures === 0 ? "\n🎉 Alle Tests bestanden" : `\n💥 ${failures} Test(s) fehlgeschlagen`);
process.exit(failures === 0 ? 0 : 1);
