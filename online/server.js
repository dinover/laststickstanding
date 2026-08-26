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
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createSim } = require("./sim-host");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");

const MAX_PLAYERS = 8; // ya NO es PLAYER_COLORS.length: la paleta la supera a propósito (ver abajo)
const TICK_MS = 16; // ~60 Hz de simulación (menos que esto y los jugadores atraviesan plataformas)

/* 33 ms (~30 Hz), no 40. Dos razones, las dos medidas contra el server real:

   1. El tick real dura ~16,6 ms, así que un umbral de 40 recién se cruzaba al TERCER tick:
      los snapshots salían cada ~50 ms (20 Hz medidos), no cada 40. Con 33 el umbral cae
      justo en el segundo tick (16,6 x 2 = 33,2), o sea una cadencia clavada y sin deriva.
   2. Emitir más seguido recorta la espera promedio del jugador por su propio input: pasa de
      ~25 ms a ~16 ms. Es latencia que se elimina sin predecir nada del lado del cliente. */
const BROADCAST_MS = 33;
const MAX_DT = 40; // mismo clamp que hostLoop en desktop/game.html
const ROOM_CODE_LEN = 4;
const MAX_MSG_BYTES = 4096;
const MAX_MSG_PER_SEC = 200; // un cliente normal manda ~20/s; esto solo frena un flood
const EMPTY_ROOM_GRACE_MS = 60000;

/* Cuánto se le guarda el lugar a alguien que se desconectó en medio de una partida.
   Es un balance: mucho y una ronda puede quedar trabada esperando a un muñeco quieto que
   nadie mata; poco y no llegás a recargar la página. 30 s alcanza para un F5 o para que el
   wifi se recupere, y como el ausente no se defiende, en la práctica lo matan mucho antes. */
const REJOIN_GRACE_MS = 30000;

/* Mismo alfabeto que net.js: sin 0/O/1/I, para poder dictar el código en voz alta. */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* Misma paleta que PLAYER_COLORS en online/public/index.html. Duplicada acá a propósito: el
   color que elige cada jugador es cosmético, pero se valida server-side como cualquier otro
   input — no hay que confiar en que el cliente mande un hex válido ni en que respete el "no
   repetido" por su cuenta.

   Los primeros 8 son los originales y en ese orden a propósito: colorFor() del cliente cae en
   PLAYER_COLORS[id % length] cuando todavía no llegó el "lobby", así que mover uno de esos ocho
   le cambiaría el color de arranque a los slots. Los 6 de la segunda línea se eligieron por el
   hueco de tono que llenan (rojo, amarillo, menta, azul, violeta y blanco caen justo en los
   claros que dejaba la paleta vieja), no por gusto: con 8 jugadores en pantalla el color ES el
   nombre, y dos tonos parecidos arruinan la partida más que la falta de variedad. Que sobren
   colores sobre MAX_PLAYERS es la gracia — ahora elegir el tuyo casi nunca choca con otro. */
const PLAYER_COLORS = [
  "#35f0e0", "#ff2e88", "#9dff4f", "#ffc247", "#7b6cff", "#4fd2ff", "#ff7a3d", "#ff5ec4",
  "#ff3d3d", "#f2ff3d", "#2eff9d", "#4f7dff", "#d24fff", "#eef2ff",
];

/* Accesorios cosméticos de la cabeza. Espejo exacto de ACCESSORY_IDS en stickman.js (que es
   quien los dibuja): si acá falta uno, el servidor lo baja a "none" y el resto de la sala
   nunca lo ve, aunque el cliente que lo eligió se lo dibuje a sí mismo. */
const ACCESSORY_IDS = ["none", "horns", "halo", "tophat", "cap", "crown", "poop", "cowboy",
                       "party", "bunny", "antennae", "arrow", "mohawk", "flame", "propeller"];

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
  "/balance.js": ["balance.js", "text/javascript; charset=utf-8"],
  // Favicon + imagen de preview al compartir el link (WhatsApp/Twitter/Discord leen esto vía
  // las meta og:image de public/index.html, no adivinan una captura sola).
  "/favicon.png": ["../LSS icon.png", "image/png"],
  "/og-image.png": ["../Last Stick Standing.png", "image/png"],
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

