/**
 * Smoke-Test: alle 9 Specials auf einem Server-Player auslösen und
 * die Matrix-Änderungen verifizieren. Läuft headless (kein Browser).
 *
 * Aufruf: node scripts/test-specials.mjs
 */
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  createEmptyGrid,
  SPECIAL_CHAR_TO_CELL,
  isSpecialCell,
} from "../packages/shared/dist/index.js";
import { Player } from "../packages/server/dist/game/Player.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${detail}`);
    failures++;
  }
}

const baseGrid = () => {
  const g = createEmptyGrid();
  // Deterministisches "Haus": 2 Spalten füllen, 1 O-Block (Typ 2) in Mitte
  for (let y = 0; y < 10; y++) {
    g[GRID_HEIGHT - 1 - y][0] = 3;
    g[GRID_HEIGHT - 1 - y][11] = 5;
  }
  g[10][6] = 2; // O-Tetromino-Zelle für Block-Bomb
  // 1 Special-Zelle (C=102) für B-Test
  g[8][5] = SPECIAL_CHAR_TO_CELL.C;
  return g;
};

function countFilled(g) {
  let n = 0;
  for (const row of g) for (const v of row) if (v !== 0) n++;
  return n;
}

/* ---------------------------------------------------------------- */
console.log("\n[1] applySpecialToGrid: alle 9 Specials");
const { applySpecialToGrid } = await import("../packages/shared/dist/index.js");

const cases = [
  ["A", (g, b) => countFilled(g) === countFilled(b) + GRID_WIDTH - 1],
  ["C", (g, b) => countFilled(g) === countFilled(b) - 2],
  ["B", (g) => !g.some((r) => r.some((v) => isSpecialCell(v)))],
  ["R", (g, b) => countFilled(g) === countFilled(b) - 10],
  ["O", (g, b) => {
    const gCount = countFilled(g);
    const bCount = countFilled(b);
    return gCount < bCount; // 7x7-Explosion um O-Zelle
  }],
  ["G", (g) => {
    // Jede Spalte: von unten nach oben — kein 0 über einem Nicht-0
    for (let x = 0; x < GRID_WIDTH; x++) {
      let seen0 = false;
      for (let y = GRID_HEIGHT - 1; y >= 0; y--) {
        if (g[y][x] === 0) seen0 = true;
        else if (seen0) return false;
      }
    }
    return true;
  }],
  ["Q", (g, b) => {
    // Zeilen-Summen bleiben gleich (nur Verschiebung)
    for (let y = 0; y < GRID_HEIGHT; y++) {
      const a = g[y].reduce((s, v) => s + (v !== 0 ? 1 : 0), 0);
      const c = b[y].reduce((s, v) => s + (v !== 0 ? 1 : 0), 0);
      if (a !== c) return false;
    }
    return true;
  }],
  ["N", (g) => countFilled(g) === 0],
];

for (const [type, verify] of cases) {
  const grid = baseGrid();
  const before = grid.map((r) => r.slice());
  const ok = applySpecialToGrid(grid, type, () => 0.5); // deterministischer RNG
  check(`${type}: applySpecialToGrid zurück true`, ok === true);
  if (ok) check(`${type}: Matrix-Änderung plausibel`, verify(grid, before));
}

// S (Switch Fields): Einzel-Grid-Aufruf gibt BEWUSST false zurück —
// der Tausch wird auf Raum-Ebene via swapGridContents() abgewickelt.
{
  const grid = baseGrid();
  const ok = applySpecialToGrid(grid, "S", () => 0.5);
  check("S: applySpecialToGrid → false (Tausch läuft auf Raum-Ebene)", ok === false);
}

// S (Switch Fields): swapGridContents() tauscht zwei Felder korrekt
{
  const { swapGridContents } = await import("../packages/shared/dist/index.js");
  const a = baseGrid();
  const b = createEmptyGrid();
  b[0][0] = 1; b[0][1] = 1; // ein I-Block oben
  const aBefore = a.map((r) => r.slice());
  const bBefore = b.map((r) => r.slice());
  swapGridContents(a, b);
  const aSwapped = a.every((row, y) => row.every((v, x) => v === bBefore[y][x]));
  const bSwapped = b.every((row, y) => row.every((v, x) => v === aBefore[y][x]));
  check("S: swapGridContents — beide Felder korrekt getauscht", aSwapped && bSwapped);
}

