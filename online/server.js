/* Servidor autoritativo de Last Stick Standing.
   Reemplaza la topología P2P (un jugador hostea, tiene 0 ms y los otros pagan RTT) por una
   estrella con el servidor al centro: todos los clientes son "guests", nadie tiene ventaja,
   y la partida sobrevive si el que la creó se va.

   Efectos secundarios del cambio, todos buenos:
   - No hace falta el broker público de PeerJS (era el punto de falla más probable cuando 8
     personas se conectan a la vez).
   - No hace falta TURN ni NAT traversal: cada cliente abre una conexión saliente al 443.
   - Un solo JSON.stringify por tick para los 8 clientes, en vez de una serialización por
     destinatario como hacía NetHost.broadcast. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { createSim } = require("./sim-host");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");

const MAX_PLAYERS = 8; // = PLAYER_COLORS.length en el cliente
const TICK_MS = 16; // ~60 Hz de simulación (menos que esto y los jugadores atraviesan plataformas)
const BROADCAST_MS = 40; // ~25 Hz de red, igual que el build P2P
const MAX_DT = 40; // mismo clamp que hostLoop en desktop/game.html
const ROOM_CODE_LEN = 4;
const MAX_MSG_BYTES = 4096;
const MAX_MSG_PER_SEC = 200; // un cliente normal manda ~20/s; esto solo frena un flood
const EMPTY_ROOM_GRACE_MS = 60000;

/* Mismo alfabeto que net.js: sin 0/O/1/I, para poder dictar el código en voz alta. */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ------------------------------------------------------------------ archivos estáticos */
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/index.html": ["public/index.html", "text/html; charset=utf-8"],
  "/net-ws.js": ["public/net-ws.js", "text/javascript; charset=utf-8"],
  "/stickman.js": ["../stickman.js", "text/javascript; charset=utf-8"],
  "/fx.js": ["../fx.js", "text/javascript; charset=utf-8"],
  "/world.js": ["../world.js", "text/javascript; charset=utf-8"],
  "/audio.js": ["../audio.js", "text/javascript; charset=utf-8"],
  "/sim.js": ["../desktop/sim.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: countPlayers() }));
    return;
  }

  const entry = STATIC[url];
  if (!entry) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  fs.readFile(path.join(__dirname, entry[0]), (err, buf) => {
    if (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("500");
      return;
    }
    res.writeHead(200, { "content-type": entry[1], "cache-control": "no-cache" });
    res.end(buf);
  });
});

/* ------------------------------------------------------------------ salas */
/** @type {Map<string, Room>} */
const rooms = new Map();

function countPlayers() {
  let n = 0;
  for (const room of rooms.values()) n += room.players.size;
  return n;
}

function randomCode() {
  let s = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function freeCode() {
  for (let i = 0; i < 50; i++) {
    const c = randomCode();
    if (!rooms.has(c)) return c;
  }
  return null;
}

function createRoom() {
  const code = freeCode();
  if (!code) return null;

  const room = {
    code,
    players: new Map(), // id -> { id, name, ws, alive: bool (conectado) }
    ownerId: null,
    host: null, // { sim, takeSfx }
    timer: null,
    last: 0,
    accum: 0,
    lastMapKey: null,
    emptySince: Date.now(),
  };

  room.host = createSim((evt) => onPhaseChange(room, evt));
  rooms.set(code, room);
  return room;
}

function destroyRoom(room) {
  stopLoop(room);
  rooms.delete(room.code);
}

/* Saca de la ronda el cuerpo de un jugador que ya no está conectado.
   No se puede usar Sim.removePlayer() en mitad de una partida: sim.js decide el fin de ronda
   contando vivos DENTRO de eliminate(), así que borrar a un jugador vivo sin pasar por ahí
   deja la ronda colgada (queda 1 vivo y nada dispara checkRoundEnd). Tirándolo fuera del mapa
   se elimina por el camino normal de stepPlayer (y > H + 60), que sí cierra la ronda y respeta
   el orden de eliminación para el puntaje.
   getPlayers() devuelve los objetos vivos de la simulación, no una copia. */
function dropBody(room, id) {
  const p = room.host.sim.getPlayers()[id];
  if (p && p.alive) {
    p.y = 100000;
    p.vy = 1;
  }
}

/* spawnRoundPlayers() revive a TODO el roster al empezar cada ronda, incluidos los que se
   fueron: la ronda siguiente arrancaba con un fantasma parado que nadie controla y que nadie
   puede matar, o sea una ronda que no termina nunca. Se los vuelve a bajar en cada roundStart.
   Durante fightIntro damageEnabled es false, así que caen y recién se eliminan cuando empieza
   el fight — exactamente igual que si se hubieran desconectado en ese momento. */
function dropGhosts(room) {
  for (const id of room.host.sim.getRoster()) {
    if (!room.players.has(id)) dropBody(room, id);
  }
}

function onPhaseChange(room, evt) {
  if (evt.t === "roundStart") {
    dropGhosts(room);
    /* En el build P2P solo el host veía el cartel de ronda y la animación FIGHT!, porque
       salían de este callback y los guests no corrían la simulación. Ahora lo recibe todo
       el mundo. */
    broadcast(room, {
      t: "round",
      round: evt.round,
      totalRounds: evt.totalRounds,
      mapName: evt.mapName,
    });
  }
}

/* ------------------------------------------------------------------ loop de simulación */
function startLoop(room) {
  if (room.timer) return;
  room.last = performance.now();
  room.accum = 0;
  room.timer = setInterval(() => tick(room), TICK_MS);
}

function stopLoop(room) {
  if (!room.timer) return;
  clearInterval(room.timer);
  room.timer = null;
}

function tick(room) {
  const now = performance.now();
  const dt = Math.min(MAX_DT, now - room.last);
  room.last = now;

  room.host.sim.step(dt);

  room.accum += dt;
  if (room.accum < BROADCAST_MS) return;
  room.accum = 0;

  const snap = compressSnapshot(room.host.sim.snapshot(), room);
  snap.t = "snap";
  const sfx = room.host.takeSfx();
  if (sfx) snap.sfx = sfx;

  /* yourId NO va acá. El build P2P lo estampaba por destinatario dentro del loop de envío,
     lo que obligaba a re-serializar el estado completo una vez por jugador. Como el id de
     cada cliente no cambia nunca, se lo mandamos una sola vez al entrar ("joined") y acá
     serializamos un único string para los 8. */
  const payload = JSON.stringify(snap);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(payload);
  }

  /* La partida terminó: paramos de simular hasta que alguien pida revancha. */
  if (room.host.sim.getPhase() === "final") stopLoop(room);
}

