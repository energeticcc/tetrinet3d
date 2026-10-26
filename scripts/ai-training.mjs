/**
 * AI-Training — zwei KI-Agenten spielen endlos gegeneinander.
 *
 * Nutzt NUR die öffentliche AI-API (HTTP) — genau wie ein externes LLM es
 * würde. Du kannst es dir live im Browser (http://localhost:5173) ansehen:
 *   - Alpha (Cyan) und Beta (Orange) bauen Stacks, räumen Zeilen,
 *   - setzen Specials gegenseitig ein (A/R/N/O/B/Q ...),
 *   - bei Game-Over wird automatisch Rematch gestartet → endlose Show.
 *
 * Start:  node scripts/ai-training.mjs
 * Stop:   Strg+C  (entfernt beide Agents automatisch)
 */
import { collides, hardDrop, cloneGrid, SPAWN_X, GRID_WIDTH } from "../packages/shared/dist/index.js";

const BASE = process.env.TETRIS_AI_BASE || "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ */
/* Platzierungs-KI (Nacht 17): Vollständige Enumeration aller           */
/* Rotationen + X-Positionen, bewertet wie der Server-BotAI.           */
/* Ersetzt die alte „flachste Spalte"-Heuristik, die hohe Stacks und   */
/* Lücken akzeptierte.                                                 */
/* ------------------------------------------------------------------ */

/** Höhe pro Spalte (0 = leer, H = voll). */
function columnHeights(grid) {
  const H = grid?.length ?? 22;
  const W = grid?.[0]?.length ?? 12;
  const hs = new Array(W).fill(0);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (grid[y][x] !== 0) { hs[x] = H - y; break; }
    }
  }
  return hs;
}

/** Heuristischer Score eines abgestellten Felds (höher = besser). */
function scoreGrid(grid) {
  const H = grid.length;
  const W = grid[0].length;
  const hs = columnHeights(grid);
  let lines = 0, holes = 0, bumpy = 0, height = 0, overhang = 0;
  for (let x = 0; x < W; x++) {
    const h = hs[x];
    height += h;
    for (let y = H - h; y < H; y++) if (grid[y][x] === 0) holes++;
    if (h > 0) {
      for (let y = H - h + 1; y < H; y++) {
        const row = grid[y];
        let left = null, right = null;
        for (let i = x - 1; i >= 0 && left === null; i--) if (row[i]) left = i;
        for (let i = x + 1; i < W && right === null; i++) if (row[i]) right = i;
        if (left !== null && right !== null && row[x] === 0) overhang++;
      }
    }
  }
  for (let x = 0; x < W - 1; x++) bumpy += Math.abs(hs[x] - hs[x + 1]);
  for (let y = 0; y < H; y++) if (grid[y].every((v) => v !== 0)) lines++;
  return lines * 120 - holes * 8 - height * 0.9 - bumpy * 2 - overhang * 3;
}

/**
 * Bester (x, rotation) für das Stück `type` auf `grid` — durchsucht alle
 * 4 Rotationen × alle X-Positionen. Gibt auch `rotCount` (wieviele
 * ROTATE-Aktionen vom Spawn-Zustand nötig, mod 4) zurück.
 */
function bestPlacement(grid, type) {
  let best = null;
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -4; x <= GRID_WIDTH + 2; x++) {
      const g = cloneGrid(grid);
      const p = { type, rotation: rot, x, y: 0 };
      if (collides(g, type, rot, x, 0)) continue;
      hardDrop(g, p);
      const sc = scoreGrid(g);
      if (!best || sc > best.score) best = { x, rot, rotCount: rot, score: sc };
    }
  }
  if (!best) return { x: SPAWN_X, rot: 0, rotCount: 0, score: -Infinity };
  // rotCount relativ zum Spawn (x=SPAWN_X, rotation=0):
  best.rotCount = ((best.rot % 4) + 4) % 4;
  return best;
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data;
}

const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);

/**
 * Steuerungszustand pro Agent. Führt ein Stück durch eine kurze Sequenz:
 *   1) Ziel-Spalte wählen (flachste), 2) Schritt für Schritt dorthin,
 *   3) ggf. drehen, 4) Hard-Drop. Erst dann zum nächsten Stück.
 */
class AgentController {
  constructor(name) {
    this.name = name;         // z. B. "AI-Alpha"
    this.id = null;           // wird bei (Re-)Registrierung gesetzt
    this.lastReconnect = 0;   // Cooldown für Re-Register-Versuche
    this._resetState();
  }

  /** Strategie-State zurücksetzen (nach (Re-)Registrierung). */
  _resetState() {
    this.lastType = null;        // Stück-Typ des laufenden Plans
    this.seq = [];               // geplante Aktions-Sequenz (Warteschlange)
    this.cooldownUntil = 0;      // Rematch-/Special-Kühlzeit
    this.bestOppIdx = 1;
  }

