/**
 * Integrationstest: Bots (server-seitig).
 *
 * Prüft:
 *  1. BotAI plant legale Abstell-Positionen (heuristischer Score).
 *  2. Die 6 Schwierigkeitsstufen unterscheiden sich (Skill/Tempo/Aggr).
 *  3. Bot-Aktionen (handleAction) sind legal und bewegen/locken das Stück.
 *  4. Room fügt Bots hinzu (bis MAX_PLAYERS), verwaltet Stufe & Leader-Rechte.
 *  5. Bots laufen stabil über 60s Simulation ohne Crash.
 *
 * Ausführung:  node scripts/test-bots.mjs   (nach `npm run build`)
 */
import assert from "node:assert/strict";
import { BotAI, BOT_PRESETS, gridHeight } from "../packages/server/dist/game/BotAI.js";
import { GameRoom } from "../packages/server/dist/game/Room.js";
import { GRID_HEIGHT, MAX_PLAYERS, BOT_DIFFICULTIES } from "../packages/shared/dist/index.js";

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log("  ✅ " + msg);
}

console.log("\n=== Bot-KI ===");

// 1) Plazierungen sind legal & bewertet
{
  const bot = new BotAI("bot_test", "TestBot", 42, "hurt_me");
  const type = bot.player.activePiece.type;
  const enum_ = bot["enumeratePlacements"](bot.player.grid, type);
  ok(enum_.length > 0, "Bot findet legale Plazierungen (" + enum_.length + ")");
  ok(enum_.every((p) => p.x >= -6 && p.x <= 18), "Plazierungen im erlaubten X-Bereich");
  const best = enum_.reduce((a, b) => (b.score > a.score ? b : a));
  ok(typeof best.score === "number", "Beste Plazierung hat Score " + best.score);
}

// 2) Die 6 Stufen unterscheiden sich
{
  const keys = BOT_DIFFICULTIES.map((d) => d.key);
  ok(keys.length === 6, "Es gibt 6 Schwierigkeitsstufen");
  const presets = keys.map((k) => BOT_PRESETS[k]);
  const skills = presets.map((p) => p.skill);
  ok(Math.max(...skills) > Math.min(...skills), "Skill variiert (" + Math.min(...skills) + " … " + Math.max(...skills) + ")");
  const temps = presets.map((p) => p.actionsPerSec);
  ok(Math.max(...temps) > Math.min(...temps), "Tempo variiert (" + Math.min(...temps) + " … " + Math.max(...temps) + " A/s)");
  ok(BOT_PRESETS["ultra_nightmare"].skill >= BOT_PRESETS["too_young"].skill, "Ultra-Nightmare >= I'm too young (Skill)");
}

// 3) Bot-Aktionen sind legal (Plan → handleAction)
{
  const bot = new BotAI("bot_act", "ActBot", 7, "nightmare");
  const piece = bot.player.activePiece;
  const seq = bot["plan"](bot.player.grid, piece.type);
  ok(seq.length > 0, "Bot plant eine Aktionssequenz (" + seq.length + " Aktionen)");
  ok(seq.includes("HARD_DROP"), "Sequenz endet mit HARD_DROP");
  let applied = 0;
  for (const a of seq) if (bot.player.handleAction(a)) applied++;
  ok(applied >= 1, "Aktionen wurden angewendet (" + applied + "/" + seq.length + ")");
}

// 4) Room: Bots hinzufügen, Stufe, Leader-Rechte
{
  const io = { to: () => ({ emit: () => {} }) };
  const room = new GameRoom("test_room", io);
  room.defaultDifficulty = "not_rough";
  const fakeSocket = { id: "human_1", data: {}, join: () => {}, emit: () => {} };

  room.addPlayer(fakeSocket, "Leader");
  ok(room.players.length === 1, "1 menschlicher Spieler im Raum");

  room.addBots(fakeSocket, 5, "hurt_me");
  ok(room.players.length === MAX_PLAYERS, "Nach +5 Bots: " + room.players.length + " = MAX_PLAYERS");
  ok([...room.bots.values()].length === 5, "5 Bots registriert");

  room.setBotDifficulty(fakeSocket, "ultraviolence");
  ok([...room.bots.values()].every((b) => b.difficulty === "ultraviolence"), "Alle Bots auf Stufe 'ultraviolence'");

  const fakeSocket2 = { id: "human_2", data: {}, join: () => {}, emit: () => {} };
  room.addPlayer(fakeSocket2, "Second");
  const before = room.players.length;
  room.addBots(fakeSocket2, 3, "nightmare");
  ok(room.players.length === before, "Nicht-Leader kann keine Bots hinzufügen");

  room.loop?.stop(); // GameLoop (setInterval) stoppen → Prozess kann beenden
}

// 5) Bot läuft stabil 60s ohne Crash
{
  const bot = new BotAI("bot_play", "PlayBot", 99, "ultra_nightmare");
  const start = bot.player.score;
  let acted = false;
  for (let t = 0; t < 1200; t++) {
    bot.update(50, { opponents: [], fireSpecial: () => {} });
    bot.player.tick(50);
    if (bot.player.score > start) acted = true;
  }
  ok(true, "Bot läuft stabil 60s ohne Crash (Score " + bot.player.score + ", " + (acted ? "aktiv" : "passiv") + ")");
  const h = gridHeight(bot.player.grid);
  ok(h >= 0 && h <= GRID_HEIGHT, "Feldhöhe im gültigen Bereich (" + h + ")");
}

// 6) NACHT 19.3 (BUG-FIX): bots_updated mit 0 Bots sendet defaultDifficulty (nicht null)
{
  const log = [];
  const io = { to: () => ({ emit: (ev, data) => log.push({ ev, data }) }) };
  const room = new GameRoom("t", io);
  room.status = "LOBBY";
  room.defaultDifficulty = "hurt_me";
  room.broadcastBots();
  const ev = log.find((e) => e.ev === "bots_updated");
  ok(!!ev, "bots_updated gesendet");
  ok(ev && ev.data.difficulty === "hurt_me", "0 Bots → difficulty = defaultDifficulty ('hurt_me'), nicht null");
}

console.log("\n🎉 " + passed + " Bot-Assertions bestanden.\n");
process.exit(0);