/* ------------------------------------------------------------------ compresión de snapshot */
function r(v, decimals) {
  if (typeof v !== "number") return v;
  const m = Math.pow(10, decimals);
  return Math.round(v * m) / m;
}

/* Sim.snapshot() sale con floats de doble precisión ("x":299.34149729142337) y reenvía el
   mapa completo en cada tick aunque no cambie en toda la ronda. Entre las dos cosas se iba
   el 95% del payload. Esto lo recorta antes de serializar, sin tocar sim.js.

   OJO: snapshot() devuelve por REFERENCIA los objetos vivos de la simulación en `orb`,
   `power`, `scores` y `roster` (solo `players[id]` es un literal nuevo por llamada). Redondear
   sobre esas referencias corrompería el estado autoritativo — de ahí las copias. */
function compressSnapshot(snap, room) {
  for (const id in snap.players) {
    const p = snap.players[id];
    p.x = r(p.x, 1); // sub-píxel en un canvas de 960x540 y encima el cliente interpola
    p.y = r(p.y, 1);
    p.vx = r(p.vx, 2);
    p.vy = r(p.vy, 2);
    p.walkCycle = r(p.walkCycle, 3);
    p.idleT = r(p.idleT, 2);
    p.squash = r(p.squash, 3);
    p.hitStunT = Math.round(p.hitStunT);
    p.jumpAnticT = Math.round(p.jumpAnticT);
    p.deathFadeT = Math.round(p.deathFadeT);
    p.burnFlashT = Math.round(p.burnFlashT);
    p.slowT = Math.round(p.slowT);
    if (p.attack) p.attack = { type: p.attack.type, t: Math.round(p.attack.t), dur: p.attack.dur };
    if (p.power) p.power = { type: p.power.type, t: Math.round(p.power.t) };
  }

  if (snap.orb) snap.orb = { type: snap.orb.type, x: r(snap.orb.x, 1), y: r(snap.orb.y, 1), bornT: Math.round(snap.orb.bornT) };

  /* El mapa solo cambia al empezar una ronda. Se manda entero cuando cambia y se omite el
     resto del tiempo; el cliente se queda con el último que recibió. */
  const key = snap.map ? snap.map.name + ":" + snap.map.seed : null;
  if (key && key === room.lastMapKey) delete snap.map;
  else room.lastMapKey = key;

  return snap;
}

/* ------------------------------------------------------------------ mensajería */
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const payload = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(payload);
  }
}

function lobbyState(room) {
  return {
    t: "lobby",
    code: room.code,
    owner: room.ownerId,
    phase: room.host.sim.getPhase(),
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name })),
  };
}

function pushLobby(room) {
  broadcast(room, lobbyState(room));
}

function freeSlot(room) {
  for (let id = 0; id < MAX_PLAYERS; id++) if (!room.players.has(id)) return id;
  return null;
}

function cleanNick(raw) {
  const s = String(raw == null ? "" : raw).replace(/[\u0000-\u001f<>]/g, "").trim();
  return s.slice(0, 14) || "Jugador";
}

