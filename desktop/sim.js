/* Host-authoritative simulation for the desktop/PeerJS build of Last Stick Standing.
   This is a fresh port of screen.html's V2 gameplay (rounds, procedural maps, punch/kick,
   power orbs, snail mode) into a transport-agnostic module: no ac.* / FreeConsole calls
   anywhere. The host (see game.html) drives Sim directly every frame; guests only ever call
   Sim.guestApplySnapshot()/guestFrame() with whatever snapshot net.js last delivered.

   Deliberately NOT shared with screen.html — screen.html keeps working untouched. This is a
   parallel copy (identical to ../steam/sim.js) so the FreeConsole build can never be affected
   by anything here, and this build has no dependency on the Steam one either.

   Depends on the same globals screen.html already relies on: World, Particles, Camera,
   HitStop, ScreenFX, Trails, POWER_COLORS, drawStickman (stickman.js), AudioManager
   (audio.js) — all loaded via <script> before this file in game.html. */
var Sim = (function () {
  "use strict";

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* El mundo mide 1152x648 y el canvas 960x540: son 1.2x del tamaño de siempre, dibujados con
     un zoom de 0.833 que aplica Camera.begin. La consecuencia buscada es que el muñeco NO
     creció con el mapa — mismo tamaño, mismo salto, misma velocidad — así que ahora es más
     chico en relación a la arena y cruzarla lleva un 20% más de recorrido. El 1.2 es el techo
     real, no un número redondo elegido a ojo: los layouts de world.js tienen exactamente ese
     margen antes de que algún hueco se pase del alcance de UN salto (medido sobre 400 mapas
     por archetype; a 1.25 ya aparecen mapas que el generador tiene que salir a rescatar). */
  var W = 1152, H = 648;
  var GRAVITY_UP = 0.95, GRAVITY_DOWN = 0.7, SPEED = 4.3, JUMP_V = -20.5;
  /* Doble salto: valor fijo, no una fracción de la velocidad restante del primer salto. La
     altura máxima de un salto con velocidad v es v²/(2·GRAVITY_UP) — despejando para que el
     segundo salto llegue a la MITAD de esa altura (110.6px contra 221.2px del primero) da
     JUMP_V / √2. Es una constante calculada una sola vez, no algo que varíe salto a salto. */
  var JUMP_V2 = JUMP_V / Math.SQRT2;
  /* Los saltos son un CONTADOR (p.jumpsLeft), no un flag de "ya usé el doble". La diferencia
     importa justo en el caso que rompía: caminar hasta el borde y caerse sin haber saltado.
     Con el flag viejo, el primer botón que apretabas en el aire caía en la rama del segundo
     salto y te daba el impulso corto (JUMP_V2) — el salto de recuperación quedaba a mitad de
     altura y te ibas al vacío creyendo que habías saltado bien. Ahora caerse de una plataforma
     no consume nada: los dos saltos siguen enteros y se reponen al tocar cualquier superficie. */
  var MAX_JUMPS = 2;
  var PW = 13, PH = 52;
  /* Tabla de ataques. Antes esto estaba desparramado en ternarios `type === "kick" ? a : b`
     por todo stepPlayer; juntarlo acá permite que cada build ajuste el combate por su cuenta
     via Sim.init({ attacks: {...} }) sin tocar a los demás.

     Estos valores por defecto reproducen EXACTAMENTE el comportamiento histórico (piña 230 ms
     / patada 280 ms, cooldown compartido de 380, daño 10/16, etc.), así que los builds de
     escritorio y Steam siguen jugando igual que siempre. El build web pisa lo suyo desde el
     servidor — ver online/server.js. */
  var ATTACKS = {
    punch: { dur: 230, cooldown: 380, damage: 10, reach: 34, kbX: 2.1, kbY: 0, hitStun: 180, hitStop: 35, trauma: 0.32, squash: 0.4 },
    kick:  { dur: 280, cooldown: 380, damage: 16, reach: 44, kbX: 3.2, kbY: -2, hitStun: 180, hitStop: 55, trauma: 0.5, squash: 0.55 },
  };

  var ORB_SPAWN_MS = 10000, ORB_POWER_MS = 8000, ORB_PICKUP_R = 28;
  /* Rey de la Colina: el círculo tarda HILL_APPEAR_DELAY_MS en aparecer por primera vez, queda
     activo HILL_ACTIVE_MS y al vencer salta a otra plataforma sin pausa entre medio. Cada
     milisegundo parado adentro suma hacia HILL_TARGET_MS (30 s de acumulado total, no seguido);
     HILL_TARGET_SCORE es el puntaje que da ese acumulado completo — al llegar ahí termina la
     partida. */
  var HILL_APPEAR_DELAY_MS = 5000, HILL_ACTIVE_MS = 15000, HILL_RADIUS = 114; // 95 * 1.2: la zona tiene que seguir tapando la misma fracción de plataforma que antes
  var HILL_TARGET_MS = 30000, HILL_TARGET_SCORE = 100;

  /* Rey del Orbe: partida a reloj (2 min), sin objetivo de puntos — gana quien acumuló más
     tiempo total con un power activo (p.power truthy, cualquier tipo) cuando se acaba el
     tiempo. Reusa el sistema de orbes que ya existe (spawnOrb/updateOrbs); acá solo se suma el
     tiempo sostenido. */
  var ORBKING_MATCH_MS = 120000;
  var BURN_MS = 3000, BURN_TICK_MS = 500, BURN_DMG = 2;
  var SLOW_MS = 2500, SLOW_MULT = 0.5;
  var ARMOR_MULT = 0.5;
  var AIR_SPEED_MULT = 1.35, AIR_COOLDOWN_MULT = 0.55;

  var MAP0 = {
    name: "Plataforma Inicial",
    bg: ["#0a0c18", "#141a30"],
    biome: "ruinas",
    seed: 1,
    hazards: [],
    platforms: [
      { x: 60, y: 460, w: 840, h: 26 },
      { x: 120, y: 340, w: 160, h: 18 },
      { x: 680, y: 340, w: 160, h: 18 },
      { x: 400, y: 250, w: 160, h: 18 },
    ],
  };
  /* MAP0 está escrito en coordenadas de diseño (960x540), las mismas que usan los archetypes de
     world.js, y se estira una sola vez acá al cargar el módulo. Es el mapa fijo de la ronda 1 de
     casi toda partida, así que si se quedaba en la escala vieja era EL mapa que más se juega el
     que aparecía chico y corrido, justo al lado de mapas procedurales que sí ocupan todo. */
  World.scaleFromDesign(MAP0.platforms, W, H);

  // forcedArchetype: disponible pero sin uso actual (ver World.generateMap). forcedBiome es lo
  // que Práctica Libre sí fija vía opts.biome en startMatch(), para repetir siempre el mismo
  // fondo+música sin importarle el layout de plataformas, que sigue variando normalmente.
  var forcedArchetype = null;
  var forcedBiome = null;

  function genMap(seed) {
    return World.generateMap(seed, { SPEED: SPEED, JUMP_V: JUMP_V, GRAVITY_UP: GRAVITY_UP, GRAVITY_DOWN: GRAVITY_DOWN, W: W, H: H }, forcedArchetype, forcedBiome);
  }

  var colorFor = function (id) { return "#35f0e0"; };
  var nameFor = function (id) { return "Jugador " + id; };
  /* Accesorio cosmetico por jugador (ver ACCESSORY_IDS en stickman.js). Solo lo pisa el build
     web: desktop y steam no ofrecen personalizacion todavia, asi que se quedan con "none" y
     drawStickman ni entra a dibujar nada. */
  var hatFor = function (id) { return "none"; };
  var onPhaseChange = function () {};

  /* ---------------------------------------------------------------- state (host) */
  var phase = "lobby"; // lobby | fightIntro | fight | roundEnd | final
  var currentMap = MAP0;
  var currentRound = 0, totalRounds = 3;
  var roster = []; // ids fixed for the whole match
  var scores = {};
  /* Contadores acumulados por partida, para el reveal de estadísticas del build web (ver
     online: "tal color tiró más patadas"). Nadie más los lee — desktop/steam no muestran
     nada con esto, pero se llevan igual porque es más simple que ramificar el hot path de
     stepPlayer() según el build. Mismo ciclo de vida que scores: se reinicia en startMatch(). */
  var matchStats = {};
  var players = {};
  var eliminationOrder = [];
  var phaseTimer = 0;
  var snailMode = false;
  /* "fixed" reproduce el comportamiento histórico (termina al llegar a totalRounds), y es lo
     único que usan los builds de escritorio y Steam. "infinite" y "wins" son exclusivos del
     build web — ver online/server.js — y solo se activan pasando opts.mode a startMatch().
     "wins" no tiene totalRounds (queda en Infinity, como "infinite"): termina sola apenas
     alguien acumula winTarget rondas ganadas (ver checkRoundEnd()/nextRound()). */
  var roundsMode = "fixed"; // "fixed" | "infinite" | "wins"
  var winTarget = 3; // solo tiene efecto con roundsMode === "wins"
  /* El build de escritorio (desktop/game.html) llama a startMatch(rounds, snail) SIN opts, y ahí
     el puntaje histórico reparte puntos de POSICIÓN a todo el mundo cada ronda (ver
     checkRoundEnd): último eliminado 1 punto, anteúltimo 2, etc. El build web SIEMPRE manda
     opts.mode (aunque sea "rounds") y puntúa distinto: 1 punto para quien ganó la ronda, nada
     para el resto — así "rondas" e "infinito" funcionan como un contador directo de "cuántas
     rondas ganaste", que es lo que "wins" necesita de por sí para su corte por winTarget. Se
     deriva de la MISMA señal que ya distingue "es el build web" en gameMode/roundsMode acá
     arriba, no un flag nuevo que haya que acordarse de pasar en cada call site. */
  var winnerOnlyScoring = false;
  /* "normal" reproduce el juego de siempre (eliminación decide la ronda). "koth" y "orbking"
     son exclusivos del build web — ver online/server.js — y comparten que eliminate() reaparece
     al jugador en vez de sacarlo de la ronda (ver noElimination()/su rama al principio de la
     función): en ninguno de los dos gana quien sobrevive, así que checkRoundEnd() nunca corre
     para ellos. koth suma puntos por updateHill(); orbking por updateOrbHold() contra un reloj
     fijo (ver ORBKING_MATCH_MS). */
  var gameMode = "normal"; // "normal" | "koth" | "orbking"
  function noElimination() { return gameMode === "koth" || gameMode === "orbking"; }
  var orb = null, orbTimer = ORB_SPAWN_MS;
  var hill = null, hillTimer = 0, hillLastPlatformIdx = -1;
  var orbkingTimer = 0;

  function newPlayer(id) {
    return {
      id: id,
      x: 100 + Math.random() * (W - 200), y: -40, vx: 0, vy: 0,
      grounded: false, facing: 1, hp: 100, alive: true,
      attack: null, attackCooldown: 0,
      input: { left: false, right: false },
      jumpEdge: false, punchEdge: false, kickEdge: false,
      walkCycle: 0, idleT: Math.random() * 10, squash: 0,
      hitStunT: 0, hitDir: 1, jumpAnticT: 0, deathFadeT: 0,
      power: null, burnT: 0, burnTickT: 0, burnFlashT: 0, slowT: 0,
      jumpsLeft: MAX_JUMPS, hillMs: 0, orbMs: 0,
    };
  }

  function ensurePlayer(id) { if (!players[id]) players[id] = newPlayer(id); return players[id]; }

  /* ---------------------------------------------------------------- lobby / round flow */
  /* x seguro para caer sobre `plat` sin quedar parado en una púa. Hazards.place() (world.js)
     siempre las pega a UN borde de la plataforma, nunca centradas, así que la franja del otro
     lado entero queda libre — solo hay que angostar el rango a esa franja. Compartido entre el
     spawn de inicio de ronda y el respawn de Rey de la Colina. */
  function computeSpawnX(plat, hazards) {
    var pad = Math.min(22, plat.w / 3);
    var lo = plat.x + pad, hi = plat.x + plat.w - pad;
    if (hi <= lo) { lo = plat.x + plat.w / 2; hi = lo; }

    var hz = null;
    for (var hi2 = 0; hi2 < hazards.length; hi2++) {
      var candidate = hazards[hi2];
      // No alcanza con comparar solo "y": dos plataformas distintas pueden compartir altura
      // (arena, anillo) y agarrar la púa de la OTRA. El hazard tiene que caer además dentro
      // del rango horizontal de esta plataforma puntual.
      if (Math.abs(candidate.y - plat.y) < 2 && candidate.x >= plat.x - 1 && candidate.x + candidate.w <= plat.x + plat.w + 1) {
        hz = candidate;
        break;
      }
    }
    if (hz) {
      // +PW (no solo un margen fijo): p.x es el CENTRO del cuerpo, que ocupa PW de cada
      // lado — sin sumarlo, un x apenas pasado el borde de la púa igual dejaba el cuerpo
      // pisándola (medía el centro contra el borde, no el borde del cuerpo contra el borde).
      var hzLo = hz.x, hzHi = hz.x + hz.w, safety = PW + 6;
      if (hzLo <= plat.x + 1) lo = Math.max(lo, hzHi + safety); // púas a la izquierda -> usar la derecha
      else hi = Math.min(hi, hzLo - safety); // púas a la derecha -> usar la izquierda
      if (hi <= lo) { lo = hi = (hzLo <= plat.x + 1) ? plat.x + plat.w - pad : plat.x + pad; }
    }
    return lo + Math.random() * Math.max(0, hi - lo);
  }

  function spawnRoundPlayers(map) {
    var plats = map.platforms;
    var hazards = map.hazards || [];
    roster.forEach(function (id, i) {
      var p = ensurePlayer(id);
      var plat = plats[i % plats.length];
      p.x = computeSpawnX(plat, hazards);
      p.y = -20 - i * 50;
      p.vx = 0; p.vy = 0; p.hp = 100; p.alive = true;
      p.attack = null; p.attackCooldown = 0;
      p.power = null; p.burnT = 0; p.burnTickT = 0; p.burnFlashT = 0; p.slowT = 0;
      p.jumpsLeft = MAX_JUMPS;
    });
    orb = null;
    orbTimer = ORB_SPAWN_MS;
  }

  function nextRound() {
    currentRound++;
    if (roundsMode === "fixed" && currentRound > totalRounds) { endMatch(); return; }
    /* "wins": no hay tope de rondas — se corta apenas alguien llega a winTarget victorias, y eso
       ya quedó decidido en checkRoundEnd() (ahí es donde se suma la victoria de la ronda que
       recién terminó). Chequear acá, antes de armar la ronda siguiente, evita que arranque una
       ronda de más después de que alguien ya cumplió el objetivo. */
    if (roundsMode === "wins" && roster.some(function (id) { return (scores[id] || 0) >= winTarget; })) {
      endMatch();
      return;
    }
    /* Modo infinito: cada 5 rondas (5, 10, 15…) vuelve al mapa inicial, igual que la ronda 1.
       El puntaje NUNCA se resetea acá — sigue acumulando desde la ronda 1 hasta que el
       anfitrión corta la partida con forceEndMatch(). Con un terreno fijado (Práctica Libre)
       esto se salta del todo: el objetivo es practicar ESE tipo de mapa sin fin, no que se lo
       interrumpa el mapa inicial genérico cada 5 rondas. Colina/Orbe (noElimination()) tampoco
       usan el mapa inicial en su única ronda: no son "una serie de rondas" que empieza por un
       mapa conocido, son una partida entera — les toca un mapa procedural como a cualquier otra
       ronda posterior. */
    var useStartMap = !forcedArchetype && !noElimination() && (currentRound === 1 || (roundsMode === "infinite" && currentRound % 5 === 0));
    if (useStartMap) {
      // MAP0 es un objeto compartido con biome:"ruinas" fijo en su definición — con un bioma
      // forzado (Práctica Libre) no se lo puede mutar in-place (lo reutilizan todos los
      // builds), así que se arma una copia liviana solo para pisarle biome (y el nombre, para
      // que el cartel de ronda no diga "Ruinas" mientras suena la música de otro bioma).
      currentMap = forcedBiome
        ? Object.assign({}, MAP0, { biome: forcedBiome, name: MAP0.name + " · " + Biomes.get(forcedBiome).name })
        : MAP0;
    } else {
      currentMap = genMap(1000 + currentRound * 37 + Math.floor(Math.random() * 900));
    }
    eliminationOrder = [];
    spawnRoundPlayers(currentMap);
    phase = "fightIntro";
    phaseTimer = 1100;
    onPhaseChange({
      t: "roundStart", round: currentRound, totalRounds: totalRounds, mapName: currentMap.name,
      infinite: roundsMode === "infinite",
    });
    AudioManager.on.roundStart(currentMap.biome);
  }

  /* Corta una partida infinita ya mismo, usando el puntaje acumulado hasta la última ronda
     completa (la ronda en curso, si había una, no llega a sumar). No existe en el flujo
     "fixed": ahí el propio nextRound() ya llama a endMatch() al llegar a totalRounds. */
  function forceEndMatch() {
    if (phase === "lobby" || phase === "final") return;
    endMatch();
  }

  /* Reaparece a un jugador en los modos sin eliminación: mismo tratamiento que el spawn de
     inicio de ronda (cae desde arriba a una plataforma al azar, esquivando púas), pero sin
     tocar hillMs/orbMs ni scores — esos son el marcador de la partida y tienen que sobrevivir
     al respawn. */
  function respawnPlayer(p) {
    var plats = currentMap.platforms;
    var plat = plats[Math.floor(Math.random() * plats.length)];
    p.x = computeSpawnX(plat, currentMap.hazards || []);
    p.y = -20 - Math.random() * 60;
    p.vx = 0; p.vy = 0; p.kbx = 0; p.hp = 100;
    p.attack = null; p.attackCooldown = 0;
    p.power = null; p.burnT = 0; p.burnTickT = 0; p.burnFlashT = 0; p.slowT = 0;
    p.jumpsLeft = MAX_JUMPS; p.hitStunT = 0; p.deathFadeT = 0;
  }

  function eliminate(p) {
    if (!p.alive) return;
    if (matchStats[p.id]) matchStats[p.id].falls++;
    HitStop.trigger(55);
    Camera.addTrauma(0.85);
    Camera.zoomImpulse(0.05);
    ScreenFX.flash(0.5);
    Particles.eliminationBurst(p.x, p.y - 24, colorFor(p.id));
    AudioManager.on.ko();

    /* Rey de la Colina y Rey del Orbe no eliminan a nadie: caerse o llegar a 0 hp solo hace que
       reaparezcas. La partida la gana el puntaje (círculo o tiempo con power), no la
       supervivencia — así que acá se corta antes de tocar alive/eliminationOrder/checkRoundEnd. */
    if (noElimination()) {
      respawnPlayer(p);
      return;
    }

    p.alive = false;
    p.deathFadeT = 420;
    eliminationOrder.push(p.id);
    var aliveN = roster.filter(function (id) { return players[id] && players[id].alive; }).length;
    if (aliveN === 2) AudioManager.on.clutch();
    checkRoundEnd();
  }

  function checkRoundEnd() {
    if (phase !== "fight") return;
    var alive = roster.filter(function (id) { return players[id] && players[id].alive; });
    if (alive.length <= 1) {
      if (alive.length === 1) eliminationOrder.push(alive[0]);
      if (winnerOnlyScoring) {
        // Build web: 1 punto para quien ganó la ronda (el último de eliminationOrder), nada
        // para el resto — ver el comentario de winnerOnlyScoring más arriba.
        var winnerId = eliminationOrder[eliminationOrder.length - 1];
        if (winnerId !== undefined) scores[winnerId] = (scores[winnerId] || 0) + 1;
      } else {
        // Build de escritorio: puntaje histórico de posición, todos suman algo cada ronda.
        eliminationOrder.forEach(function (id, idx) {
          var placement = idx + 1;
          scores[id] = (scores[id] || 0) + placement;
        });
      }
      phase = "roundEnd";
      phaseTimer = 2600;
      orb = null;
    }
  }

  function endMatch() {
    phase = "final";
    var ranked = roster.slice().sort(function (a, b) { return (scores[b] || 0) - (scores[a] || 0); });
    var winner = ranked[0];
    onPhaseChange({ t: "final", ranked: ranked, winner: winner });
    if (winner !== undefined) AudioManager.on.victory(); else AudioManager.on.gameOver();
  }

  /* ---------------------------------------------------------------- rey de la colina */
  /* Nunca repite la plataforma anterior (si hay más de una para elegir), para que el círculo
     no vuelva a caer en el mismo lugar dos veces seguidas. y - 30: mismo offset que spawnOrb,
     deja el centro a la altura del torso de alguien parado ahí. */
  function pickHillSpot() {
    var plats = currentMap.platforms;
    if (!plats.length) return null;
    var idx = Math.floor(Math.random() * plats.length);
    if (plats.length > 1 && idx === hillLastPlatformIdx) idx = (idx + 1) % plats.length;
    hillLastPlatformIdx = idx;
    var pl = plats[idx];
    return { x: pl.x + pl.w / 2, y: pl.y - 30, r: HILL_RADIUS };
  }

  function updateHill(dt) {
    if (phase !== "fight") return;
    hillTimer -= dt;
    if (hillTimer <= 0) { hill = pickHillSpot(); hillTimer = HILL_ACTIVE_MS; }
    if (!hill) return;

    for (var i = 0; i < roster.length; i++) {
      var p = players[roster[i]];
      if (!p || !p.alive) continue;
      var dx = p.x - hill.x, dy = (p.y - 20) - hill.y;
      if (dx * dx + dy * dy > hill.r * hill.r) continue;
      p.hillMs += dt;
      var newScore = Math.min(HILL_TARGET_SCORE, Math.floor(p.hillMs * (HILL_TARGET_SCORE / HILL_TARGET_MS)));
      if (newScore > (scores[p.id] || 0)) scores[p.id] = newScore;
      if (scores[p.id] >= HILL_TARGET_SCORE) { endMatch(); return; }
    }
  }

  function drawHill(ctx) {
    if (!hill) return;
    ctx.save();
    ctx.fillStyle = "rgba(255,194,71,.10)";
    ctx.strokeStyle = "rgba(255,194,71,.9)";
    ctx.lineWidth = 3;
    if (!snailMode) { ctx.shadowColor = "rgba(255,194,71,.7)"; ctx.shadowBlur = 16; }
    ctx.beginPath();
    ctx.arc(hill.x, hill.y, hill.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- power orbs */
  var ORB_TYPES = null; // resolved lazily, POWER_COLORS comes from stickman.js
  function orbTypes() { return ORB_TYPES || (ORB_TYPES = Object.keys(POWER_COLORS)); }

  /* Un glyph por tipo de power, dibujado ADENTRO del orbe (ver drawOrb) para que se distinga
     cuál es cuál de un vistazo, sin tener que memorizar qué color es cada poder. Emoji y no un
     path SVG a mano: ya es el idioma que usa el resto de la UI del build web (♾️ ⛰️ 🔮 en los
     modos, 🐌 caracol) y con reach/reduceOpacity da un ícono reconocible con cero mantenimiento
     de paths nuevos. */
  var ORB_GLYPHS = { fuego: "🔥", hielo: "❄️", tierra: "🛡️", aire: "⚡" };

  function spawnOrb() {
    var plats = currentMap.platforms;
    var pl = plats[Math.floor(Math.random() * plats.length)];
    var pad = Math.min(24, pl.w / 3);
    var lo = pl.x + pad, hi = pl.x + pl.w - pad;
    var x = hi > lo ? lo + Math.random() * (hi - lo) : pl.x + pl.w / 2;
    var types = orbTypes();
    var type = types[Math.floor(Math.random() * types.length)];
    orb = { type: type, x: x, y: pl.y - 30, bornT: 0 };
  }

  function updateOrbs(dt) {
    if (phase !== "fight") return;
    orbTimer -= dt;
    if (orbTimer <= 0) { spawnOrb(); orbTimer = ORB_SPAWN_MS; }
    if (!orb) return;
    orb.bornT += dt;
    for (var i = 0; i < roster.length; i++) {
      var p = players[roster[i]];
      if (!p || !p.alive) continue;
      var dx = p.x - orb.x, dy = (p.y - 20) - orb.y;
      if (dx * dx + dy * dy < ORB_PICKUP_R * ORB_PICKUP_R) {
        p.power = { type: orb.type, t: ORB_POWER_MS };
        AudioManager.on.uiClick();
        orb = null;
        break;
      }
    }
  }

  function drawOrb(ctx) {
    if (!orb) return;
    var color = POWER_COLORS[orb.type];
    var y = orb.y + (snailMode ? 0 : Math.sin(orb.bornT * 0.004) * 4);
    ctx.save();
    ctx.fillStyle = color;
    if (!snailMode) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    ctx.beginPath(); ctx.arc(orb.x, y, 10, 0, Math.PI * 2); ctx.fill();
    if (!snailMode) ctx.shadowBlur = 0;
    ctx.restore();

    // Alfa baja a propósito: es un acento adentro del brillo del orbe, no un sticker encima —
    // demasiado opaco compite con el glow en vez de fundirse con él.
    var glyph = ORB_GLYPHS[orb.type];
    if (glyph) {
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.font = "13px 'Segoe UI Emoji','Noto Color Emoji',sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph, orb.x, y + 1);
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- rey del orbe */
  /* Cuenta, para cada jugador vivo, cuánto tiempo lleva con un power activo (cualquier tipo —
     p.power lo pone updateOrbs()/pickup, y stepPlayer ya lo va apagando solo al vencer su
     duración). Puntaje = segundos enteros acumulados, sin tope: gana quien más sume cuando se
     acaba orbkingTimer. */
  function updateOrbHold(dt) {
    if (phase !== "fight") return;
    orbkingTimer -= dt;
    for (var i = 0; i < roster.length; i++) {
      var p = players[roster[i]];
      if (!p || !p.alive || !p.power) continue;
      p.orbMs += dt;
      scores[p.id] = Math.floor(p.orbMs / 1000);
    }
    if (orbkingTimer <= 0) endMatch();
  }

  function drawMatchClock(ctx) {
    if (phase !== "fight" && phase !== "fightIntro") return;
    var totalSec = Math.max(0, Math.ceil(orbkingTimer / 1000));
    var mm = Math.floor(totalSec / 60), ss = totalSec % 60;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.font = "bold 22px Chakra Petch, sans-serif";
    ctx.textAlign = "center";
    /* y=112, no 34: el HUD del build online superpone DOM encima del canvas ahí arriba — el
       topbar de avatares de colores (top:14px, 40px de alto) y, debajo, el cartel de ronda que
       queda visible durante todo el fight (top:64px) — y a y=34 el reloj quedaba tapado por el
       primero. 112 cae debajo de los dos con margen, en la franja de "cielo" que ningún
       archetype de world.js usa para plataformas. */
    ctx.fillText(mm + ":" + (ss < 10 ? "0" : "") + ss, ctx.canvas.width / 2, 112);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- player-vs-player collision */
  var COLLIDE_HW = PW + 4;
  // Antes esto resolvía el solapamiento COMPLETO en un solo frame: caminar contra alguien
  // quieto lo arrastraba a tu propia velocidad, como si fuera parte de tu cuerpo. Con este
  // factor solo se corrige una fracción por frame — a 60 fps sigue separando los cuerpos en
  // un puñado de frames (nada de traspasarse), pero cada empujón individual es mucho más
  // suave: apenas lo mueve, no lo arrastra de una.
  var COLLIDE_PUSH = 0.18;
  function resolvePlayerCollisions(ids) {
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < ids.length; i++) {
        var a = players[ids[i]];
        if (!a || !a.alive) continue;
        for (var j = i + 1; j < ids.length; j++) {
          var b = players[ids[j]];
          if (!b || !b.alive) continue;
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var xOverlap = COLLIDE_HW * 2 - Math.abs(dx);
          var yOverlap = PH - Math.abs(dy);
          if (xOverlap <= 0 || yOverlap <= 0) continue;
          if (dx === 0) dx = ids[i] < ids[j] ? -0.01 : 0.01;
          var dir = dx > 0 ? 1 : -1;
          var half = (xOverlap / 2) * COLLIDE_PUSH;
          a.x -= dir * half;
          b.x += dir * half;
          a.x = clamp(a.x, 14, W - 14);
          b.x = clamp(b.x, 14, W - 14);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- physics */
  function stepPlayer(p, dt, damageEnabled) {
    if (!p.alive) {
      if (p.deathFadeT > 0) p.deathFadeT = Math.max(0, p.deathFadeT - dt);
      return;
    }
    var dtScale = dt / 16.6667;
    var speedMult = 1;
    if (p.power && p.power.type === "aire") speedMult *= AIR_SPEED_MULT;
    if (p.slowT > 0) speedMult *= SLOW_MULT;
    var spd = SPEED * speedMult;
    if (p.hitStunT > 0) {
      // En hitstun no se puede caminar: antes el input de movimiento pisaba vx cada frame sin
      // importar nada, así que alguien corriendo hacia el que pega podía cancelar el empuje de
      // la patada al toque con solo seguir sosteniendo la tecla. Ahora, mientras dura el
      // stun, el único movimiento horizontal es el que aporta kbx (el empuje en sí).
      p.vx = 0;
    } else if (p.input.left && !p.input.right) { p.vx = -spd; p.facing = -1; }
    else if (p.input.right && !p.input.left) { p.vx = spd; p.facing = 1; }
    else p.vx = 0;

    if (p.jumpEdge && p.jumpsLeft > 0) {
      /* El primero es siempre el salto entero (JUMP_V), lo pidas parado en una plataforma o ya
         cayendo por haberte pasado del borde. El segundo es el valor fijo de siempre (JUMP_V2),
         no una fracción de lo que quedaba de vy: se puede pedir subiendo o bajando y da la
         misma altura extra en los dos casos. */
      p.vy = p.jumpsLeft === MAX_JUMPS ? JUMP_V : JUMP_V2;
      p.jumpsLeft--;
      p.grounded = false;
      p.jumpAnticT = 90;
      AudioManager.on.jump();
    }
    p.jumpEdge = false;

    if ((p.punchEdge || p.kickEdge) && p.attackCooldown <= 0) {
      var type = p.kickEdge ? "kick" : "punch";
      var def = ATTACKS[type];
      p.attack = { type: type, t: def.dur, dur: def.dur, hitSet: {} };
      var cdMult = (p.power && p.power.type === "aire") ? AIR_COOLDOWN_MULT : 1;
      // El cooldown es por tipo de ataque, no compartido: así una piña puede ser literalmente
      // el doble de rápida que una patada en vez de quedar frenada por el mismo temporizador.
      p.attackCooldown = def.cooldown * cdMult;
      if (matchStats[p.id]) matchStats[p.id][type === "kick" ? "kicks" : "punches"]++;
      AudioManager.on.swing(type);
    }
    p.punchEdge = false;
    p.kickEdge = false;

    p.vy += (p.vy < 0 ? GRAVITY_UP : GRAVITY_DOWN) * dtScale;
    var prevFeet = p.y;
    var wasGrounded = p.grounded;
    p.y += p.vy * dtScale;
    p.kbx = (p.kbx || 0) * Math.pow(0.88, dtScale);
    if (Math.abs(p.kbx) < 0.05) p.kbx = 0;
    p.x += (p.vx + p.kbx) * dtScale;
    p.x = Math.max(14, Math.min(W - 14, p.x));

    if (p.vx !== 0 && wasGrounded) p.walkCycle = ((p.walkCycle || 0) + dt * 0.0034) % 1;
    p.idleT += dt * 0.001;
    if (p.squash > 0) p.squash = Math.max(0, p.squash - dt * 0.006);
    if (p.jumpAnticT > 0) p.jumpAnticT = Math.max(0, p.jumpAnticT - dt);
    if (p.hitStunT > 0) p.hitStunT = Math.max(0, p.hitStunT - dt);
    if (p.deathFadeT > 0) p.deathFadeT = Math.max(0, p.deathFadeT - dt);
    if (p.burnFlashT > 0) p.burnFlashT = Math.max(0, p.burnFlashT - dt);

    if (p.power) { p.power.t -= dt; if (p.power.t <= 0) p.power = null; }
    if (damageEnabled && p.burnT > 0) {
      p.burnT -= dt;
      p.burnTickT -= dt;
      if (p.burnTickT <= 0) {
        p.hp -= BURN_DMG;
        p.burnTickT = BURN_TICK_MS;
        p.burnFlashT = 220;
        if (p.hp <= 0) eliminate(p);
      }
    }
    if (p.slowT > 0) p.slowT = Math.max(0, p.slowT - dt);

    p.grounded = false;
    var plats = currentMap.platforms;
    for (var pi = 0; pi < plats.length; pi++) {
      var pl = plats[pi];
      if (p.vy >= 0 && prevFeet <= pl.y + 1 && p.y >= pl.y && p.x + PW > pl.x && p.x - PW < pl.x + pl.w) {
        p.y = pl.y;
        if (!wasGrounded && p.vy > 5) {
          p.squash = Math.min(1, p.vy / 14);
          var landStrength = clamp(p.vy / 14, 0, 1);
          Camera.addTrauma(landStrength * 0.22);
          if (!snailMode) Particles.landingDust(p.x, p.y, p.facing, landStrength, "rgba(255,255,255,.55)");
          AudioManager.on.land(landStrength);
        }
        p.vy = 0; p.grounded = true;
        p.jumpsLeft = MAX_JUMPS; // tocar cualquier superficie repone los dos saltos
      }
    }

    var inLobby = phase === "lobby";
    if (p.y > H + 60) {
      if (inLobby) { p.x = 100 + Math.random() * (W - 200); p.y = -40; p.vy = 0; p.vx = 0; }
      else if (damageEnabled) { eliminate(p); }
    }

    if (damageEnabled && p.alive && World.checkHazards(p, currentMap, PW)) { eliminate(p); }

    if (p.attack) {
      p.attack.t -= dt;
      if (damageEnabled) {
        for (var oi = 0; oi < roster.length; oi++) {
          var oid = roster[oi];
          if (oid === p.id) continue;
          var o = players[oid];
          if (!o || !o.alive || p.attack.hitSet[oid]) continue;
          var atk = ATTACKS[p.attack.type];
          var reach = atk.reach;
          var dx = o.x - p.x;
          var facingOk = p.facing > 0 ? (dx > -6 && dx < reach) : (dx < 6 && dx > -reach);
          var dy = Math.abs(o.y - p.y - 10);
          if (facingOk && dy < 60) {
            p.attack.hitSet[oid] = true;
            var dmg = atk.damage;
            if (o.power && o.power.type === "tierra") dmg = Math.round(dmg * ARMOR_MULT);
            var kbX = atk.kbX;
            var kbY = atk.kbY;
            o.hp -= dmg;
            if (matchStats[p.id]) matchStats[p.id].hitsLanded++;
            if (matchStats[oid]) matchStats[oid].hitsTaken++;
            if (p.power && p.power.type === "fuego") { o.burnT = BURN_MS; o.burnTickT = BURN_TICK_MS; o.burnFlashT = 220; }
            if (p.power && p.power.type === "hielo") o.slowT = SLOW_MS;
            o.kbx = (o.kbx || 0) + p.facing * kbX;
            o.vy += kbY;
            if (kbY < 0) o.grounded = false;

            var hitX = o.x, hitY = o.y - 14;
            HitStop.trigger(atk.hitStop);
            Camera.addTrauma(atk.trauma);
            Camera.zoomImpulse(0.03);
            if (!snailMode) Particles.punchSparks(hitX, hitY, p.facing, colorFor(p.id));
            ScreenFX.impactStreak(hitX, hitY, p.facing);
            AudioManager.on.hit(p.attack.type);
            o.squash = Math.max(o.squash || 0, atk.squash);
            p.squash = Math.max(p.squash || 0, 0.2);
            o.hitStunT = atk.hitStun;
            o.hitDir = p.facing;

            if (o.hp <= 0) eliminate(o);
          }
        }
      }
      if (p.attack.t <= 0) p.attack = null;
    }
    if (p.attackCooldown > 0) p.attackCooldown -= dt;
  }

  /* ---------------------------------------------------------------- rendering */
  function drawMap(ctx, tMs, dt) { World.draw(ctx, W, H, currentMap, Camera, tMs, dt); }

  function drawPlayer(ctx, p) {
    if (!p.alive && phase !== "lobby" && p.deathFadeT <= 0) return;
    var color = colorFor(p.id);
    var hat = hatFor(p.id);

    if (p.attack && !snailMode) {
      Trails.push(p, performance.now());
      Trails.draw(ctx, p, function (gctx, ghost) { drawStickman(gctx, ghost, color, null, hat); });
    } else if (p._trail) {
      Trails.clear(p);
    }

    /* Estela de velocidad del orbe de aire: mismo mecanismo que el trail de golpe de arriba,
       pero en su propio canal (key "_airTrail") para que uno no le coma los fantasmas al otro
       si ambos coinciden (pegar mientras tenés aire activo). Bien exagerada a propósito — más
       fantasmas, capturados más seguido, bastante más visibles — porque el objetivo es que se
       note "esto se mueve rapidísimo" de un vistazo, no una sutileza. */
    if (p.power && p.power.type === "aire" && p.alive && !snailMode) {
      Trails.push(p, performance.now(), { key: "_airTrail", maxGhosts: 6, minIntervalMs: 18 });
      Trails.draw(ctx, p, function (gctx, ghost) { drawStickman(gctx, ghost, color, null, hat); },
        { key: "_airTrail", baseAlpha: 0.05, alphaSpread: 0.34 });
    } else if (p._airTrail) {
      Trails.clear(p, { key: "_airTrail" });
    }

    var fading = !p.alive && p.deathFadeT > 0;
    if (fading) ctx.globalAlpha = clamp(p.deathFadeT / 420, 0, 1);
    var rig = drawStickman(ctx, p, color, null, hat);
    var headY = rig.headY;
    /* Todo lo que va ARRIBA de la cabeza (barra de vida, nombre, glyph de poder, contador de
       koth/orbe) se corre según lo que el jugador tenga puesto: con un accesorio alto, las
       alturas fijas de siempre le quedaban por debajo de la galera o de la hélice. */
    var hudY = headY - accessoryLift(hat);
    if (fading) { ctx.globalAlpha = 1; return; }

    if (phase === "fight" || phase === "fightIntro" || phase === "roundEnd") {
      var bw = 40;
      ctx.fillStyle = "rgba(0,0,0,.5)";
      ctx.fillRect(p.x - bw / 2, hudY - 24, bw, 5);
      ctx.fillStyle = color;
      ctx.fillRect(p.x - bw / 2, hudY - 24, bw * Math.max(0, p.hp) / 100, 5);
    }

    if (!snailMode) {
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "10px Chakra Petch, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(nameFor(p.id), p.x, hudY - 30);

      // Mismo glyph que el orbe (ver drawOrb): mientras el power sigue activo, arriba del
      // nombre, para que se sepa de un vistazo quién tiene qué sin tener que memorizar colores.
      var glyph = p.power && ORB_GLYPHS[p.power.type];
      if (glyph) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.font = "12px 'Segoe UI Emoji','Noto Color Emoji',sans-serif";
        ctx.fillText(glyph, p.x, hudY - 42);
        ctx.restore();
      }
    }

    /* Contador de puntos de Rey de la Colina / Rey del Orbe, arriba del nombre. Sin gate de
       snailMode: en estos modos es el marcador de la partida, no un adorno, así que se ve
       incluso en PCs lentas. */
    if (gameMode === "koth" || gameMode === "orbking") {
      ctx.fillStyle = gameMode === "koth" ? "rgba(255,194,71,.95)" : "rgba(157,255,79,.95)";
      ctx.font = "bold 11px Chakra Petch, sans-serif";
      ctx.textAlign = "center";
      var txt = gameMode === "koth" ? (scores[p.id] || 0) + " / " + HILL_TARGET_SCORE : (scores[p.id] || 0) + "s";
      ctx.fillText(txt, p.x, hudY - 42);
    }
  }

  /* ================================================================== public API (host) */
  function init(opts) {
    opts = opts || {};
    if (opts.colorFor) colorFor = opts.colorFor;
    if (opts.nameFor) nameFor = opts.nameFor;
    if (opts.hatFor) hatFor = opts.hatFor;
    if (opts.onPhaseChange) onPhaseChange = opts.onPhaseChange;

    /* Ajuste de combate por build. Merge campo por campo (no reemplazo del objeto) para que
       quien pise solo `damage` no se lleve puesto el resto de la definición del ataque. */
    if (opts.attacks) {
      for (var type in opts.attacks) {
        if (!ATTACKS[type]) continue;
        var over = opts.attacks[type];
        for (var k in over) if (over[k] != null) ATTACKS[type][k] = over[k];
      }
    }
  }

  function getAttacks() { return ATTACKS; }

  function addPlayer(id) { ensurePlayer(id); }
  function removePlayer(id) {
    delete players[id];
    roster = roster.filter(function (i) { return i !== id; });
  }

  function handleInput(id, key, down) {
    var p = ensurePlayer(id);
    if (key === "left") p.input.left = down;
    else if (key === "right") p.input.right = down;
    else if (key === "jump" && down) p.jumpEdge = true;
    else if (key === "punch" && down) p.punchEdge = true;
    else if (key === "kick" && down) p.kickEdge = true;
  }

  function setSnailMode(on) { snailMode = !!on; }
  function getSnailMode() { return snailMode; }

  /* opts es nuevo y opcional: sin él (como llaman desktop/game.html y steam/game.html, con
     solo 2 argumentos) el comportamiento es EXACTAMENTE el de siempre — modo "fixed", 1..20
     rondas clampeadas. Solo el build web pasa { mode: "infinite" }, { mode: "wins" } o
     { mode: "koth" }, y solo Práctica Libre además pasa { biome: "volcan" } (o el id que sea)
     para fijar el fondo+música. Rey de la Colina y Rey del Orbe son una sola ronda que nunca
     termina por eliminación (ver eliminate()/noElimination()). Colina usa el archetype "colina"
     de world.js (mucho más terreno que los demás) salvo que Práctica Libre ya haya forzado uno
     propio; Orbe juega en mapas normales (no necesita más terreno, el reloj de 2 min ya limita
     la partida). Los dos arrancan con el marcador en 0 como cualquier otro modo — acá scores[id]
     son puntos del círculo o segundos con power, no puntaje de ronda.

     "wins" reusa el mismo parámetro `rounds` que "fixed", pero con otro significado: no es la
     cantidad de rondas que se van a jugar (eso queda sin tope, ver totalRounds acá abajo), sino
     cuántas rondas GANADAS hacen falta para cortar la partida (winTarget). Evita agregar un
     parámetro nuevo solo para esto — el cliente ya sabe, por opts.mode, cuál de los dos sentidos
     usar al mostrar el picker. */
  function startMatch(rounds, snail, opts) {
    opts = opts || {};
    gameMode = opts.mode === "koth" ? "koth" : opts.mode === "orbking" ? "orbking" : "normal";
    roundsMode = opts.mode === "infinite" ? "infinite" : opts.mode === "wins" ? "wins" : "fixed";
    totalRounds = noElimination() ? 1 : (roundsMode === "fixed" ? Math.max(1, Math.min(20, rounds || 3)) : Infinity);
    winTarget = Math.max(1, Math.min(20, rounds || 3));
    winnerOnlyScoring = opts.mode !== undefined;
    snailMode = !!snail;
    forcedArchetype = opts.mapArchetype || (gameMode === "koth" ? "colina" : null);
    forcedBiome = opts.biome || null;
    roster = Object.keys(players).map(Number);
    scores = {};
    matchStats = {};
    roster.forEach(function (id) {
      scores[id] = 0;
      matchStats[id] = { kicks: 0, punches: 0, falls: 0, hitsLanded: 0, hitsTaken: 0 };
      var p = players[id];
      if (p) { p.hillMs = 0; p.orbMs = 0; }
    });
    hill = null;
    hillTimer = 0;
    hillLastPlatformIdx = -1;
    orbkingTimer = 0;
    currentRound = 0;
    nextRound();
  }

  function resetToLobby() {
    phase = "lobby";
    roundsMode = "fixed";
    gameMode = "normal";
    forcedArchetype = null;
    forcedBiome = null;
    players = {};
    roster = [];
    scores = {};
    currentRound = 0;
    currentMap = MAP0;
    orb = null;
    orbTimer = ORB_SPAWN_MS;
    hill = null;
    hillTimer = 0;
    hillLastPlatformIdx = -1;
    orbkingTimer = 0;
    AudioManager.on.toLobby();
  }

  function step(dt) {
    var damageEnabled = phase === "fight";
    var idsToStep = phase === "lobby" ? Object.keys(players).map(Number) : roster;
    for (var si = 0; si < idsToStep.length; si++) stepPlayer(players[idsToStep[si]], dt, damageEnabled);
    resolvePlayerCollisions(idsToStep);
    updateOrbs(dt);
    if (gameMode === "koth") updateHill(dt);
    else if (gameMode === "orbking") updateOrbHold(dt);

    if (phase === "fightIntro") {
      phaseTimer -= dt;
      if (phaseTimer <= 0) {
        phase = "fight"; orbTimer = ORB_SPAWN_MS;
        if (gameMode === "koth") { hill = null; hillTimer = HILL_APPEAR_DELAY_MS; }
        else if (gameMode === "orbking") { orbkingTimer = ORBKING_MATCH_MS; }
        Camera.zoomImpulse(0.04); AudioManager.on.fightBegin(); onPhaseChange({ t: "fight" });
      }
    } else if (phase === "roundEnd") {
      phaseTimer -= dt;
      if (phaseTimer <= 0) nextRound();
    }

    Camera.update(dt);
    Particles.update(dt);
    ScreenFX.update(dt);
  }

  function draw(ctx, now, dt) {
    Camera.begin(ctx, W, H);
    drawMap(ctx, now, dt);
    drawOrb(ctx);
    if (gameMode === "koth") drawHill(ctx);
    var ids = phase === "lobby" ? Object.keys(players).map(Number) : roster;
    for (var i = 0; i < ids.length; i++) drawPlayer(ctx, players[ids[i]]);
    Particles.draw(ctx);
    Camera.end(ctx);
    /* De acá para abajo se dibuja en píxeles de PANTALLA, no del mundo: la cámara ya cerró, así
       que lo que corresponde son las medidas del canvas y no W/H, que desde que el mundo creció
       son un 20% más grandes. */
    var cw = ctx.canvas.width, ch = ctx.canvas.height;
    if (gameMode === "orbking") drawMatchClock(ctx); // relojito fijo en pantalla, no shakea con la cámara
    ScreenFX.drawVignette(ctx, cw, ch);
    ScreenFX.draw(ctx, cw, ch, cw / W);
  }

  // World.draw caches a CanvasGradient directly on each platform object (pl._grad/_gradH) the
  // first time it's rendered, as a legitimate perf optimization for the single-machine render
  // path — screen.html and this same host's own canvas never see a problem, since a live
  // CanvasGradient is a perfectly normal thing to hold onto for drawing. But snapshot() used
  // to hand out that SAME mutated object as `map`, and PeerJS's binary serializer throws the
  // instant it tries to pack a CanvasGradient (a native, non-plain-data object) — silently
  // failing every single broadcast after the first render, which is exactly what left guests
  // stuck on the waiting screen forever. Sending freshly-built plain platform objects instead
  // guarantees the network copy can never carry a render-only field, no matter what future
  // drawing code caches on them.
  function cleanMapForNetwork(map) {
    return {
      name: map.name, bg: map.bg, biome: map.biome, archetype: map.archetype,
      seed: map.seed, hazards: map.hazards,
      platforms: map.platforms.map(function (p) { return { x: p.x, y: p.y, w: p.w, h: p.h }; }),
    };
  }

  function snapshot() {
    var pl = {};
    roster.forEach(function (id) {
      var p = players[id];
      if (!p) return;
      pl[id] = {
        x: p.x, y: p.y, facing: p.facing, alive: p.alive, hp: p.hp, grounded: p.grounded,
        walkCycle: p.walkCycle, idleT: p.idleT, squash: p.squash, hitStunT: p.hitStunT, hitDir: p.hitDir,
        jumpAnticT: p.jumpAnticT, deathFadeT: p.deathFadeT, power: p.power,
        burnT: p.burnT, burnFlashT: p.burnFlashT, slowT: p.slowT,
        attack: p.attack ? { type: p.attack.type, t: p.attack.t, dur: p.attack.dur } : null,
        vx: p.vx, vy: p.vy,
      };
    });
    return {
      phase: phase, round: currentRound, totalRounds: totalRounds,
      map: cleanMapForNetwork(currentMap), roster: roster, scores: scores, players: pl,
      orb: orb, snail: snailMode, gameMode: gameMode, hill: hill, orbkingTimer: orbkingTimer,
    };
  }

  /* ================================================================== guest side */
  // Pure renderer: no physics authority. Mirrors index.html's guestLoop pattern — interpolates
  // positions between the last two snapshots and advances purely-cosmetic animation timers
  // locally so nothing looks frozen between the ~25/s broadcasts.
  var guestLocal = {}; // id -> locally-advanced animation clock, resynced on each snapshot
  var guestPrevSnap = null, guestCurSnap = null;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function resyncGuestPlayer(id, pd) {
    var lp = guestLocal[id] || (guestLocal[id] = { id: id });
    lp.alive = pd.alive; lp.hp = pd.hp; lp.grounded = pd.grounded; lp.facing = pd.facing;
    lp.vx = pd.vx; lp.vy = pd.vy; lp.hitDir = pd.hitDir; lp.power = pd.power;
    lp.walkCycle = pd.walkCycle; lp.idleT = pd.idleT; lp.squash = pd.squash;
    lp.hitStunT = pd.hitStunT; lp.jumpAnticT = pd.jumpAnticT; lp.deathFadeT = pd.deathFadeT;
    lp.burnT = pd.burnT; lp.burnFlashT = pd.burnFlashT; lp.slowT = pd.slowT;
    lp.attack = pd.attack ? { type: pd.attack.type, t: pd.attack.t, dur: pd.attack.dur } : null;
    return lp;
  }

  function guestApplySnapshot(data) {
    guestPrevSnap = guestCurSnap;
    guestCurSnap = { t: performance.now(), data: data };
    data.roster.forEach(function (id) {
      var pd = data.players[id];
      if (pd) resyncGuestPlayer(id, pd);
    });
  }

  function guestFrame(nowT, frameDt) {
    if (!guestCurSnap) return null;
    var s = guestCurSnap.data;
    phase = s.phase; currentRound = s.round; totalRounds = s.totalRounds;
    currentMap = s.map; roster = s.roster; scores = s.scores;
    orb = s.orb; snailMode = !!s.snail;
    gameMode = s.gameMode || "normal"; hill = s.hill || null;
    orbkingTimer = s.orbkingTimer || 0;

    var span = guestPrevSnap ? (guestCurSnap.t - guestPrevSnap.t) : 0;
    var t = span > 0 ? clamp((nowT - guestCurSnap.t) / span, 0, 1.4) : 1;
    players = {};
    s.roster.forEach(function (id) {
      var pd = s.players[id];
      var lp = guestLocal[id];
      if (!pd || !lp) return;

      if (lp.alive) {
        lp.idleT += frameDt * 0.001;
        if (lp.grounded && lp.vx !== 0) lp.walkCycle = ((lp.walkCycle || 0) + frameDt * 0.0034) % 1;
        if (lp.squash > 0) lp.squash = Math.max(0, lp.squash - frameDt * 0.006);
        if (lp.jumpAnticT > 0) lp.jumpAnticT = Math.max(0, lp.jumpAnticT - frameDt);
        if (lp.hitStunT > 0) lp.hitStunT = Math.max(0, lp.hitStunT - frameDt);
        if (lp.burnFlashT > 0) lp.burnFlashT = Math.max(0, lp.burnFlashT - frameDt);
        if (lp.attack) { lp.attack.t -= frameDt; if (lp.attack.t <= 0) lp.attack = null; }
      } else if (lp.deathFadeT > 0) {
        lp.deathFadeT = Math.max(0, lp.deathFadeT - frameDt);
      }

      var x = pd.x, y = pd.y;
      var prevPd = guestPrevSnap && guestPrevSnap.data.players[id];
      if (prevPd && prevPd.alive && pd.alive) {
        x = lerp(prevPd.x, pd.x, t);
        y = lerp(prevPd.y, pd.y, t);
      }
      /* Trails.push()/clear() (fx.js) escriben el array de fantasmas SOBRE el objeto que
         reciben. players[id] de abajo es un objeto NUEVO cada frame — necesario para poder
         interpolar x/y sin mutar el estado persistente — así que un array creado ahí se pierde
         apenas termina el frame y nunca llega a acumular más de un fantasma: la estela de
         golpe y la de aire quedaban invisibles en el build online (el host de los builds P2P
         no tiene este problema porque ahí `players` nunca se reconstruye, es el mismo objeto
         mutado en el tiempo). Sembrar el array acá, sobre `lp` (el objeto persistente), hace
         que el Object.assign de abajo copie la MISMA referencia — así los push() de otros
         frames sí se acumulan en el array real. */
      if (!lp._trail) lp._trail = [];
      if (!lp._airTrail) lp._airTrail = [];
      players[id] = Object.assign({}, lp, { x: x, y: y });
    });
    return { phase: phase, round: currentRound, totalRounds: totalRounds, roster: roster, scores: scores };
  }

  function resetGuest() {
    guestLocal = {};
    guestPrevSnap = null;
    guestCurSnap = null;
  }

  return {
    W: W, H: H, MAP0: MAP0,
    init: init,
    addPlayer: addPlayer, removePlayer: removePlayer,
    handleInput: handleInput,
    setSnailMode: setSnailMode, getSnailMode: getSnailMode,
    getAttacks: getAttacks,
    startMatch: startMatch, resetToLobby: resetToLobby, forceEndMatch: forceEndMatch,
    step: step, draw: draw, snapshot: snapshot,
    getPhase: function () { return phase; },
    getRoster: function () { return roster; },
    getScores: function () { return scores; },
    getMatchStats: function () { return matchStats; },
    getPlayers: function () { return players; },
    getCurrentMap: function () { return currentMap; },
    getCurrentRound: function () { return currentRound; },
    getTotalRounds: function () { return totalRounds; },
    // guest
    guestApplySnapshot: guestApplySnapshot,
    guestFrame: guestFrame,
    resetGuest: resetGuest,
    drawMap: drawMap, drawPlayer: drawPlayer, drawOrb: drawOrb,
  };
})();