/* "rounds" reproduce el único modo que existía: el anfitrión elige cuántas rondas. "infinite"
   se juega ronda a ronda sin límite, con el puntaje acumulando desde la ronda 1; cada 5 rondas
   vuelve al mapa inicial (ver nextRound() en desktop/sim.js). "wins" también se juega sin tope
   de rondas, pero corta sola apenas alguien GANA la cantidad de rondas que el anfitrión eligió
   (reusa el mismo campo room.rounds que "rounds", solo que ahí es un objetivo de victorias, no
   una cantidad fija — ver el comentario de startMatch() en desktop/sim.js). "koth" es Rey de la
   Colina: una sola ronda sin eliminación, la gana quien llegue primero a 100 puntos de círculo
   (ver updateHill() en desktop/sim.js). "orbking" es Rey del Orbe: partida a reloj de 2 minutos,
   también sin eliminación, gana quien más tiempo sostuvo un power activo (ver updateOrbHold()).
   "Historia" (modo contra IA) todavía no existe — el cliente ni lo ofrece — así que cualquier
   valor que no sea "infinite"/"wins"/"koth"/"orbking" cae en "rounds" por default, no solo por
   si alguien manda basura sino porque es el modo que ya estaba andando en producción. */
function normalizeMode(raw) {
  if (raw === "infinite") return "infinite";
  if (raw === "wins") return "wins";
  if (raw === "koth") return "koth";
  if (raw === "orbking") return "orbking";
  return "rounds";
}

/* mode/rounds son solo el valor INICIAL de la sala: desde que existe el mensaje "setMode", el
   anfitrión los cambia dentro del lobby, con gente ya conectada. El cliente propio ya no manda
   ninguno de los dos al crear (cae en "rounds" / 3), pero el parámetro se mantiene para que un
   cliente viejo cacheado que todavía los mande siga funcionando igual. */
function createRoom(mode, rounds) {
  const code = freeCode();
  if (!code) return null;

  const room = {
    code,
    players: new Map(), // id -> { id, name, ws, alive: bool (conectado) }
    ownerId: null,
    host: null, // { sim, takeSfx }
    mode: normalizeMode(mode),
    rounds: Math.max(1, Math.min(20, Number(rounds) || 3)), // solo se usa si mode === "rounds" | "wins"
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
       el mundo.

       totalRounds llega en Infinity cuando el modo es infinito. JSON.stringify ya lo
       convierte solo a null (Infinity no es representable en JSON), pero eso queda implícito
       y frágil si algún día cambia el serializador — se hace explícito acá. */
    /* stats: patadas/piñas tiradas, caídas, golpes dados/recibidos — acumulado desde el
       inicio de la partida (ver matchStats en desktop/sim.js). Va acá y no en cada snapshot
       (que sale ~30 veces por segundo) porque solo se usa una vez por ronda, en el reveal del
       modo infinito; mandarlo a cada tick sería puro desperdicio de ancho de banda. Se manda
       igual en modo "rounds" — es chico y así no hace falta una rama especial — pero el
       cliente solo lo usa cuando infinite es true. */
    broadcast(room, {
      t: "round",
      round: evt.round,
      totalRounds: Number.isFinite(evt.totalRounds) ? evt.totalRounds : null,
      mapName: evt.mapName,
      infinite: !!evt.infinite,
      mode: room.mode, // "rounds" | "infinite" | "wins" | "koth" | "orbking" — el cliente lo usa para el texto del cartel
      // room.rounds: en "rounds" es la cantidad total, en "wins" el objetivo de victorias — acá
      // no se puede derivar de totalRounds (Infinity/null en ambos "infinite" y "wins").
      rounds: room.rounds,
      stats: room.host.sim.getMatchStats(),
    });
  }
  /* No hace falta reaccionar acá a evt.t === "final": el próximo snapshot (a lo sumo 33 ms
     después) ya trae phase:"final", que es lo que el cliente mira para mostrar la pantalla de
     resultados — tanto si la partida terminó sola (modo rounds) como si el anfitrión la cortó
     a mano (forceEndMatch, modo infinito). */
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
  /* Restar en vez de asignar 0: el acumulador siempre cruza el umbral con sobrante (los ticks
     no caen exactos), y descartarlo hacía que cada broadcast llegara tarde y el error se
     acumulara ronda tras ronda. Restando, el sobrante se arrastra al próximo y la frecuencia
     promedio es la real. El módulo evita que un freeze del proceso dispare una ráfaga de
     broadcasts para ponerse al día. */
  room.accum = Math.min(room.accum - BROADCAST_MS, BROADCAST_MS);

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
    if (!p.ws || p.ws.readyState !== 1) continue; // ausente esperando reconexión
    /* Un cliente con la conexión saturada no puede frenar a los demás: si ya tiene más de un
       segundo de snapshots encolados, se le saltea este frame. Encolar más solo aumentaría la
       memoria del servidor para después entregarle un estado viejo que igual va a descartar. */
    if (p.ws.bufferedAmount > payload.length * 30) continue;
    p.ws.send(payload);
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
  if (snap.hill) snap.hill = { x: r(snap.hill.x, 1), y: r(snap.hill.y, 1), r: snap.hill.r };
  if (typeof snap.orbkingTimer === "number") snap.orbkingTimer = Math.round(snap.orbkingTimer);

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
    if (p.ws && p.ws.readyState === 1) p.ws.send(payload);
  }
}

