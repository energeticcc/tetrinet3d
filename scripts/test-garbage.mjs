/**
 * Nacht 18.1 (attack-addlines.md): Garbage-Linien-Test.
 *
 * Deckt ab:
 *  [1] addGarbageLines: N Zeilen, jede mit genau 1 Loch, GARBAGE-Zellen.
 *  [2] Solo-Modus: 1 Zeile → 0, 2 → 1, 3 → 2, 4 → 4 Garbage an alle Gegner.
 *  [3] Team-Modus: Teammates immun, Gegner-Teams voll getroffen.
 *  [4] 1 Zeile → 0 Garbage (kein Angriff, attack-addlines.md §1).
 *  [5] Angreifer + Ausgeschiedene nicht getroffen.
 *
 * Aufruf: node scripts/test-garbage.mjs
 */
import {
  GRID_WIDTH, GRID_HEIGHT, Cell, createEmptyGrid,
  addGarbageLines, GARBAGE_LINES,
} from "../packages/shared/dist/index.js";
import { Player } from "../packages/server/dist/game/Player.js";
import { GameRoom } from "../packages/server/dist/game/Room.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${detail}`); failures++; }
}

const io = { to: () => ({ emit: () => {} }), use: () => ({ emit: () => {} }) };

function makeRoom(players) {
  const room = new GameRoom("test-room", io);
  room.players = players;
  // onClearedLines binden (addPlayer/spawnBots tun das im Live-Spiel)
  for (const p of players) room.bindPlayer(p);
  return room;
}

function six() {
  const names = ["P1", "P2", "P3", "P4", "P5", "P6"];
  return names.map((n, i) => new Player(`id-${i}`, n, 100 + i));
}

function countGarbage(g) {
  let n = 0;
  for (const row of g) for (const v of row) if (v === Cell.GARBAGE) n++;
  return n;
}

/* ---------------------------------------------------------------- */
console.log("\n[1] addGarbageLines: Struktur (N Zeilen, jede 11 GARBAGE + 1 Loch)");
{
  const g = createEmptyGrid();
  addGarbageLines(g, 3, () => 0.5);
  check("3 Garbage-Zeilen hinzugefügt (Feld bleibt 22)", g.length === GRID_HEIGHT);
  check("33 GARBAGE-Zellen (3x11)", countGarbage(g) === 33, `got ${countGarbage(g)}`);
  // Jede Zeile: genau 1 Loch (12 Zellen, 11 GARBAGE, 1 = 0)
  let holeOk = true;
  for (const row of g) {
    const holes = row.filter((v) => v === 0).length;
    if (holes !== 1 && row.some((v) => v === Cell.GARBAGE)) holeOk = false;
  }
  check("Jede Garbage-Zeile hat genau 1 Loch", holeOk);

  // Deterministische Loch-Position (rng = () => 0 → hole 0)
  const g2 = createEmptyGrid();
  addGarbageLines(g2, 1, () => 0);
  check("Loch-Position bei rng=0 → Spalte 0", g2[GRID_HEIGHT-1][0] === 0 && g2[GRID_HEIGHT-1][1] === Cell.GARBAGE);
}

/* ---------------------------------------------------------------- */
console.log("\n[2] Solo: Garbage-Verteilung (1→0, 2→1, 3→2, 4→4)");
{
  const room = makeRoom(six());
  room.gameMode = "solo";
  const attacker = room.players[0];
  const targets = room.players.slice(1);
  // 2 Zeilen → 1 Garbage an jeden der 5 Gegner (1 Aufruf, alle Ziele gleichzeitig)
  targets.forEach((t) => (t.grid = createEmptyGrid()));
  room.handleClearedLines(attacker, 2);
  for (const t of targets) check("2× → 1 Garbage", countGarbage(t.grid) === 11, `got ${countGarbage(t.grid)}`);
  // 3 Zeilen → 2 Garbage
  targets.forEach((t) => (t.grid = createEmptyGrid()));
  room.handleClearedLines(attacker, 3);
  for (const t of targets) check("3× → 2 Garbage", countGarbage(t.grid) === 22, `got ${countGarbage(t.grid)}`);
  // 4 Zeilen → 4 Garbage
  targets.forEach((t) => (t.grid = createEmptyGrid()));
  room.handleClearedLines(attacker, 4);
  for (const t of targets) check("4× → 4 Garbage", countGarbage(t.grid) === 44, `got ${countGarbage(t.grid)}`);
  check("GARBAGE_LINES-Matrix korrekt", GARBAGE_LINES[2]===1 && GARBAGE_LINES[3]===2 && GARBAGE_LINES[4]===4);
}