  /**
   * NIGHT-16-FIX: Wenn der Server neu gestartet wurde, sind die in-process
   * AI-Agenten weg (neue Registry). `GET /ai/status` liefert dann
   * `error` → wir registrieren NEU. (Der Server meldt disconnect jetzt
   * sauber, s. AiAgentManager.) ~2 s Cooldown gegen Request-Flut.
   */
  async ensureRegistered() {
    if (this.id) {
      try {
        const s = await GET(`/ai/status?agent=${this.id}`);
        if (s && !s.error) return s;
      } catch { /* Agent weg (Server-Neustart) → unten neu registrieren. */ }
    }
    if (Date.now() < this.lastReconnect) return null;
    this.lastReconnect = Date.now() + 2000;
    try {
      const reg = await POST("/ai/register", { name: this.name });
      this.id = reg.agentId;
      this._resetState();
      log(`   🔄 ${this.name} neu registriert → ${this.id} (Server-Neustart?)`);
      const s = await GET(`/ai/status?agent=${this.id}`);
      if (s && !s.error) return s;
    } catch (e) {
      // Server noch nicht da (Neustart läuft) — nächster Versuch später.
    }
    return null;
  }

  /**
   * Plane die komplette Aktions-Sequenz für das aktuelle Stück — EXAKT wie
   * der Server-BotAI: N× ROTATE → M× LEFT/RIGHT → HARD_DROP.
   * Wichtig: Die Rotation wird VON SPAWN (rotation=0) nach VORN gezählt,
   * NICHT aus dem live Zustand — das verhindert die Rotation-Oszillation.
   */
  buildSequence(grid, type) {
    const bp = bestPlacement(grid, type);
    const seq = [];
    const rotCount = ((bp.rot % 4) + 4) % 4; // 0..3 ROTATEs ab Spawn
    for (let i = 0; i < rotCount; i++) seq.push("ROTATE");
    const dx = bp.x - SPAWN_X;
    if (dx > 0) for (let i = 0; i < dx; i++) seq.push("RIGHT");
    else for (let i = 0; i < -dx; i++) seq.push("LEFT");
    seq.push("HARD_DROP");
    return seq;
  }

  async step(s, opponents, round) {
    // Kein aktives Stück → warten (bis ein neues kommt / Rematch).
    if (!s.activePiece) {
      this.seq = [];
      this.maybeRematch(s, opponents);
      this.maybeSpecial(s, opponents);
      return;
    }

    const p = s.activePiece;
    const type = p.type;
    const sig = `${p.x}:${p.y}:${p.rotation}`;

    // Neues Stück (Phase idle ODER Typ gewechselt) → Sequenz planen.
    if (this.seq.length === 0 || type !== this.lastType) {
      this.lastType = type;
      this.seq = this.buildSequence(s.grid, type);
      this.maybeSpecial(s, opponents);
      return;
    }

    // NÄCHSTE Aktion aus der Sequenz ausführen (eins pro Tick = sichtbar).
    // HARD_DROP am Ende → Queue leer → nächstes Stück wird geplant.
    // Kein Re-Evaluiere, keine Oszillation — exakt wie der Server-BotAI.
    const action = this.seq.shift();
    if (!action) { this.maybeRematch(s, opponents); return; }
    await this.act(action);
    if (action === "HARD_DROP") this.lastType = null; // Force re-plan next piece.
  }

  async act(action) {
    try {
      await POST(`/ai/action?agent=${this.id}`, { action });
    } catch (e) { /* Aktion kann bei Race mit Lock fehlschlagen — egal */ }
  }

