/* Servidor de Last Stick Standing V2: HTTP (sirve el cliente compilado + /health) y WebSocket
   binario con salas de juego autoritativas y salas de mandos para celulares.

   Una sola instancia (las salas viven en memoria). Pensado para la VM de Oracle detrás de Caddy. */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { decode } from "@lss/shared";
import { ClientMsgSchema } from "@lss/shared/schemas";
import { send } from "./util";
import {
  countPlayers, createRoom, destroyRoom, handleRoomMessage, joinRoom, leaveRoom, rejoinRoom, rooms, sweepRooms, type SocketMeta,
} from "./rooms";
import { destroyPadRoom, handlePadMessage, padLeave, padRooms, sweepPadRooms, type PadMeta } from "./pads";

const args = process.argv.slice(2);
const argPort = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : NaN;
/* Solo para probar el netcode: --lag N agrega N ms de ida y vuelta (mitad en cada sentido) y
   --jitter J hasta J ms extra al azar. No afecta nada si no se pasa. */
const LAG_MS = args.includes("--lag") ? Number(args[args.indexOf("--lag") + 1]) || 0 : 0;
const JITTER_MS = args.includes("--jitter") ? Number(args[args.indexOf("--jitter") + 1]) || 0 : 0;
const oneWay = () => LAG_MS / 2 + Math.random() * JITTER_MS;
const PORT = Number(process.env.PORT) || argPort || 8080;
const MAX_MSG_BYTES = 4096;
const MAX_MSG_PER_SEC = 240; // un cliente normal manda ~60 frames de input por segundo
const HEARTBEAT_MS = 10000;

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(here, "../../client/dist");

/* ------------------------------------------------------------------ estáticos */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".webp": "image/webp", ".woff2": "font/woff2", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

function serveFile(res: http.ServerResponse, file: string, cache: string) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("404"); return; }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    res.end(JSON.stringify({ ok: true, version: 2, rooms: rooms.size, players: countPlayers(), padRooms: padRooms.size }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  if (url === "/" || url === "/index.html") return serveFile(res, path.join(STATIC_DIR, "index.html"), "no-cache");
  if (url === "/pad" || url === "/pad.html") return serveFile(res, path.join(STATIC_DIR, "pad.html"), "no-cache");
  const file = path.normalize(path.join(STATIC_DIR, url));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return; }
  // los assets de Vite llevan hash en el nombre: se cachean para siempre
  const cache = url.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600";
  if (!path.extname(file)) return serveFile(res, path.join(STATIC_DIR, "index.html"), "no-cache");
  serveFile(res, file, cache);
});

/* ------------------------------------------------------------------ WebSocket */
interface Meta extends SocketMeta, PadMeta {
  msgCount: number;
  msgWindow: number;
  alive: boolean;
  lagInAt?: number;
}

const metas = new WeakMap<WebSocket, Meta>();
const metaOf = (ws: WebSocket) => metas.get(ws);
const codeTaken = (c: string) => rooms.has(c) || padRooms.has(c);

function detachGame(ws: WebSocket) {
  const m = metas.get(ws);
  if (m) { m.room = null; m.playerId = null; }
}

function handleMessage(ws: WebSocket, meta: Meta, raw: Buffer) {
  let parsed: unknown;
  try { parsed = decode(raw); } catch { return; }
  const res = ClientMsgSchema.safeParse(parsed);
  if (!res.success) return;
  const msg = res.data;

  if (msg.t === "ping") { send(ws, { t: "pong", ts: msg.ts }); return; }
  if (handlePadMessage(ws, meta, !!meta.room, msg, codeTaken, metaOf)) return;

  switch (msg.t) {
    case "create": {
      if (meta.room || meta.padRoom) return;
      const room = createRoom(codeTaken);
      if (!room) { send(ws, { t: "err", code: "noCodes", msg: "No hay códigos de sala libres, probá de nuevo." }); return; }
      const r = joinRoom(room, ws, meta, msg.nick, msg.color, msg.hat);
      if (r.err) { destroyRoom(room); send(ws, { t: "err", code: r.code || "generic", msg: r.err }); }
      return;
    }
    case "join": {
      if (meta.room || meta.padRoom) return;
      const room = rooms.get(msg.code.toUpperCase().trim());
      if (!room) { send(ws, { t: "err", code: "noRoom", msg: "No existe una sala con ese código." }); return; }
      const r = joinRoom(room, ws, meta, msg.nick, msg.color, msg.hat);
      if (r.err) send(ws, { t: "err", code: r.code || "generic", msg: r.err });
      return;
    }
    case "rejoin": {
      if (meta.room) return;
      const room = rooms.get(msg.code.toUpperCase().trim());
      if (!room || !rejoinRoom(room, ws, meta, msg.token, detachGame)) send(ws, { t: "rejoinFailed" });
      return;
    }
    case "leave":
      leaveRoom(ws, meta);
      meta.room = null;
      meta.playerId = null;
      return;
  }

  const room = meta.room;
  if (!room || !rooms.has(room.code) || meta.playerId === null) return;
  const player = room.players.get(meta.playerId);
  if (!player || player.ws !== ws) return;
  handleRoomMessage(room, player, msg as { t: string; [k: string]: unknown });
}

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

wss.on("connection", (ws) => {
  if (LAG_MS || JITTER_MS) {
    // demora simulada de salida, respetando el orden (como TCP)
    const rawSend = ws.send.bind(ws);
    let lastAt = 0;
    (ws as unknown as { send: (d: unknown) => void }).send = (d: unknown) => {
      const at = Math.max(lastAt, Date.now() + oneWay());
      lastAt = at;
      setTimeout(() => { if (ws.readyState === 1) rawSend(d as Buffer); }, at - Date.now());
    };
  }
  const meta: Meta = { room: null, playerId: null, padRoom: null, padId: null, padHost: false, msgCount: 0, msgWindow: Date.now(), alive: true };
  metas.set(ws, meta);
  ws.on("pong", () => { meta.alive = true; });
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const now = Date.now();
    if (now - meta.msgWindow > 1000) { meta.msgWindow = now; meta.msgCount = 0; }
    if (++meta.msgCount > MAX_MSG_PER_SEC) return;
    if (LAG_MS || JITTER_MS) {
      const at = Math.max(meta.lagInAt || 0, Date.now() + oneWay());
      meta.lagInAt = at;
      setTimeout(() => handleMessage(ws, meta, data as Buffer), at - Date.now());
    }
    else handleMessage(ws, meta, data as Buffer);
  });
  const bye = () => { leaveRoom(ws, meta); padLeave(ws, meta); };
  ws.on("close", bye);
  ws.on("error", bye);
});

/* Dos ciclos para dar a alguien por muerto: el peor caso de "fantasma" en la ronda es ~20 s. */
setInterval(() => {
  for (const ws of wss.clients) {
    const m = metas.get(ws);
    if (!m) continue;
    if (!m.alive) { ws.terminate(); continue; }
    m.alive = false;
    try { ws.ping(); } catch { /* el close se encarga */ }
  }
}, HEARTBEAT_MS);

setInterval(() => {
  sweepPadRooms(metaOf);
  sweepRooms();
}, 2000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Last Stick Standing V2 — escuchando en :${PORT} (estáticos: ${STATIC_DIR})${LAG_MS || JITTER_MS ? ` [lag simulado ${LAG_MS}ms ±${JITTER_MS}]` : ""}`);
});

function shutdown() {
  console.log("cerrando…");
  for (const room of [...rooms.values()]) destroyRoom(room);
  for (const room of [...padRooms.values()]) destroyPadRoom(room, metaOf);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
