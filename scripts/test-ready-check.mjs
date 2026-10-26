/**
 * Nacht 19 (mainmenu.md §2.1): Ready-Check + AFK-Timeout + Teamname-Tests.
 *
 * Deckt ab:
 *  [1] LOBBY-Start: startReadyCheck setzt Status auf READY_CHECK, Bots + Leader ready.
 *  [2] Alle ready → INGAME (game_start-Broadcast, Grids resettet).
 *  [3] PLAYER_DECLINED → Abbruch (LOBBY, ready_flags geräumt).
 *  [4] TIMEOUT_AFK → unreaktivierte = AFK, 60s-Penalty (isPenalized).
 *  [5] editTeamName: NUR Team-Leader (erster Joiner), Sanitize (max 24).
 *  [6] addPlayer blockiert AFK-Gesperrte (mainmenu.md §2.1 Sanktion).
 *
 * Aufruf: node scripts/test-ready-check.mjs
 */
import { Player } from "../packages/server/dist/game/Player.js";
import { GameRoom } from "../packages/server/dist/game/Room.js";
import { Cell } from "../packages/shared/dist/index.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${detail}`); failures++; }
}

// io-Mock mit Emits-Log
function makeIo() {
  const log = [];
  const io = {
    log,
    to: (room) => ({ emit: (ev, data) => log.push({ room, ev, data }) }),
    use: () => ({ emit: () => {} }),
    emit: (ev, data) => log.push({ room: "*", ev, data }),
  };
  return io;
}

function freshRoom({ devBots = false, players = 3 } = {}) {
  const io = makeIo();
  const room = new GameRoom("test", io);
  room.devBots = devBots;
  room.status = devBots ? "INGAME" : "LOBBY";
  const ps = [];
  for (let i = 0; i < players; i++) ps.push(new Player(`p${i}`, `P${i}`, 100 + i));
  room.players = ps;
  return { io, room };
}

/* ---------------------------------------------------------------- */
console.log("\n[1] LOBBY: startReadyCheck → READY_CHECK, Bots+Leader ready");
{
  const { room } = freshRoom({ players: 3 });
  room.status = "LOBBY";
  const leader = room.players[0];
  room.startReadyCheck({ id: leader.id });
  check("Status = READY_CHECK", room.status === "READY_CHECK");
  check("Leader ist ready", leader.__ready === true);
  check("readyCheckEndsAt gesetzt", typeof room.readyCheckEndsAt === "number");
  // Broadcast gesendet
  const ev = room.io.log.find((e) => e.ev === "ready_check_init");
  check("ready_check_init gesendet", !!ev);
  check("endsAt in Nachricht", ev && typeof ev.data.endsAt === "number");
  // Aufräumen: Timer stoppen (sonst hängen Node)
  if (room.readyCheckTimer) clearTimeout(room.readyCheckTimer);
}

/* ---------------------------------------------------------------- */
console.log("\n[2] Alle ready → ready_all_ready → confirmStart (Leader) → INGAME");
{
  const { io, room } = freshRoom({ players: 2 });
  room.status = "LOBBY";
  const leader = room.players[0];
  room.startReadyCheck({ id: leader.id });
  // NACHT 19.2: confirmStart nur durch den echten Leader-Socket erlaubt.
  room.pickLeaderId = () => leader.id;
  // Zweiter Spieler klickt „Bereit"
  room.playerReady({ id: room.players[1].id }, true);
  check("Status = READY_CHECK (kein Auto-Start)", room.status === "READY_CHECK");
  check("ready_all_ready gesendet", !!io.log.find((e) => e.ev === "ready_all_ready"));
  check("NOCH kein game_start", !io.log.find((e) => e.ev === "game_start"));
  // Nicht-Leader darf nicht starten:
  room.confirmStart({ id: room.players[1].id });
  check("confirmStart (Nicht-Leader) abgelehnt", room.status === "READY_CHECK");
  check("Chat-Hinweis für Nicht-Leader", !!io.log.find((e) => e.ev === "chat" && /Lobby-Leader/.test(e.data?.text ?? "")));
  // Leader klickt „Start\" (Klick auf den transformierten Button):
  room.confirmStart({ id: leader.id });
  check("Status = INGAME (nach confirmStart)", room.status === "INGAME");
  check("game_start gesendet", !!io.log.find((e) => e.ev === "game_start"));
  check("Leader __ready zurückgesetzt", leader.__ready === false);
  check("Grids frisch (leer)", room.players.every((p) => p.grid.flat().every((v) => v === 0)));
  if (room.readyCheckTimer) clearTimeout(room.readyCheckTimer);
}

