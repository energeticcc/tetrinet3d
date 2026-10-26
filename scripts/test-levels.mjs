/**
 * Test: Tetrinet-Level-System (Quelle: md/levels.md).
 *
 * Aufruf: node scripts/test-levels.mjs
 */
import {
  MAX_LEVEL,
  LINES_PER_LEVEL,
  CLASSIC_SPEEDS,
  clampLevel,
  levelFromLines,
  activeLevel,
  getTimings,
} from "../packages/shared/dist/index.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${detail}`);
    failures++;
  }
}

/* ---------------------------------------------------------------- */
console.log("\n[1] clampLevel");
check("clampLevel(0) = 0", clampLevel(0) === 0);
check("clampLevel(9) = 9", clampLevel(9) === 9);
check("clampLevel(-5) = 0", clampLevel(-5) === 0);
check("clampLevel(20) = 9", clampLevel(20) === 9);
check("MAX_LEVEL = 9", MAX_LEVEL === 9);
check("LINES_PER_LEVEL = 10", LINES_PER_LEVEL === 10);

/* ---------------------------------------------------------------- */
console.log("\n[2] levelFromLines");
check("0 Zeilen, Start 0 → Level 0", levelFromLines(0, 0) === 0);
check("9 Zeilen → Level 0", levelFromLines(9, 0) === 0);
check("10 Zeilen → Level 1", levelFromLines(10, 0) === 1);
check("25 Zeilen → Level 2", levelFromLines(25, 0) === 2);
check("100 Zeilen → Level 9 (max)", levelFromLines(100, 0) === 9);
check("Start 3 + 10 Zeilen → Level 4", levelFromLines(10, 3) === 4);
check("Start 8 + 20 Zeilen → Level 9 (clamped)", levelFromLines(20, 8) === 9);

/* ---------------------------------------------------------------- */
console.log("\n[3] activeLevel (Raum-Durchschnitt)");
check("leer → 0", activeLevel([], 0) === 0);
check("[0,0] → 0", activeLevel([0, 0]) === 0);
check("[2,0] → 1 (round avg 1)", activeLevel([2, 0]) === 1);
check("[9,9,9] → 9", activeLevel([9, 9, 9]) === 9);
check("[1,1,1,1,1,1] → 1", activeLevel([1,1,1,1,1,1]) === 1);
check("[0,1,2,3,4,5] → 3 (avg 2.5, JS rounds half up)", activeLevel([0,1,2,3,4,5]) === 3);

/* ---------------------------------------------------------------- */
console.log("\n[4] getTimings (CLASSIC)");
const t0 = getTimings("CLASSIC", 0);
check("Level 0: tickMs=800", t0.tickMs === 800);
check("Level 0: lockDelay=500", t0.lockDelayMs === 500);
const t5 = getTimings("CLASSIC", 5);
check("Level 5: tickMs=380", t5.tickMs === 380);
const t9 = getTimings("CLASSIC", 9);
check("Level 9: tickMs=50 (extrem schnell)", t9.tickMs === 50);
check("Level 20 → clamped auf 9", getTimings("CLASSIC", 20).tickMs === 50);
check("Level -3 → clamped auf 0", getTimings("CLASSIC", -3).tickMs === 800);

/* ---------------------------------------------------------------- */
console.log("\n[5] getTimings (TETRIFAST)");
const tf = getTimings("TETRIFAST", 5);
check("TETRIFAST: tickMs=0", tf.tickMs === 0);
check("TETRIFAST: lockDelay=0", tf.lockDelayMs === 0);

/* ---------------------------------------------------------------- */
console.log("\n[6] Monotonie: höhere Level → schnellere tickMs");
let monotone = true;
for (let lvl = 1; lvl <= 9; lvl++) {
  if (CLASSIC_SPEEDS[lvl].tickMs >= CLASSIC_SPEEDS[lvl - 1].tickMs) monotone = false;
}
check("tickMs sinkt monoton von Lvl 0 → 9", monotone);

/* ---------------------------------------------------------------- */
console.log("\n[7] Player-Integration (Server)");
const { Player } = await import("../packages/server/dist/game/Player.js");
const p = new Player("test", "Tester", 42);
check("Player: initial level=0", p.level === 0);
check("Player: initial dropInterval=800", p.dropInterval === 800);
check("Player: initial linesCleared=0", p.linesCleared === 0);

// Simuliere 15 Zeilen → Level 1
p.linesCleared = 15;
p.level = levelFromLines(p.linesCleared, 0);
check("15 Zeilen → Player.level=1", p.level === 1);
const { tickMs } = getTimings("CLASSIC", p.level);
p.dropInterval = Math.max(1, tickMs);
check("Player.dropInterval = 720ms (Level 1)", p.dropInterval === 720);

// Reset
p.reset();
check("Reset: level=0", p.level === 0);
check("Reset: linesCleared=0", p.linesCleared === 0);
check("Reset: dropInterval=800ms", p.dropInterval === 800);

/* ---------------------------------------------------------------- */
if (failures > 0) {
  console.log(`\n💥 ${failures} Test(s) fehlgeschlagen`);
  process.exit(1);
} else {
  console.log("\n🎉 Alle Level-Tests bestanden");
  process.exit(0);
}
