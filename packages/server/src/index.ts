import http, { createServer } from "node:http";
import { Server } from "socket.io";
import { GameRoom } from "./game/Room.js";
import { registerSocketHandlers } from "./network/socketHandler.js";
import { AiAgentManager } from "./ai/AiAgentManager.js";
import type { PlayerAction, SpecialType, BotDifficulty } from "@tetrinet3d/shared";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 3000;
// NIGHT-16.4 (LAN-Fix): Server-URL für AI-Agenten (in-process) bleibt localhost,
// aber der HTTP-Server bindet auf 0.0.0.0 → erreichbar im LAN.
const SERVER_URL = `http://localhost:${PORT}`;
// NIGHT-16.4: Pfad zur Client-Dist (produktions-Build von `npm run build`).
// Wenn vorhanden, wird sie auf GET /  (und /assets/*) ausgeliefert →
// ein LAN-Client kann direkt http://<LAN-IP>:3000/ aufrufen und das Spiel
// in SAME-ORIGIN-Konstellation laden (kein CORS, kein 2. Port nötig).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Nacht 16.4: CLIENT_DIST-Path muss sowohl im DEV-Modus (tsx src/index.ts)
// als auch im BUILD-Modus (dist/index.js) funktionieren. Wir prüfen beide
// Kandidaten und nehmen den ersten, der existiert.
const distCandidates = [
  path.resolve(__dirname, "../../client/dist"), // src/index.ts ODER dist/index.js → packages/client/dist
  path.resolve(process.cwd(), "packages/client/dist"),
];
const CLIENT_DIST = distCandidates.find((p) => existsSync(p)) ?? distCandidates[0];

/* ------------------------------------------------------------------ */
/* AI-Agenten-Brücke (in-process, nutzt das GLEICHE Socket-Protokoll) */
/* ------------------------------------------------------------------ */
const aiManager = new AiAgentManager(SERVER_URL);

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function handleAiApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const path = url.pathname;
  const method = req.method;
  const agentId = url.searchParams.get("agent") ?? undefined;

  const handle = async (fn: (body: any) => unknown): Promise<void> => {
    const body = method === "POST" ? await readJsonBody(req) : {};
    try {
      const result = await fn(body);
      sendJson(res, 200, result ?? { ok: true });
    } catch (e: any) {
      sendJson(res, 500, { error: e?.message ?? String(e) });
    }
  };

  // GET: LLM-lesbare Spielspezifikation + API-Doku
  if (path === "/ai/describe" && method === "GET") {
    sendJson(res, 200, aiManager.describe());
    return;
  }

  // GET: alle Agenten
  if (path === "/ai/agents" && method === "GET") {
    sendJson(res, 200, { count: aiManager.count, agents: aiManager.list() });
    return;
  }

  // POST: Agenten registrieren
  if (path === "/ai/register" && method === "POST") {
    handle(async (body) => {
      const name = typeof body?.name === "string" ? body.name : `AI-${Date.now().toString(36)}`;
      return { ok: true, ...(await aiManager.register(name)) };
    });
    return;
  }

  // GET: Status eines Agents
  if (path === "/ai/status" && method === "GET") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    const st = aiManager.status(agentId);
    sendJson(res, st.error ? 404 : 200, st);
    return;
  }

  // POST: Aktion (LEFT/RIGHT/ROTATE/SOFT_DROP/HARD_DROP)
  if (path === "/ai/action" && method === "POST") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    handle(async (body) => {
      const action = (body?.action ?? "") as PlayerAction;
      const valid = ["LEFT", "RIGHT", "ROTATE", "SOFT_DROP", "HARD_DROP"] as const;
      if (!(valid as readonly string[]).includes(action)) {
        return { ok: false, error: `Ungültige Aktion. Erlaubt: ${valid.join(", ")}.` };
      }
      return aiManager.action(agentId, action);
    });
    return;
  }

  // POST: Special abfeuern
  if (path === "/ai/special" && method === "POST") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    handle(async (body) => {
      const targetIndex = Math.max(0, Math.min(5, body?.targetIndex ?? 0));
      const specialType = (body?.specialType ?? "A") as SpecialType;
      return aiManager.special(agentId, targetIndex, specialType);
    });
    return;
  }

  // POST: Chat
  if (path === "/ai/chat" && method === "POST") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    handle(async (body) => aiManager.chat(agentId, body?.text ?? ""));
    return;
  }

  // POST: Rematch
  if (path === "/ai/rematch" && method === "POST") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    handle(() => aiManager.rematch(agentId));
    return;
  }

  // POST: Bots verwalten
  if (path === "/ai/bots" && method === "POST") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    handle(async (body) => {
      if (body?.remove) return aiManager.removeBots(agentId);
      const count = Math.max(1, Math.min(5, body?.add ?? 1));
      const difficulty = body?.difficulty as BotDifficulty | undefined;
      return aiManager.addBots(agentId, count, difficulty);
    });
    return;
  }

  // DELETE: Agenten entfernen
  if (path === "/ai/agents" && method === "DELETE") {
    if (!agentId) { sendJson(res, 400, { error: "?agent=<agentId> fehlt." }); return; }
    sendJson(res, 200, aiManager.unregister(agentId));
    return;
  }

  sendJson(res, 404, { error: `Unbekannter AI-Endpunkt: ${method} ${path}` });
}