/* ---------------------------------------------------------------- */
console.log("\n[3] PLAYER_DECLINED → Abbruch (LOBBY)");
{
  const { io, room } = freshRoom({ players: 3 });
  room.status = "LOBBY";
  const leader = room.players[0];
  room.startReadyCheck({ id: leader.id });
  check("Vor Decline: READY_CHECK", room.status === "READY_CHECK");
  room.playerReady({ id: leader.id }, false);
  check("Nach Decline: LOBBY", room.status === "LOBBY");
  check("ready_check_aborted gesendet", !!io.log.find((e) => e.ev === "ready_check_aborted" && e.data.reason === "PLAYER_DECLINED"));
  check("Leader __ready geräumt", leader.__ready === false);
  if (room.readyCheckTimer) clearTimeout(room.readyCheckTimer);
}

/* ---------------------------------------------------------------- */
console.log("\n[4] TIMEOUT_AFK → 60s-Penalty (isPenalized)");
{
  const { io, room } = freshRoom({ players: 3 });
  room.status = "LOBBY";
  const leader = room.players[0];
  room.startReadyCheck({ id: leader.id });
  // Nur Leader ist ready, die anderen 2 = AFK
  const afk1 = room.players[1];
  const afk2 = room.players[2];
  room.handleReadyCheckTimeout();
  check("Status = LOBBY (Abbruch)", room.status === "LOBBY");
  check("ready_check_aborted (TIMEOUT_AFK)", !!io.log.find((e) => e.ev === "ready_check_aborted" && e.data.reason === "TIMEOUT_AFK"));
  check("afkPlayerIds enthält beide", io.log.find((e) => e.ev === "ready_check_aborted").data.afkPlayerIds.includes(afk1.id) && io.log.find((e) => e.ev === "ready_check_aborted").data.afkPlayerIds.includes(afk2.id));
  check("AFK-Spieler gesperrt (isPenalized)", room.isPenalized(afk1.id) && room.isPenalized(afk2.id));
  check("Leader NICHT gesperrt", !room.isPenalized(leader.id));
  if (room.readyCheckTimer) clearTimeout(room.readyCheckTimer);
}

/* ---------------------------------------------------------------- */
console.log("\n[4b] ALLE sofort bereit (nur Leader + Bot) → ready_all_ready → Leader klickt Start");
{
  const { io, room } = freshRoom({ players: 2 });
  room.status = "LOBBY";
  const leader = room.players[0];
  const bot = room.players[1];
  // 2. Spieler = Bot (auto-ready) → nur der Leader ist ein „Mensch".
  room.bots.set(bot.id, { difficulty: "ultraviolence", reset: () => {} });
  room.pickLeaderId = () => leader.id;
  // NACHT 19.2: Timer läuft IMMER → ALLE sofort bereit? → ready_all_ready-Signal
  // (Client: „Bereit\"-Button wird zum „Start\"-Button), Start = expliziter Klick.
  room.startReadyCheck({ id: leader.id });
  check("Status = READY_CHECK (Timer läuft)", room.status === "READY_CHECK", `got ${room.status}`);
  check("ready_all_ready gesendet (Button→Start)", !!io.log.find((e) => e.ev === "ready_all_ready"));
  check("NOCH kein game_start", !io.log.find((e) => e.ev === "game_start"));
  // Leader klickt „Start\":
  room.confirmStart({ id: leader.id });
  check("INGAME (nach confirmStart)", room.status === "INGAME", `got ${room.status}`);
  check("game_start gesendet", !!io.log.find((e) => e.ev === "game_start"));
  check("KEIN Timeout-Abbruch", !io.log.find((e) => e.ev === "ready_check_aborted"));
  check("Leader NICHT AFK-gebannt", !room.isPenalized(leader.id));
  check("Grids frisch (leer)", room.players.every((p) => p.grid.flat().every((v) => v === 0)));
  if (room.readyCheckTimer) clearTimeout(room.readyCheckTimer);
}

