/**
 * Nacht 18: Teams (Solo / 2er / 3er) — Server-Kern-Tests.
 *
 * Deckt ab:
 *  [1] Solo-Regression: letzter aktiver Spieler gewinnt (wie vor 18).
 *  [2] Team2: 6 Spieler (3x2), ein ganzes Team scheidet aus → Team-Winner.
 *  [3] Team3: 6 Spieler (2x3), ein ganzes Team scheidet aus → Team-Winner.
 *  [4] Team-Modus: Specials auf TEAMMATES erlaubt (aktiv), auf
 *      Ausgeschiedene (auch Teammate) weiterhin verworfen.
 *  [5] assignTeams: Reihenfolge & Größe bei Moduswechsel + Join/Leave.
 *
 * Aufruf: node scripts/test-teams.mjs
 */
import { Player } from "../packages/server/dist/game/Player.js";
import { GameRoom } from "../packages/server/dist/game/Room.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${detail}`);
    failures++;
  }
}

const io = {
  to: () => ({ emit: () => {} }),
  use: () => ({ emit: () => {} }),
};

function makeRoom(players) {
  const room = new GameRoom("test-room", io);
  room.players = players;
  room.status = "INGAME"; // NACHT 19.4: Specials-Guard testet im laufenden Spiel
  return room;
}

function six() {
  const names = ["P1", "P2", "P3", "P4", "P5", "P6"];
  return names.map((n, i) => new Player(`id-${i}`, n, 100 + i));
}

const leaderSocket = { id: "id-0" }; // id-0 = P1 = erst-joinender Mensch = Leader

/* ---------------------------------------------------------------- */
console.log("\n[1] Solo-Regression: letzter aktiver Spieler gewinnt");
{
  const room = makeRoom(six());
  room.gameMode = "solo";
  room.assignTeams();
  check("Solo: alle ohne Team", room.players.every((p) => p.team === undefined));

  // Alle außer P1 ausgeschieden
  for (const p of room.players) if (p.id !== "id-0") p.status = "spectator";
  const winner = room.getWinner();
  check("Solo: P1 ist Winner", winner?.id === "id-0");
  check("Solo: WinnerTeam = null", room.getWinnerTeam() === null);

  // Mehrere aktiv → offen
  for (const p of room.players) if (p.status === "spectator") p.status = "active";
  room.players[3].status = "spectator";
  room.players[4].status = "spectator";
  const open = room.getWinner();
  check("Solo: 2 aktiv → kein Winner", open === null);
}

/* ---------------------------------------------------------------- */
console.log("\n[2] Team2 (3x2): Team-Ausscheidung → Team-Winner");
{
  const room = makeRoom(six());
  room.gameMode = "team2";
  room.assignTeams();
  check("Team2-Roster A,A,B,B,C,C", room.players.map((p) => p.team).join("") === "AABBCC", room.players.map((p) => p.team).join(""));

  // Team A (P1,P2) scheidet komplett aus
  room.players[0].status = "spectator";
  room.players[1].status = "spectator";
  const winner = room.getWinner();
  check("2 aktiv Teams (B,C) → noch kein Winner", winner === null);

  // Team B scheidet komplett aus → Team C gewinnt
  room.players[2].status = "spectator";
  room.players[3].status = "spectator";
  const w2 = room.getWinner();
  check("Team C gewinnt (letztes aktives Team)", w2?.id === "id-4" || w2?.id === "id-5");
  check("WinnerTeam = C", room.getWinnerTeam() === "C");

  // Teammate-Aktiv: beide C aktiv → Winner ist eines der C-Mitglieder
  const w3 = room.getWinner();
  check("Winner hat Team C", w3?.team === "C");
}

/* ---------------------------------------------------------------- */
console.log("\n[3] Team3 (2x3): Team-Ausscheidung → Team-Winner");
{
  const room = makeRoom(six());
  room.gameMode = "team3";
  room.assignTeams();
  check("Team3-Roster A,A,A,B,B,B", room.players.map((p) => p.team).join("") === "AAABBB", room.players.map((p) => p.team).join(""));

  // Team A scheidet komplett aus → Team B gewinnt
  room.players[0].status = "spectator";
  room.players[1].status = "spectator";
  check("2 Teams aktiv (A+B) → noch kein Winner", room.getWinner() === null);
  room.players[2].status = "spectator";
  const w = room.getWinner();
  check("Team B gewinnt", w && (w.id === "id-3" || w.id === "id-4" || w.id === "id-5"));
  check("WinnerTeam = B", room.getWinnerTeam() === "B");

  // Team B scheidet auch aus → kein Winner mehr (alle inaktiv)
  room.players[3].status = "spectator";
  room.players[4].status = "spectator";
  room.players[5].status = "spectator";
  check("Alle inaktiv → null", room.getWinner() === null);
}