function lobbyState(room) {
  return {
    t: "lobby",
    code: room.code,
    owner: room.ownerId,
    phase: room.host.sim.getPhase(),
    mode: room.mode,
    rounds: room.rounds, // solo tiene sentido si mode === "rounds"; el cliente lo ignora si no
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      hat: p.hat,
      connected: p.connected,
    })),
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

/* Devuelve el color de PLAYER_COLORS que matchea (case-insensitive), o null si no está en la
   paleta — cubre tanto "no eligió ninguno" (undefined/vacío) como cualquier otra cosa. */
function cleanColor(raw) {
  const c = String(raw == null ? "" : raw).trim().toLowerCase();
  const i = PLAYER_COLORS.indexOf(c);
  return i === -1 ? null : PLAYER_COLORS[i];
}

/* Colores ya tomados en la sala. Se cuentan TODOS los jugadores presentes, no solo los
   conectados: si se excluyera a los "ausentes" (ver REJOIN_GRACE_MS), alguien podría reclamar
   el color de otro que se cayó del wifi y va a volver en cualquier momento, y quedarían dos
   jugadores con el mismo color a la vez apenas reconecte. */
/* A diferencia del color, el accesorio NO es exclusivo: dos jugadores con la misma galera se
   siguen distinguiendo por el color del cuerpo, que es el identificador de verdad. */
function cleanHat(raw) {
  const h = String(raw == null ? "" : raw).trim().toLowerCase();
  return ACCESSORY_IDS.indexOf(h) === -1 ? "none" : h;
}

function usedColors(room) {
  const used = {};
  for (const p of room.players.values()) if (p.color) used[p.color] = true;
  return used;
}

/* Si pidió un color válido y libre, ese. Si no (no eligió, pidió uno inválido, o ya lo tiene
   otro jugador de la sala), uno al azar entre los que queden libres. */
function pickColor(room, wantedRaw) {
  const wanted = cleanColor(wantedRaw);
  const used = usedColors(room);
  if (wanted && !used[wanted]) return wanted;
  const free = PLAYER_COLORS.filter((c) => !used[c]);
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]; // no debería pasar: MAX_PLAYERS === PLAYER_COLORS.length
}

/* Cada error viaja con un `code` estable ADEMÁS del texto: el cliente traduce por code (ver
   SERVER_ERR_KEYS en online/public/index.html) y usa el `msg` solo de fallback. El texto se
   mantiene en castellano acá a propósito — es lo que ve un cliente viejo todavía cacheado. */