/* ---------------------------------------------------------------- */
console.log("\n[4c] BUG-FIX (Fallback): ALLE bereit + Timeout → startet NICHT ab");
{
  const { io, room } = freshRoom({ players: 2 });
  room.status = "LOBBY";
  const leader = room.players[0];
  const bot = room.players[1];
  room.bots.set(bot.id, { difficulty: "ultraviolence", reset: () => {} });
  // Simuliere: Spiel läuft trotzdem im READY_CHECK (z. B. letzter Mensch readyete
  // grad NICHT im letzten Moment) — am Timeout sind alle bereit → starten, nicht abbrechen.
  room.status = "READY_CHECK";
  leader.__ready = true;
  room.readyCheckEndsAt = Date.now() + 1000;
  room.handleReadyCheckTimeout();
  check("Nach Timeout: INGAME (Spiel startet)", room.status === "INGAME", `got ${room.status}`);
  check("game_start gesendet", !!io.log.find((e) => e.ev === "game_start"));
  check("KEIN Timeout-Abbruch", !io.log.find((e) => e.ev === "ready_check_aborted"));
  if (room.readyCheckTimer) clearTimeout(room.readyCheckTimer);
}

/* ---------------------------------------------------------------- */
console.log("\n[5] editTeamName: NUR Team-Leader (erster ECHTER Spieler; Bot-only: erster Bot) + Sanitize");
{
  const { io, room } = freshRoom({ players: 4 });
  room.gameMode = "team2";
  room.assignTeams();
  // Roster (Beitrittsreihenfolge): p0:A, p1:A, p2:B, p3:B
  // NACHT 19.8: Team-Leader = erster ECHTER Spieler im Team.
  const a1 = room.players[0]; // Team A — LEADER (erster Mensch)
  const a2 = room.players[1]; // Team A — Zweit-Mitglied (kein Leader)
  const b1 = room.players[2]; // Team B — LEADER (erster Mensch)
  // (a0) NACHT 19.8: Bot als ERSTER im Team → echter Spieler bleibt Leader
  const fakeBot = { id: "botX", name: "BotX" };
  room.players.unshift(fakeBot);
  fakeBot.team = "A";
  room.bots.set("botX", true);
  check("Bot vor Mensch im Team → Mensch bleibt Leader", room.teamLeaderId("A") === a1.id);
  check("teamLeaderId(B) = erster Mensch", room.teamLeaderId("B") === b1.id);
  // (a0b) Bot-only-Team → erster Bot ist Leader
  const fakeBotOnly = { id: "botY", name: "BotY" };
  room.players.push(fakeBotOnly);
  fakeBotOnly.team = "C";
  room.bots.set("botY", true);
  check("Bot-only-Team → Bot ist Leader", room.teamLeaderId("C") === "botY");
  // (Hinweis: Bot-only-Leader kann praktisch nie umbenennen — Bots emittieren nie
  // editTeamName, der Guard `player.team !== teamId` lässt das nicht zu.)
  // (a) Team-Leader darf ändern
  // (a) Team-Leader darf ändern
  room.editTeamName({ id: a1.id }, "A", "Doomers");
  check("Teamname gesetzt (Leader)", room.teamNames["A"] === "Doomers");
  check("team_name_updated gesendet", !!io.log.find((e) => e.ev === "team_name_updated" && e.data.teamId === "A"));
  // (b) NACHT 19.7: zweites Team-Mitglied wird abgelehnt (nicht der Leader)
  room.editTeamName({ id: a2.id }, "A", "Hacker");
  check("2. Team-Mitglied kann NICHT umbenennen (nur Leader)", room.teamNames["A"] === "Doomers");
  // (c) Anderes Team wird abgelehnt (p2 ist Team B)
  room.editTeamName({ id: b1.id }, "A", "CrossTeam");
  check("Team-B kann Team-A NICHT umbenennen", room.teamNames["A"] === "Doomers");
  // (d) Sanitize: Steuerzeichen + >24 Zeichen (als Leader)
  room.editTeamName({ id: a1.id }, "A", "ABC\u0000\u0001DEF");
  check("Steuerzeichen entfernt", room.teamNames["A"] === "ABCDEF", `got ${room.teamNames["A"]}`);
  room.editTeamName({ id: a1.id }, "A", "X".repeat(40));
  check("Max. 24 Zeichen", room.teamNames["A"].length === 24, `len=${room.teamNames["A"].length}`);
  // (e) Leerer Name abgelehnt
  const before = room.teamNames["A"];
  room.editTeamName({ id: a1.id }, "A", "   ");
  check("Leerer Name abgelehnt", room.teamNames["A"] === before);
}