/* ---------------------------------------------------------------- */
console.log("\n[3] Team2: Teammates immun, Gegner-Teams voll getroffen");
{
  const room = makeRoom(six());
  room.gameMode = "team2";
  room.assignTeams();
  // Roster: P1:A, P2:A, P3:B, P4:B, P5:C, P6:C
  const attacker = room.players[0];       // P1, Team A
  const teammate = room.players[1];       // P2, Team A (immun)
  const enemy1 = room.players[2];         // P3, Team B
  const enemy2 = room.players[3];         // P4, Team B
  const enemy3 = room.players[4];         // P5, Team C
  const enemy4 = room.players[5];         // P6, Team C

  const tBefore = countGarbage(teammate.grid);
  room.handleClearedLines(attacker, 2); // 1 Garbage (11 Zellen) an alle Gegner
  check("Teammate IMMU (0 Garbage)", countGarbage(teammate.grid) === tBefore);
  check("Gegner B1 +1 Garbage (11)", countGarbage(enemy1.grid) === 11, `got ${countGarbage(enemy1.grid)}`);
  check("Gegner B2 +1 Garbage (11)", countGarbage(enemy2.grid) === 11, `got ${countGarbage(enemy2.grid)}`);
  check("Gegner C1 +1 Garbage (11)", countGarbage(enemy3.grid) === 11, `got ${countGarbage(enemy3.grid)}`);
  check("Gegner C2 +1 Garbage (11)", countGarbage(enemy4.grid) === 11, `got ${countGarbage(enemy4.grid)}`);
}

/* ---------------------------------------------------------------- */
console.log("\n[4] 1 Zeile → 0 Garbage (kein Angriff)");
{
  const room = makeRoom(six());
  room.gameMode = "solo";
  const attacker = room.players[0];
  const target = room.players[1];
  const before = countGarbage(target.grid);
  room.handleClearedLines(attacker, 1);
  check("1 Zeile → kein Garbage", countGarbage(target.grid) === before);
}

/* ---------------------------------------------------------------- */
console.log("\n[5] Angreifer + Ausgeschiedene nicht getroffen");
{
  const room = makeRoom(six());
  room.gameMode = "solo";
  const attacker = room.players[0];
  const out = room.players[1];
  out.status = "spectator";
  const atkBefore = countGarbage(attacker.grid);
  const outBefore = countGarbage(out.grid);
  room.handleClearedLines(attacker, 4); // 4 Garbage (44 Zellen)
  check("Angreifer NICHT getroffen", countGarbage(attacker.grid) === atkBefore);
  check("Ausgeschiedener NICHT getroffen", countGarbage(out.grid) === outBefore);
  const actives = room.players.slice(2);
  check("Aktive Gegner WERDEN getroffen (44)", actives.every((p) => countGarbage(p.grid) === 44), actives.map((p) => `${p.id}=${countGarbage(p.grid)}`).join(","));
}

/* ---------------------------------------------------------------- */
console.log(failures === 0 ? "\n✅ ALLE GARBAGE-TESTS GRÜN" : `\n❌ ${failures} FEHLER`);
process.exit(failures === 0 ? 0 : 1);