function joinRoom(room, ws, nick, colorRaw, hatRaw) {
  if (room.host.sim.getPhase() !== "lobby") return { err: "Esa partida ya empezó.", code: "started" };
  const id = freeSlot(room);
  if (id === null) return { err: "La sala está llena (8 jugadores).", code: "full" };

  /* Token de reconexión: identifica a ESTE jugador si se le corta la conexión. Va al cliente
     una sola vez y él lo guarda; no viaja en ningún otro mensaje. Sin esto, cualquiera que
     conociera el código de sala podría robarle el lugar a otro en mitad de una partida. */
  const player = {
    id,
    name: cleanNick(nick),
    color: pickColor(room, colorRaw),
    hat: cleanHat(hatRaw),
    ws,
    connected: true,
    token: crypto.randomUUID(),
    goneSince: null,
  };
  room.players.set(id, player);
  room.host.sim.addPlayer(id);
  if (room.ownerId === null) room.ownerId = id;
  room.emptySince = null;

  ws._room = room;
  ws._playerId = id;

  send(ws, { t: "joined", code: room.code, id, owner: room.ownerId, token: player.token });
  pushLobby(room);
  return { id };
}

/* Reconexión. Devuelve al jugador a SU mismo slot, con su puntaje y su lugar en el roster.
   Se permite incluso si el socket viejo todavía figura abierto: cuando a alguien se le corta
   el wifi, el servidor puede tardar hasta un ciclo de heartbeat en darse cuenta, y hasta
   entonces el jugador ya está golpeando F5. Quien presenta el token es el dueño legítimo, así
   que se echa al socket viejo. */
function rejoinRoom(room, ws, token) {
  let player = null;
  for (const p of room.players.values()) {
    if (p.token && token && p.token === token) { player = p; break; }
  }
  if (!player) return { err: "Esa partida ya no te tiene registrado.", code: "notRegistered" };

  const old = player.ws;
  if (old && old !== ws) {
    old._room = null;
    old._playerId = null;
    try { old.terminate(); } catch (e) { /* ya estaba muerto */ }
  }

  player.ws = ws;
  player.connected = true;
  player.goneSince = null;
  ws._room = room;
  ws._playerId = player.id;

  /* Que vuelva sin teclas trabadas: si se desconectó con "derecha" apretada, el servidor nunca
     recibió el keyup y el muñeco seguiría empujando solo. */
  clearInputs(room, player.id);

  send(ws, {
    t: "joined",
    code: room.code,
    id: player.id,
    owner: room.ownerId,
    token: player.token,
    resumed: true,
  });
  /* El mapa no viaja en cada snapshot (solo cuando cambia), así que el que vuelve se perdió
     el único que lo traía: forzamos que el próximo lo incluya. */
  room.lastMapKey = null;
  pushLobby(room);
  return { id: player.id };
}

function clearInputs(room, id) {
  const p = room.host.sim.getPlayers()[id];
  if (!p) return;
  p.input.left = false;
  p.input.right = false;
  p.jumpEdge = false;
  p.punchEdge = false;
  p.kickEdge = false;
}

function leaveRoom(ws) {
  const room = ws._room;
  if (!room || !rooms.has(room.code)) return;
  const id = ws._playerId;
  const player = room.players.get(id);
  if (!player || player.ws !== ws) return;

  if (room.host.sim.getPhase() === "lobby") {
    /* En el lobby no hay nada que preservar: si vuelve, entra como jugador nuevo. */
    room.players.delete(id);
    room.host.sim.removePlayer(id);
  } else {
    /* En partida NO se libera el slot todavía. El jugador queda "ausente" con su puntaje y su
       lugar en el roster durante REJOIN_GRACE_MS. Su muñeco se queda quieto (y por lo tanto
       es carne de cañón), pero si vuelve a tiempo retoma exactamente donde estaba. */
    player.connected = false;
    player.goneSince = Date.now();
    player.ws = null;
    clearInputs(room, id);
  }

  if (room.ownerId === id) reassignOwner(room);

  if (connectedCount(room) === 0) {
    room.emptySince = Date.now();
    stopLoop(room);
  } else {
    pushLobby(room);
  }
}

function connectedCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.connected) n++;
  return n;
}

/* El dueño de la sala tiene que ser alguien que esté efectivamente conectado, si no el botón
   de "empezar" queda en manos de un ausente y nadie puede arrancar la partida. */