/* ---------------------------------------------------------------- */
console.log("\n[6] addPlayer blockiert AFK-Gesperrte");
{
  const { io, room } = freshRoom({ players: 1 });
  room.status = "LOBBY";
  const sp = room.players[0];
  // Simuliere: sp wurde als AFK deklariert
  room.afkPenalties.set(sp.id, Date.now() + 60000);
  check("isPenalized true", room.isPenalized(sp.id));
  // addPlayer mit gesperrtem Socket → false
  const ok = room.addPlayer({ id: sp.id, join: () => {}, emit: () => {} }, "P0");
  check("addPlayer blockiert", ok === false);
  check("Chat-Warnung gesendet", !!io.log.find((e) => e.ev === "chat" && /AFK-Sperre/.test(e.data.text)));
}

/* ---------------------------------------------------------------- */
console.log("\n[7] NACHT 19.4: Außerhalb INGAME = KEINE Spieleingaben (Shapes bewegen)");
{
  const { io, room } = freshRoom({ players: 2 });
  const leader = room.players[0];
  const sock = { id: leader.id };

  // (a) LOBBY: Eingabe wird verworfen → Stück bleibt am Spawn
  room.status = "LOBBY";
  const before = JSON.stringify(leader.grid);
  room.handleAction(sock, "MOVE_LEFT");
  room.handleAction(sock, "ROTATE");
  check("LOBBY: Grid unverändert (Eingabe verworfen)", JSON.stringify(leader.grid) === before);

  // (b) READY_CHECK: ebenso
  room.status = "READY_CHECK";
  room.handleAction(sock, "HARD_DROP");
  check("READY_CHECK: Grid unverändert", JSON.stringify(leader.grid) === before);

  // (c) INGAME: Eingabe WIRD angenommen (Regression)
  room.status = "INGAME";
  leader.grid = leader.grid.map((r) => r.slice());
  const gridBeforeIngame = JSON.stringify(leader.grid);
  room.handleAction(sock, "HARD_DROP");
  // HARD_DROP lockt das Stück → Grid muss sich ändern (Blöcke im Grid)
  check("INGAME: Eingabe wird angenommen (Grid ändert sich)", JSON.stringify(leader.grid) !== gridBeforeIngame || leader.piece === null);

  // (d) POST_GAME: Eingabe WIEDER verworfen
  room.status = "POST_GAME";
  const gridBeforePost = JSON.stringify(leader.grid);
  room.handleAction(sock, "MOVE_LEFT");
  room.handleAction(sock, "ROTATE");
  room.handleAction(sock, "HARD_DROP");
  check("POST_GAME: Grid unverändert (Shapes nicht mehr bewegbar)", JSON.stringify(leader.grid) === gridBeforePost);

  // (e) Specials in POST_GAME: Inventar bleibt erhalten
  leader.specialsInventory.push("A");
  room.handleUseSpecial(sock, 1, "A");
  check("POST_GAME: Special NICHT verbraucht (Inventar bleibt)", leader.specialsInventory.includes("A"));
  // In LOBBY ebenfalls
  room.status = "LOBBY";
  room.handleUseSpecial(sock, 1, "A");
  check("LOBBY: Special NICHT verbraucht", leader.specialsInventory.includes("A"));
}

/* ---------------------------------------------------------------- */
console.log(failures === 0 ? "\n✅ ALLE READY-CHECK-TESTS GRÜN" : `\n❌ ${failures} FEHLER`);
process.exit(failures === 0 ? 0 : 1);