/* ---------------------------------------------------------------- */
console.log("\n[2] Player: Special A schiebt Stack nach oben + settleIfColliding");
const p = new Player("test-id", "Tester", 42);
p.status = "active";
p.grid = baseGrid();
// Aktives Stück nahe Boden setzen
p.activePiece = { type: 3, rotation: 0, x: 4, y: GRID_HEIGHT - 3 };
const stackBefore = countFilled(p.grid);
const pieceBefore = p.activePiece;
applySpecialToGrid(p.grid, "A", () => 0.5);
// specials.md (Nacht 11): neue Zeile ~80% gefüllt (Binomial(12,0.8) → 1–12 Zellen).
check("A: Füllung +1..+12 (obere Zeile leer, neue Zeile ~80% gefüllt)", countFilled(p.grid) >= stackBefore + 1 && countFilled(p.grid) <= stackBefore + 12);
p.settleIfColliding();
check("settleIfColliding: kollidierendes Stück feststellt & neues spawnt", p.activePiece !== pieceBefore);

/* ---------------------------------------------------------------- */
console.log("\n[3] Server-Flow: handleUseSpecial mit sortWithSelfFirst-Mapping");
// Simuliert: 2 Player, Attacker = zweiter in Array, Client sieht [selbst, opponent]
// -> targetIndex 1 = erster im Array.
const { GameRoom } = await import("../packages/server/dist/game/Room.js");
const { GameLoop } = await import("../packages/server/dist/game/GameLoop.js");
const io = {
  to: () => ({ emit: () => {} }),
  use: () => ({ emit: () => {} }),
};
const room = new GameRoom("test-room", io);
room.status = "INGAME"; // NACHT 19.4: Server-Flow-Tests laufen im laufenden Spiel
room.loop = new GameLoop(io, room); // ohne start()

// Player A und B direkt eintragen (bypass addPlayer, kein Socket)
const pa = new Player("A", "Alice", 1);
const pb = new Player("B", "Bob", 2);
room.players = [pa, pb];
// NACHT 19.7: STRIKTES FIFO — das abgefeuerte Special MUSS an Index 0 sein.
pb.specialsInventory = ["A", "N", "C"];

const fakeSocket = { id: "B" };
const before = countFilled(pa.grid);
room.handleUseSpecial(fakeSocket, 1, "A"); // Attacker=Bob, Ziel-Index 1 in Bob's Ansicht = Alice
// specials.md (Nacht 11): neue Zeile ~80% gefüllt (Binomial(12,0.8) → 1–12 Zellen).
check("Bob schießt A auf Alice: Füllung +1..+12 (~80% gefüllt)", countFilled(pa.grid) >= before + 1 && countFilled(pa.grid) <= before + 12);
check("Special aus Bob's Inventory abgezogen", pb.specialsInventory.length === 2);

// Selbst-Test: Alice schießt N auf sich selbst (Index 0 in eigener Ansicht)
const fakeSocketA = { id: "A" };
pa.specialsInventory = ["N"];
const filledA = countFilled(pa.grid);
room.handleUseSpecial(fakeSocketA, 0, "N");
check("Alice Nuke auf sich selbst: Feld leer", countFilled(pa.grid) === 0 && filledA > 0);