function joinRoom(room, ws, nick) {
  if (room.host.sim.getPhase() !== "lobby") return { err: "Esa partida ya empezó." };
  const id = freeSlot(room);
  if (id === null) return { err: "La sala está llena (8 jugadores)." };

  const player = { id, name: cleanNick(nick), ws, connected: true };
  room.players.set(id, player);
  room.host.sim.addPlayer(id);
  if (room.ownerId === null) room.ownerId = id;
  room.emptySince = null;

  ws._room = room;
  ws._playerId = id;

  send(ws, { t: "joined", code: room.code, id, owner: room.ownerId });
  pushLobby(room);
  return { id };
}

function leaveRoom(ws) {
  const room = ws._room;
  if (!room || !rooms.has(room.code)) return;
  const id = ws._playerId;
  const player = room.players.get(id);
  if (!player || player.ws !== ws) return;

  room.players.delete(id);

  if (room.host.sim.getPhase() === "lobby") {
    room.host.sim.removePlayer(id);
  } else {
    dropBody(room, id); // ver el comentario de dropBody
  }

  if (room.ownerId === id) {
    const next = room.players.keys().next();
    room.ownerId = next.done ? null : next.value;
  }

  if (room.players.size === 0) {
    room.emptySince = Date.now();
    stopLoop(room);
  } else {
    pushLobby(room);
  }
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!msg || typeof msg.t !== "string") return;

  /* --- fuera de sala --- */
  if (msg.t === "create") {
    if (ws._room) return;
    const room = createRoom();
    if (!room) return send(ws, { t: "err", msg: "No hay códigos de sala libres, probá de nuevo." });
    const res = joinRoom(room, ws, msg.nick);
    if (res.err) {
      destroyRoom(room);
      send(ws, { t: "err", msg: res.err });
    }
    return;
  }

  if (msg.t === "join") {
    if (ws._room) return;
    const code = String(msg.code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return send(ws, { t: "err", msg: "No existe una sala con ese código." });
    const res = joinRoom(room, ws, msg.nick);
    if (res.err) send(ws, { t: "err", msg: res.err });
    return;
  }

  /* --- dentro de sala --- */
  const room = ws._room;
  if (!room || !rooms.has(room.code)) return;
  const id = ws._playerId;
  const player = room.players.get(id);
  if (!player || player.ws !== ws) return;

  if (msg.t === "input") {
    room.host.sim.handleInput(id, msg.k, !!msg.d);
    return;
  }

  if (msg.t === "start") {
    if (room.ownerId !== id) return;
    if (room.host.sim.getPhase() !== "lobby") return;
    const rounds = Math.max(1, Math.min(20, Number(msg.rounds) || 3));
    room.lastMapKey = null; // fuerza que el primer snapshot lleve el mapa entero
    room.host.sim.startMatch(rounds, !!msg.snail);
    broadcast(room, { t: "started" });
    startLoop(room);
    return;
  }

  if (msg.t === "again") {
    if (room.ownerId !== id) return;
    stopLoop(room);
    room.lastMapKey = null;
    room.host.sim.resetToLobby();
    /* resetToLobby() vacía players/roster; hay que volver a dar de alta a los conectados. */
    for (const p of room.players.values()) room.host.sim.addPlayer(p.id);
    broadcast(room, { t: "toLobby" });
    pushLobby(room);
    return;
  }
}

/* ------------------------------------------------------------------ WebSocket */
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws) => {
  ws._room = null;
  ws._playerId = null;
  ws._msgCount = 0;
  ws._msgWindow = Date.now();
  ws._alive = true;

  ws.on("pong", () => {
    ws._alive = true;
  });

  ws.on("message", (data) => {
    const now = Date.now();
    if (now - ws._msgWindow > 1000) {
      ws._msgWindow = now;
      ws._msgCount = 0;
    }
    if (++ws._msgCount > MAX_MSG_PER_SEC) return; // flood: descartamos en silencio
    handleMessage(ws, data.toString());
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

/* Un cliente que se va sin cerrar limpio (se le corta el wifi, cierra la tapa del notebook)
   deja el socket abierto para siempre desde el lado del servidor, ocupando un slot de los 8
   y, peor, un lugar en el roster de una partida en curso. El ping/pong lo detecta. */
const HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) {
      ws.terminate();
      continue;
    }
    ws._alive = false;
    try {
      ws.ping();
    } catch (e) {
      /* el close handler se encarga */
    }
  }
}, HEARTBEAT_MS);

/* Salas vacías: se destruyen con gracia para que quien recarga la página por accidente pueda
   volver a entrar con el mismo código. */
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
      destroyRoom(room);
    }
  }
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("Last Stick Standing online — escuchando en :" + PORT);
});

function shutdown() {
  console.log("cerrando…");
  for (const room of [...rooms.values()]) destroyRoom(room);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