/* ------------------------------------------------------------------ */
/* HTTP-Server + socket.io                                             */
/* ------------------------------------------------------------------ */

// NIGHT-16.4 (LAN-Fix): Statische Dateien (index.html, assets/*) aus
// client/dist servieren — SO, dass ein externer Spieler das Spiel direkt
// auf http://<LAN-IP>:3000/ laden kann (SAME-ORIGIN, kein CORS nötig).
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!existsSync(CLIENT_DIST)) return false; // kein Build vorhanden → normaler Text-Response

  // Pfad relativ zur Dist-Root ("/" → index.html). Keine ".."-Traversals!
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Security: nur Dateinamen, keine Pfade mit "/..".
  if (rel.includes("..")) {
    res.writeHead(403).end("Forbidden");
    return true;
  }
  const filePath = path.join(CLIENT_DIST, rel.replace(/^\//, ""));
  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403).end("Forbidden");
    return true;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // Fallback: SPA → index.html für unbekannte Pfade (außer /assets/*).
    if (url.pathname.startsWith("/assets/")) {
      res.writeHead(404).end("Not Found");
    } else {
      const index = await readFile(path.join(CLIENT_DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(index);
    }
  }
  return true;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // AI-API (vor dem /health-Check)
  if (url.pathname.startsWith("/ai")) {
    handleAiApi(req, res, url);
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  // NIGHT-16.4 (LAN-Fix): Client-Dist statisch ausliefern (index.html, assets/*).
  // Damit funktioniert http://<LAN-IP>:3000/ ohne Vite, ohne CORS, ohne 2. Port.
  if (await serveStatic(req, res, url)) return;

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    "Tetrinet3D Server läuft.\n"
    + "- Spiel:   http://<diese-Adresse>:5173/  (Vite)  ODER  http://<diese-Adresse>:3000/  (Dist-Build)\n"
    + "- WebSocket: via socket.io\n"
    + "- AI-API:  GET /ai/describe  (Spielspezifikation + Endpunkte)\n"
  );
});

const io = new Server(httpServer, {
  // NIGHT-16.4 (LAN-Fix): CORS auf ANY-ORIGIN für den LAN-Fall —
  // der Browser-Client kommt von http://<LAN-IP>:5173 (Vite) ODER
  // http://<LAN-IP>:3000 (Dist-Build, SAME-ORIGIN). `origin: true`
  // spiegelt die anfragende Origin zurück → funktioniert in beiden Fällen.
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

// Raum-Registry (einzelne globale Arena reicht für das 6-Player-Setup)
const rooms = new Map<string, GameRoom>();
registerSocketHandlers(io, rooms);

// NIGHT-16.4 (LAN-Fix): auf 0.0.0.0 binden → von außen im LAN erreichbar.
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] 3D Tetrinet-Server auf http://0.0.0.0:${PORT} (LAN-erreichbar)`);
  console.log(`[Server] Spiel:   http://localhost:${PORT}/  (Dist-Build)  ODER  http://localhost:5173/  (Vite)`);
  console.log("[Server] CORS: ANY (LAN-ready)");
});

/* Graceful Shutdown */
function shutdown(signal: string): void {
  console.log(`[Server] ${signal} erhalten, fahre herunter…`);
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