/* ---------------------------------------------------------------- */
console.log("\n[4] Nacht 17.2: Specials auf AUSGESCHIEDENE Spieler verworfen");
// Alice scheidet aus (spectator). Bob versucht alle Special-Arten auf Alice.
pa.status = "spectator";
pa.grid = baseGrid();
const before2 = countFilled(pa.grid);
pb.specialsInventory = ["A", "C", "B", "R", "O", "N", "G", "Q", "S"];
for (const t of ["A", "R", "O", "N", "G", "Q", "S"]) {
  room.handleUseSpecial(fakeSocket, 1, t);
  check(`${t} auf Spectator: verworfen (Grid unverändert)`, countFilled(pa.grid) === before2);
}
check("Alle Specials im Inventory verbleiben", pb.specialsInventory.length === 9);
// Aktive Gegner dürfen weiter beschossen werden (POS-Steine auf Aktive erlaubt).
pa.status = "active";
pb.specialsInventory = ["G"];
const before3 = countFilled(pa.grid);
room.handleUseSpecial(fakeSocket, 1, "G");
check("G auf AKTIVEN Gegner: wird angewendet (Inventory abgezogen)", pb.specialsInventory.length === 0);
// Eigene Nuke (Index 0) funktioniert ebenfalls.
pb.specialsInventory = ["N"];
pb.grid = baseGrid();
const bobBefore = countFilled(pb.grid);
room.handleUseSpecial(fakeSocket, 0, "N");
check("N (POS) auf eigenes Feld: funktioniert", countFilled(pb.grid) === 0 && bobBefore > 0);

/* ---------------------------------------------------------------- */
console.log("\n[5] Nacht 17.9: BOTS feuern keine Specials auf AUSGESCHIEDENE");
const { BotAI } = await import("../packages/server/dist/game/BotAI.js");
const bot = new BotAI("BOT", "TestBot", 42, "ultra_nightmare");
bot.player.status = "active";
bot.player.specialsInventory = ["N", "A", "O"]; // NACHT 19.7: FIFO — abgefeuerter "N" an Index 0
bot.reset();
room.players = [bot.player, pa, pb]; // Bot + Alice (spectator) + Bob (aktiv)
room.bots.set("BOT", bot);

pa.status = "spectator";
pa.grid = baseGrid();
const botBefore = countFilled(pa.grid);

// (a) Direkter Guard: fireBotSpecial auf Spectator → verworfen, Inventory bleibt.
const invLen = bot.player.specialsInventory.length;
room["fireBotSpecial"](bot, pa.id, "N");
check("Bot-Nuke auf Spectator: verworfen (Grid unverändert)", countFilled(pa.grid) === botBefore);
check("Bot-Nuke auf Spectator: Special verbleibt im Bot-Inventory", bot.player.specialsInventory.length === invLen);

// (b) updateBots-Ziel-Filter: Spectator ist KEIN gültiges Ziel mehr.
//     Alice ist das EINZIGE andere Feld → Bot hat keine Ziele → feuert garantiert nicht.
const fired = [];
const origFire = room["fireBotSpecial"].bind(room);
room["fireBotSpecial"] = (b, t, ty) => { fired.push({ targetId: t, type: ty }); origFire(b, t, ty); };
room.players = [bot.player, pa]; // nur Bot + Spectator
bot.player.specialsInventory = ["N", "O", "A"];
bot["specialAcc"] = 5000; // erzwingt mehrere maybeFireSpecial-Pässe
room.updateBots(50);
room["fireBotSpecial"] = origFire;
check("updateBots: Spectator nicht in Ziel-Liste (keine Specials gefeuert)", fired.length === 0);
check("updateBots: Bot-Inventory bleibt erhalten", bot.player.specialsInventory.length === 3);

// (c) Aktive Spieler dürfen weiter beschossen werden (Regression).
room.players = [bot.player, pa, pb];
pb.status = "active";
pb.grid = baseGrid();
const bobGridBefore = countFilled(pb.grid);
const invLen2 = bot.player.specialsInventory.length;
room["fireBotSpecial"](bot, pb.id, "N");
check("Bot-Nuke auf AKTIVEN Spieler: wird angewendet", countFilled(pb.grid) === 0 && bobGridBefore > 0);
check("Bot-Nuke auf Aktiven: Special aus Inventory abgezogen", bot.player.specialsInventory.length === invLen2 - 1);

/* ---------------------------------------------------------------- */
console.log(failures === 0 ? "\n🎉 Alle Tests bestanden" : `\n💥 ${failures} Test(s) fehlgeschlagen`);
process.exit(failures === 0 ? 0 : 1);
