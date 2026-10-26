/**
 * E2E Nacht 19 (mainmenu.md §2.1) — ISOLIERTER Server auf Port 3199.
 * Kontrollierter Raum: Alpha (Leader) + Beta + 2 AIs (auto-ready).
 */
import { io } from "socket.io-client";
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3199;
const URL = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log("  ✅", label);
  else { console.log("  ❌", label, detail); failures++; }
};

const EVENTS = ["room_state", "ready_check_init", "player_ready_update", "ready_all_ready", "ready_check_aborted", "game_start", "room_status", "chat"];

function mkClient(name) {
  const s = io(URL, { transports: ["polling"], timeout: 4000, reconnection: false });
  const log = [];
  for (const ev of EVENTS) s.on(ev, (d) => log.push({ ev, d, t: Date.now() }));
  s.connect();
  return { s, log, name };
}
async function join(c, retries = 6) {
  for (let i = 0; i < retries; i++) {
    if (c.log.some((e) => e.ev === "room_state")) return true;
    c.s.emit("join_room", { name: c.name });
    await sleep(400);
  }
  return c.log.some((e) => e.ev === "room_state");
}
async function waitFor(log, ev, after = -1, maxMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const idx = log.findIndex((e, i) => e.ev === ev && i > after);
    if (idx !== -1) return { idx, entry: log[idx] };
    await sleep(40);
  }
  return null;
}
const lastEv = (log, ev) => { for (let i = log.length - 1; i >= 0; i--) if (log[i].ev === ev) return log[i]; return null; };

/* ---------------------------------------------------------------- */
console.log("[E2E] Starte isolierten Server auf :" + PORT + " …");
try { execSync(`fuser -k ${PORT}/tcp`, { stdio: "ignore" }); await sleep(400); } catch {}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn(process.execPath, [path.join(repoRoot, "packages/server/dist/index.js")], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
  detached: true,
});
let serverUp = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) });
    if (r.status > 0) { serverUp = true; break; }
  } catch {}
  await sleep(300);
}
check("Server :" + PORT + " erreichbar", serverUp);
if (!serverUp) process.exit(1);

const cleanup = () => { try { process.kill(-server.pid); } catch {} };
process.on("exit", cleanup);

/* ---------------------------------------------------------------- */
console.log("[E2E] Alpha + Beta verbinden…");
const Alpha = mkClient("Alpha");
const Beta = mkClient("Beta");
const aOk = await join(Alpha);
const bOk = await join(Beta);
check("Alpha im Raum (Leader)", aOk);
check("Beta im Raum", bOk);
if (!aOk || !bOk) { console.log("❌ Setup fehlgeschlagen"); process.exit(1); }

const aiReg = async (name) => {
  const r = await fetch(`${URL}/ai/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  return r.json();
};
const ai1 = await aiReg("AI-Alpha");
const ai2 = await aiReg("AI-Beta");
check("AI-Alpha registriert", ai1?.ok === true, JSON.stringify(ai1));
check("AI-Beta registriert", ai2?.ok === true, JSON.stringify(ai2));
await sleep(1500);

const st = lastEv(Alpha.log, "room_state")?.d;
check("4 Spieler im Raum", st?.players?.length === 4, `got ${st?.players?.length}: ${st?.players?.map((p) => p.name).join(",")}`);
check("LOBBY", st?.roomStatus === "LOBBY", `got ${st?.roomStatus}`);
check("Alpha ist Leader (top-level isLeader)", st?.isLeader === true, `got ${st?.isLeader}`);

/* ---------------------------------------------------------------- */
console.log("\n[E2E] Alpha startet Ready-Check…");
const beforeInit = Beta.log.filter((e) => e.ev === "ready_check_init").length;
Alpha.s.emit("start_ready_check");
const initW = await waitFor(Beta.log, "ready_check_init", beforeInit - 1);
check("ready_check_init erhalten", !!initW);
if (initW) {
  const init = initW.entry.d;
  check("endsAt ~15s in Zukunft", typeof init.endsAt === "number" && init.endsAt > Date.now() && init.endsAt < Date.now() + 20000, `endsAt=${init.endsAt}`);
  check("4 Spieler in init", init.players.length === 4, `got ${init.players.length}`);
  check("Alpha (Leader) ready", init.players.find((p) => p.name === "Alpha")?.ready === true);
  const ais = init.players.filter((p) => p.name.startsWith("AI-"));
  check("Beide AIs auto-ready", ais.length === 2 && ais.every((p) => p.ready === true), JSON.stringify(ais));
  check("Beta wartet", init.players.find((p) => p.name === "Beta")?.ready === false);

  console.log("\n[E2E] Beta ready → ready_all_ready → Alpha klickt Start…");
  const beforeAll = Beta.log.filter((e) => e.ev === "ready_all_ready").length;
  Beta.s.emit("player_ready", { confirmed: true });
  const allW = await waitFor(Beta.log, "ready_all_ready", beforeAll - 1, 5000);
  check("ready_all_ready erhalten (Button→Start)", !!allW);
  // Noch NICHT INGAME (kein Auto-Start):
  const stMid = lastEv(Beta.log, "room_status");
  check("NOCH READY_CHECK (Timer läuft)", stMid?.d?.status === "READY_CHECK", `got ${stMid?.d?.status}`);
  // Alpha (Leader) klickt „Start":
  const beforeStart = Beta.log.filter((e) => e.ev === "game_start").length;
  Alpha.s.emit("confirm_start");
  const gsW = await waitFor(Beta.log, "game_start", beforeStart - 1, 8000);
  check("game_start erhalten (nach confirm_start)", !!gsW, `seed=${gsW?.entry?.d?.seed}`);
  const stW = lastEv(Beta.log, "room_status");
  check("room_status INGAME", stW?.d?.status === "INGAME", `got ${stW?.d?.status}`);

  console.log("\n[E2E] Guard: Ready-Check in INGAME abgelehnt…");
  const gB = Beta.log.filter((e) => e.ev === "chat").length;
  Beta.s.emit("start_ready_check");
  let guardEntry = null;
  for (let i = 0; i < 60; i++) {
    const cand = Beta.log.slice(gB).find((e) => e.ev === "chat" && /Nur in der Lobby/i.test(e.d?.text ?? ""));
    if (cand) { guardEntry = cand; break; }
    await sleep(50);
  }
  check("Guard-Chat erhalten", !!guardEntry, `chats: ${Beta.log.slice(gB).filter((e) => e.ev === "chat").map((e) => e.d?.text).join(" | ")}`);
}

Alpha.s.disconnect();
Beta.s.disconnect();
cleanup();
console.log(failures === 0 ? "\n✅ E2E GRÜN" : `\n❌ ${failures} FEHLER`);
process.exit(failures === 0 ? 0 : 1);