/* ---------------------------------------------------------------- */
console.log("\n[4] Specials: Teammates sind legale Ziele (aktiv), Ausgeschiedene nicht");
{
  const { applySpecialToGrid } = await import("../packages/shared/dist/index.js");
  const room = makeRoom(six());
  room.gameMode = "team2";
  room.assignTeams();
  // P1 & P2 = Team A (Teammates), P3 & P4 = Team B
  const attacker = room.players[1]; // P2, Team A
  const teammate = room.players[0]; // P1, Team A
  const enemy = room.players[2];    // P3, Team B

  // Erst etwas auf Teammates unterste Zeile legen (C löscht genau die).
  for (let x = 0; x < 6; x++) teammate.grid[21][x] = 3;
  const bottomBefore = teammate.grid[21].filter((v) => v !== 0).length;
  attacker.specialsInventory = ["C"];
  const fakeSocket = { id: "id-1" };
  room.handleUseSpecial(fakeSocket, 1, "C"); // P2's Ansicht: [P2, P1, P3..P6] → P1 = Index 1
  check("C auf TEAMMATE: erlaubt (unterste Zeile geleert)", teammate.grid[21].every((v) => v === 0) && bottomBefore > 0);
  check("Special aus Attacker-Inventory abgezogen", attacker.specialsInventory.length === 0);

  // Teammate AUSGESCHIEDEN → weiterhin verworfen (17.2-Regel bleibt)
  const room2 = makeRoom(six());
  room2.gameMode = "team2";
  room2.assignTeams();
  const att2 = room2.players[1];
  const tm2 = room2.players[0];
  tm2.status = "spectator";
  tm2.grid[21][0] = 3;
  att2.specialsInventory = ["C"];
  room2.handleUseSpecial({ id: "id-1" }, 1, "C");
  check("C auf ausgeschiedenen TEAMMATE: verworfen", tm2.grid[21][0] === 3);
  check("Special bleibt im Inventory", att2.specialsInventory.length === 1);

  // Gegner-Teammate (Team B) von P1 aus: ebenfalls legal
  const room3 = makeRoom(six());
  room3.gameMode = "team2";
  room3.assignTeams();
  const att3 = room3.players[0]; // P1 Team A
  const enemy3 = room3.players[2]; // P3 Team B
  enemy3.grid[21][0] = 3;
  const enemyBottomBefore = enemy3.grid[21].filter((v) => v !== 0).length;
  att3.specialsInventory = ["C"];
  room3.handleUseSpecial({ id: "id-0" }, 2, "C"); // P1's Ansicht: [P1, P2, P3..] → P3 = Index 2
  check("C auf GEGNER (anderes Team): erlaubt (Zeile geleert)", enemy3.grid[21].every((v) => v === 0) && enemyBottomBefore > 0 && att3.specialsInventory.length === 0);
}

/* ---------------------------------------------------------------- */
console.log("\n[5] assignTeams bei Moduswechsel & 5-Spieler-Raum");
{
  const room = makeRoom(six());
  room.gameMode = "solo";
  room.assignTeams();
  check("solo: alle undefined", room.players.every((p) => p.team === undefined));

  room.gameMode = "team3";
  room.assignTeams();
  check("team3: 3 A + 3 B", [3, 3].map((n, i) => room.players.filter((p) => p.team === (i ? "B" : "A")).length).join(",") === "3,3");

  room.gameMode = "team2";
  room.assignTeams();
  check("team2: 2 A + 2 B + 2 C", ["A", "B", "C"].map((t) => room.players.filter((p) => p.team === t).length).join(",") === "2,2,2");

  // 5 Spieler in team2 → A,A,B,B,C (letzte Team unvollständig, aber valide)
  const room5 = makeRoom(six().slice(0, 5));
  room5.gameMode = "team2";
  room5.assignTeams();
  check("5 Spieler team2: A,A,B,B,C", room5.players.map((p) => p.team).join("") === "AABB C".replace(" ", ""), room5.players.map((p) => p.team).join(""));

  // setGameMode: nur Leader (id-0 = P1)
  const nonLeader = { id: "id-2" };
  room5.gameMode = "solo";
  room5.setGameMode(nonLeader, "team3");
  check("setGameMode: Nicht-Leader abgelehnt", room5.gameMode === "solo");
  room5.setGameMode({ id: "id-0" }, "team3");
  check("setGameMode: Leader akzeptiert", room5.gameMode === "team3");
  room5.setGameMode({ id: "id-0" }, "unsinn");
  check("setGameMode: ungültiger Modus abgelehnt", room5.gameMode === "team3");
}

/* ---------------------------------------------------------------- */
console.log(failures === 0 ? "\n✅ ALLE TEAM-TESTS GRÜN" : `\n❌ ${failures} FEHLER`);
process.exit(failures === 0 ? 0 : 1);