function reassignOwner(room) {
  room.ownerId = null;
  for (const p of room.players.values()) {
    if (p.connected) { room.ownerId = p.id; break; }
  }
}

/* Barrido de ausentes: al vencer la gracia, el slot se libera de verdad. */
function sweepAbsent(room) {
  const now = Date.now();
  let changed = false;
  for (const p of [...room.players.values()]) {
    if (p.connected || !p.goneSince) continue;
    if (now - p.goneSince < REJOIN_GRACE_MS) continue;
    room.players.delete(p.id);
    if (room.host.sim.getPhase() === "lobby") room.host.sim.removePlayer(p.id);
    else dropBody(room, p.id); // ver el comentario de dropBody
    if (room.ownerId === p.id) reassignOwner(room);
    changed = true;
  }
  if (changed) pushLobby(room);
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!msg || typeof msg.t !== "string") return;

  /* --- medición de latencia, disponible en cualquier momento (lobby, sala, partida) ---
     Eco puro: el cliente manda su propio timestamp y nosotros se lo devolvemos intacto, así
     el RTT lo calcula él mismo (Date.now() acá vs. en el cliente pueden no estar sincronizados,
     pero no hace falta — solo importa el delta de ida y vuelta del lado del cliente). */
  if (msg.t === "ping") {
    send(ws, { t: "pong", ts: msg.ts });
    return;
  }

  /* --- fuera de sala --- */
  if (msg.t === "create") {
    if (ws._room) return;
    /* Crear la sala ya no decide NADA de la partida: nace en "rounds"/3 y el anfitrión elige
       modo y cantidad adentro del lobby (setMode/setRounds) mientras se van sumando los demás.
       Antes el modo se fijaba acá y era inmutable, así que para cambiarlo había que rehacer la
       sala y repartir un código nuevo — justo lo contrario de "entren que ya arreglamos". */
    const room = createRoom(msg.mode, msg.rounds);
    if (!room) return send(ws, { t: "err", msg: "No hay códigos de sala libres, probá de nuevo.", code: "noCodes" });
    const res = joinRoom(room, ws, msg.nick, msg.color, msg.hat);
    if (res.err) {
      destroyRoom(room);
      send(ws, { t: "err", msg: res.err, code: res.code });
    }
    return;
  }

  if (msg.t === "rejoin") {
    if (ws._room) return;
    const code = String(msg.code || "").toUpperCase().trim();
    const room = rooms.get(code);
    /* Los fallos de rejoin no son un error para el usuario: significan "esa partida ya no
       existe / ya te soltó", y el cliente reacciona volviendo al lobby por su cuenta. */
    if (!room) return send(ws, { t: "rejoinFailed" });
    const res = rejoinRoom(room, ws, String(msg.token || ""));
    if (res.err) send(ws, { t: "rejoinFailed" });
    return;
  }

  if (msg.t === "join") {
    if (ws._room) return;
    const code = String(msg.code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return send(ws, { t: "err", msg: "No existe una sala con ese código.", code: "noRoom" });
    const res = joinRoom(room, ws, msg.nick, msg.color, msg.hat);
    if (res.err) send(ws, { t: "err", msg: res.err, code: res.code });
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

  if (msg.t === "setMode") {
    /* El modo de la sala ahora se elige acá adentro, no al crearla. Solo el anfitrión y solo
       en el lobby: una vez que arrancó la partida, room.mode ya viajó a startMatch() y lo
       usan tanto la simulación como el cartel de cada ronda, así que cambiarlo a mitad de
       camino dejaría el cliente mostrando un modo y el servidor corriendo otro.
       normalizeMode() cubre cualquier valor raro cayendo en "rounds", igual que al crear. */
    if (room.ownerId !== id) return;
    if (room.host.sim.getPhase() !== "lobby") return;
    const next = normalizeMode(msg.mode);
    if (next === room.mode) return;
    room.mode = next;
    pushLobby(room); // todos ven el cambio en vivo, no solo el que lo tocó
    return;
  }

  if (msg.t === "setRounds") {
    /* Corregido: originalmente "rounds" se fijaba solo al crear la sala. El anfitrión tiene
       que poder seguir ajustándolo mientras espera a que se sumen amigos — capaz crea la sala
       para 3 y termina siendo para 6. Solo tiene efecto en el lobby: una vez que la partida
       arrancó, room.rounds queda congelado en lo que ya se usó para startMatch(). No aplica a
       "infinite" (ahí no hay cantidad de rondas que fijar) — "wins" sí, aunque ahí el mismo
       número signifique "victorias para ganar" en vez de "rondas totales". */
    if (room.ownerId !== id) return;
    if (room.mode !== "rounds" && room.mode !== "wins") return;
    if (room.host.sim.getPhase() !== "lobby") return;
    room.rounds = Math.max(1, Math.min(20, Number(msg.rounds) || room.rounds));
    pushLobby(room); // así todos ven el número actualizado en el resumen del lobby, no solo el anfitrión
    return;
  }

  if (msg.t === "start") {
    if (room.ownerId !== id) return;
    if (room.host.sim.getPhase() !== "lobby") return;
    room.lastMapKey = null; // fuerza que el primer snapshot lleve el mapa entero
    // room.mode/room.rounds ya están fijados (room.rounds puede haber cambiado via setRounds).
    /* El segundo parámetro es el "modo caracol" de desktop/sim.js (menos partículas y sombras
       para máquinas lentas). El cliente web ya no lo ofrece: la simulación corre acá, no en la
       PC del jugador, así que apagar efectos del lado del servidor no le ahorraba nada a nadie.
       El parámetro sigue en sim.js porque el build de escritorio sí lo usa. */
    room.host.sim.startMatch(room.rounds, false, { mode: room.mode });
    broadcast(room, { t: "started" });
    startLoop(room);
    return;
  }

  if (msg.t === "endMatch") {
    /* Corte manual, exclusivo del modo infinito: ahí ninguna ronda dispara el final sola. El
       cliente solo ofrece este botón en ese modo, pero igual se valida acá — nada le impide a
       alguien mandar el mensaje a mano. En "rounds" no pasa nada raro si se admitiera (la
       partida terminaría antes con el puntaje ya acumulado), pero no hay ningún caso de uso
       real para eso y admitirlo sin querer sería confuso, así que se lo restringe a infinito. */
    if (room.ownerId !== id) return;
    if (room.mode !== "infinite") return;
    room.host.sim.forceEndMatch();
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

  if (msg.t === "leave") {
    /* Salida voluntaria del lobby ("‹ volver" ya con la sala creada). Reusa exactamente la
       misma leaveRoom() que dispara un corte de conexión — libera el slot si estaba en lobby,
       o lo deja "ausente" con gracia si por algún motivo se llama mid-partida (no debería pasar
       desde la UI, que solo ofrece este botón en el lobby, pero no cuesta nada que el camino
       sea seguro igual). A diferencia de un cierre de socket real, ACÁ el socket sigue vivo —
       hay que limpiar ws._room/_playerId a mano para que el mismo socket pueda crear o unirse
       a otra sala después sin necesidad de recargar la página. */
    leaveRoom(ws);
    ws._room = null;
    ws._playerId = null;
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
   deja el socket abierto para siempre desde el lado del servidor, y su muñeco sigue parado en
   la ronda recibiendo golpes. El ping/pong lo detecta.

   10 s y no 30: hacen falta DOS ciclos para dar a alguien por muerto (uno para mandar el ping,
   otro para constatar que no volvió), así que 30 s significaban hasta un minuto de fantasma
   en la ronda. Con 10 s el peor caso baja a ~20 s, y recién ahí empieza a correr la gracia de
   reconexión. El costo son 8 frames de ping cada 10 s: nada. */
const HEARTBEAT_MS = 10000;
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

/* Barrido periódico: libera los slots de los ausentes cuya gracia venció y destruye las salas
   que quedaron sin nadie. La sala se destruye con demora para que quien recarga la página por
   accidente pueda volver a entrar con el mismo código.
   Corre seguido (2 s) porque de esto depende que una ronda no quede trabada esperando a un
   jugador que ya no va a volver. */
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    sweepAbsent(room);
    if (connectedCount(room) === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
      destroyRoom(room);
    }
  }
}, 2000);

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