  /**
   * Tipp 3: Special-Strategie (aus mdbot/session-10min-live.md):
   *   - Negative (A/R/O/Q/B): feuern auf den Gegner mit dem HÖCHSTEN Score.
   *   - Positive (C/G/S/N): nur, wenn eigenes Feld > 60 % gefüllt ist.
   *   - Cooldown 1200 ms, Treffer-Rate ~8 %.
   */
  maybeSpecial(s, opponents) {
    if (Date.now() < this.cooldownUntil) return;
    const inv = s.inventory || [];
    if (!inv.length) return;
    const activeOpps = (opponents || []).filter((o) => o.status === "active");
    if (!activeOpps.length) return;

    // Gegner mit höchstem Score = wahrscheinlich höchste Füllung (Proxy).
    const allOpps = opponents || [];
    const bestOpp = activeOpps.reduce((a, b) => (b.score > a.score ? b : a));
    // targetIndex in der KUNDEN-ANSICHT (sortWithSelfFirst): 0 = ich, 1..n = Gegner.
    const pos = allOpps.findIndex((o) => o.id === bestOpp.id);
    this.bestOppIdx = pos >= 0 ? pos + 1 : 1;

    // NACHT 19.7 (inventory-addon.md): STRICT FIFO — der Server akzeptiert
    // NUR das Front-Special (Index 0). Wir feuern es also nur, wenn es in
    // der Lage sinnvoll wirkt (heuristisch), sonst warten wir.
    const NEG = ["A", "R", "O", "Q", "B"];
    const POS = ["C", "G", "S", "N"];
    const ownFill = this.ownFillRatio(s);

    let type = null;
    const front = inv[0];
    if (NEG.includes(front)) type = front;
    else if (POS.includes(front) && ownFill > 0.6) type = front;
    if (!type) return;

    if (Math.random() < 0.08) { // ~8 % pro Zyklus
      this.cooldownUntil = Date.now() + 1200;
      POST(`/ai/special?agent=${this.id}`, {
        targetIndex: this.bestOppIdx,
        specialType: type,
      }).catch(() => {});
    }
  }

  /** Eigene Füllung: gefüllte Zellen / Gesamtfeld (einfache Heuristik). */
  ownFillRatio(s) {
    const g = s.grid;
    if (!g?.length) return 0;
    let filled = 0, total = 0;
    for (const row of g) for (const v of row) { total++; if (v !== 0) filled++; }
    return total ? filled / total : 0;
  }

  /** Nach Game-Over: Rematch (Kühlzeit, um Race-Zustände zu vermeiden). */
  maybeRematch(s, opponents) {
    if (s.ownStatus === "active") return;
    if (Date.now() < this.cooldownUntil) return;
    // Rematch nur, wenn das Spiel wirklich beendet ist (min. 1 Inaktiver).
    const anyInactive = (opponents || []).some((o) => o.status !== "active");
    if (!anyInactive && s.ownStatus === "winner") {
      this.cooldownUntil = Date.now() + 1200;
      POST(`/ai/rematch?agent=${this.id}`).catch(() => {});
    } else if (s.ownStatus === "spectator") {
      this.cooldownUntil = Date.now() + 2000;
      POST(`/ai/rematch?agent=${this.id}`).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hauptlauf                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  log("🤖 AI-Training startet —", BASE);
  try {
    const cAlpha = new AgentController("AI-Alpha");
    const cBeta = new AgentController("AI-Beta");
    const controllers = [cAlpha, cBeta];

    let round = 0;
    while (true) {
      round++;
      // Beide Agenten einen Takt voranbringen (parallel).
      // ensureRegistered() registriert automatisch neu, wenn der Server
      // neu gestartet wurde (Nacht-16-Fix: Agents sterben sonst still).
      const results = await Promise.allSettled(
        controllers.map((c) => c.ensureRegistered()),
      );
      await Promise.allSettled(
        controllers.map(async (c, i) => {
          const s = results[i]?.value;
          if (!s || s.error) return;
          await c.step(s, s.opponents, round);
        }),
      );

      // Periodischer Scoreboard-Print (alle 40 Takte ≈ 6s)
      if (round % 40 === 0) {
        const [sa, sb] = await Promise.all([
          cAlpha.id ? GET(`/ai/status?agent=${cAlpha.id}`).catch(() => null) : null,
          cBeta.id ? GET(`/ai/status?agent=${cBeta.id}`).catch(() => null) : null,
        ]);
        if (sa && sb) {
          log(`   ⚔️  Alpha ${sa.ownStatus} (${sa.score} Pkt, Stack ${sa.ownStackTop})  |  Beta ${sb.ownStatus} (${sb.score} Pkt, Stack ${sb.ownStackTop})`);
        }
      }

      await sleep(140); // ~7 Takte/s pro Agent — sichtbar, aber nicht zu schnell
    }
    // while(true) läuft endlos; der Aufräum-Fall (Fehler) wird unten gefangen.
  } catch (e) {
    log("⚠️  Trainingslauf abgebrochen:", e.message);
    throw e;
  }
}

// Sauberes Beenden: ALLE registrierten AI-Agenten trennen.
async function cleanup() {
  let ids = [];
  try { ids = (await GET("/ai/agents")).agents?.map((a) => a.id) || []; }
  catch { /* Server weg — egal */ }
  for (const a of ids) {
    try { await api("DELETE", `/ai/agents?agent=${a}`); log(`   Agent ${a} getrennt.`); }
    catch { /* Server weg — egal */ }
  }
}

process.on("SIGINT", async () => {
  log("🛑 Training wird beendet (Agenten trenne ich).");
  await cleanup();
  process.exit(0);
});

main().catch((e) => {
  log("❌", e.message);
  process.exit(1);
});
