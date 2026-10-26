/**
 * NACHT 20.5 (Passwort-Lobbys):
 *  - Room.setPassword → SHA-256-Hash (nie Klartext)
 *  - Room.checkPassword: korrekt → true, falsch → false, leer/null → false
 *  - Room.hasPassword: false wenn kein Passwort gesetzt
 *  - setPassword("") / null / undefined → Passwort wird entfernt
 *  - Gleiches Passwort, unterschiedliche Hashe (deterministisch)
 *
 * Aufruf: node scripts/test-lobbys.mjs
 */
import { createHash } from "node:crypto";
import { GameRoom } from "../packages/server/dist/game/Room.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${detail}`); failures++; }
}

function fakeSocket(id = "s1") {
  return { id, data: {}, join() {}, emit() {} };
}

/* ---------------------------------------------------------------- */
console.log("\n[1] setPassword + checkPassword (korrekt/falsch/leer)");
{
  const r = new GameRoom("t1", {});
  check("vor setPassword: hasPassword=false", r.hasPassword === false);
  r.setPassword("hunter2");
  check("nach setPassword: hasPassword=true", r.hasPassword === true);
  check("korrektes Passwort akzeptiert", r.checkPassword("hunter2") === true);
  check("falsches Passwort abgelehnt", r.checkPassword("hunter3") === false);
  check("leeres String abgelehnt", r.checkPassword("") === false);
  check("null abgelehnt", r.checkPassword(null) === false);
  check("undefined abgelehnt", r.checkPassword(undefined) === false);
  check("Klartext-Hash im Hash gespeichert (nicht im Klartext)",
        r.passwordHash === createHash("sha256").update("hunter2").digest("hex"));
  check("Klartext NICHT im passwordHash", !r.passwordHash.includes("hunter2"));
}

/* ---------------------------------------------------------------- */
console.log("\n[2] Passwort entfernen (leer/null/undefined)");
{
  const r = new GameRoom("t2", {});
  r.setPassword("abc");
  check("vor clear: hasPassword=true", r.hasPassword === true);
  r.setPassword("");
  check("nach setPassword(\"\"): hasPassword=false", r.hasPassword === false);
  check("nach clear: beliebiges Passwort akzeptiert", r.checkPassword("x") === true);
  r.setPassword("xyz");
  r.setPassword(null);
  check("nach setPassword(null): hasPassword=false", r.hasPassword === false);
  r.setPassword("uvw");
  r.setPassword(undefined);
  check("nach setPassword(undefined): hasPassword=false", r.hasPassword === false);
}

/* ---------------------------------------------------------------- */
console.log("\n[3] Deterministische Hashes (gleiches Klartext → gleicher Hash)");
{
  const a = new GameRoom("a", {});
  const b = new GameRoom("b", {});
  a.setPassword("SamePass123");
  b.setPassword("SamePass123");
  check("gleicher Hash für identisches Passwort", a.passwordHash === b.passwordHash);
  check("Hash ist SHA-256 hex (64 Zeichen)", typeof a.passwordHash === "string" && a.passwordHash.length === 64);
  const c = new GameRoom("c", {});
  c.setPassword("SamePass124"); // 1 Zeichen anders
  check("unterschiedlicher Hash für anderes Passwort", a.passwordHash !== c.passwordHash);
}

/* ---------------------------------------------------------------- */
console.log("\n[4] Timing-safe Vergleich (Hash-Länge unterschiedlich → false)");
{
  const r = new GameRoom("t4", {});
  r.setPassword("abc");
  // Künstlich einen kürzeren Hash einpflanzen → checkPassword muss false geben
  // (Längen-Check läuft vor dem Timing-safe-Vergleich).
  r.passwordHash = "short";
  check("Hash-Längen-Mismatch → false (kein Crash)", r.checkPassword("abc") === false);
  check("Hash-Längen-Mismatch → false für jede Eingabe", r.checkPassword("") === false);
}

/* ---------------------------------------------------------------- */
console.log(failures === 0 ? "\n✅ ALL PASS (lobbys)" : `\n❌ ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
