/* IA de los NPC (bots) de Last Stick Standing — build web.

   Una sola ruta de código para todos los bots de todos los modos: Práctica Libre (un bot),
   Last Stick Standing/Historia y Modo Historia/saga (varios bots + jefes). index.html solo
   llama BotAI.tick(idBot, idObjetivo, dt, dificultad) una vez por frame y por bot, ANTES de
   Sim.step. No toca física, combate ni red: lo único que hace es apretar y soltar las mismas
   teclas que un jugador (Sim.handleInput).

   Por qué está armada así, y no como "si el jugador está a la derecha, caminar a la derecha":

   1. MODELO DEL MUNDO — predict() es una copia del integrador de stepPlayer (online/sim.js):
      mismo orden (input → salto → gravedad → posición → knockback → clamp → aterrizaje →
      caída → púas) y mismas constantes (Sim.getPhysicsConsts). Toda pregunta del tipo "si hago
      esto, ¿dónde termino?" se responde simulando, no con márgenes a ojo. Así el bot sabe que
      el vacío existe: un salto o una caída que en la simulación termina fuera del mapa o sobre
      una púa no se hace.

   2. NAVEGACIÓN — por mapa se precalculan, simulando, los "links": desde qué tramo de x de la
      plataforma A un salto (simple, doble, o dejarse caer por un borde) aterriza con seguridad
      en B. Eso da un grafo dirigido de plataformas; Dijkstra hacia la plataforma del objetivo
      da la ruta (con plataformas intermedias si hacen falta). Si no hay ruta, el bot se ubica
      en la plataforma alcanzable más cercana al rival y espera ahí en vez de tirarse.

   3. DECISIÓN + MOTOR — la decisión (perseguir, navegar, esperar, pelear, cubrir el borde)
      corre cada cfg.thinkMs, con histéresis para no cambiar de idea a cada rato. El motor corre
      CADA frame: nunca deja caminar fuera del tramo seguro de la plataforma (sin importar la
      dificultad ni cuánto tarde en "pensar"), re-verifica cada salto con el estado real justo
      antes de despegar, y corrige en el aire — o busca otra plataforma donde caer si lo
      golpearon en pleno vuelo.

   La dificultad solo cambia qué tan rápido y qué tan bien decide (reacción, puntería, rutas,
   agresividad). Nunca apaga las reglas de supervivencia del motor. */
var BotAI = (function () {
  "use strict";

  /* ---------------------------------------------------------------- dificultades */
  var DIFFICULTY = {
    easy: {
      thinkMs: 280, thinkJitter: 90, // cada cuánto re-decide (el motor de seguridad corre igual cada frame)
      reactMs: 280,                  // demora en reaccionar a un golpe o a quedar en el aire sin querer
      attackChance: 0.45,            // probabilidad de aprovechar una oportunidad de golpe en cada decisión
      whiffChance: 0.2, whiffPx: 22, // a veces tira el golpe de demasiado lejos y lo erra
      kickMix: 0.4,                  // patada "porque sí" cuando la piña convenía más
      edgeSense: 0.35,               // qué tan seguido registra que el rival está al borde y lo patea para afuera
      cornerSense: 0.3,              // qué tan seguido registra que ÉL está acorralado contra el borde
      swapChance: 0,                 // saltar por encima del rival para salir de una esquina
      dodgeChance: 0,                // retroceder ante un golpe que viene
      spacing: 30,                   // distancia a la que se para del rival antes de pegar
      // Por SEGUNDO, no por decisión: una dificultad que piensa más seguido no tiene que saltar
      // ni frenarse más seguido por eso (ver perThink()).
      hopRate: 0.05,                 // saltito "de vida" mientras se acerca de lejos
      pauseRate: 0.25,               // frenarse un momento a mitad de camino (duda)
      routeNoise: 0.6,               // cuánto se equivoca eligiendo ruta (costo de links con ruido fijo por bot)
      takeoffNoise: 0.5,             // qué tan lejos del punto de despegue ideal salta
    },
    medium: {
      thinkMs: 160, thinkJitter: 50, reactMs: 130,
      attackChance: 0.7, whiffChance: 0.07, whiffPx: 14, kickMix: 0.25,
      edgeSense: 0.75, cornerSense: 0.7, swapChance: 0.35, dodgeChance: 0.2,
      spacing: 28, hopRate: 0.08, pauseRate: 0.08,
      routeNoise: 0.25, takeoffNoise: 0.25,
    },
    hard: {
      thinkMs: 85, thinkJitter: 25, reactMs: 45,
      attackChance: 0.92, whiffChance: 0, whiffPx: 0, kickMix: 0.2,
      edgeSense: 1, cornerSense: 1, swapChance: 0.6, dodgeChance: 0.45,
      spacing: 26, hopRate: 0.1, pauseRate: 0,
      routeNoise: 0.05, takeoffNoise: 0.08,
    },
  };

  /* ---------------------------------------------------------------- constantes */
  var PREDICT_MAX_FRAMES = 240;  // 4 s de vuelo simulado: cualquier caída real termina mucho antes
  var EDGE_STOP = 3;             // el centro del cuerpo frena a 3px del borde (físicamente aguanta hasta PW afuera)
  var COMFORT_INSET = 14;        // margen para ELEGIR dónde pararse (no para frenar)
  var GUARD_INSET = 20;          // cubriendo el borde: cerca, pero no pegado
  var TAKEOFF_STEP = 6;          // resolución con que se muestrean puntos de despegue al precalcular
  var MAX_LINK_GAP = 480;        // más de esto en horizontal no lo cruza ni el doble salto
  var KIND_PENALTY = { jump: 0, drop: 4, double: 22 };
  var HOP_COST = 18;             // costo fijo por salto: a igualdad, rutas con menos saltos
  var STUCK_MS = 2400, BAN_MS = 6000;
  var JUMP_COOLDOWN_MS = 260;    // entre saltos voluntarios desde el piso (los de rescate no esperan)
  var SWAP_COOLDOWN_MS = 4000;   // entre saltos por encima del rival para salir de una esquina
  var FEINT_GAP_MS = 3000;       // un saltito "de vida" solo si hace rato que no salta
  var RESCUE_EVERY_MS = 45;

  // Tasa por segundo → probabilidad en UNA decisión (que se toma cada ~cfg.thinkMs).
  function perThink(ratePerSec, cfg) { return 1 - Math.exp(-ratePerSec * cfg.thinkMs / 1000); }

  var C = null;
  function phys() {
    if (C) return C;
    var k = Sim.getPhysicsConsts();
    C = {
      SPEED: k.SPEED, JUMP_V: k.JUMP_V, GU: k.GRAVITY_UP, GD: k.GRAVITY_DOWN,
      JUMP_V2: k.JUMP_V2 != null ? k.JUMP_V2 : k.JUMP_V / Math.SQRT2,
      MAX_JUMPS: k.MAX_JUMPS || 2, PW: k.PW || 13, W: k.W || Sim.W, H: k.H || Sim.H,
      AIR_MULT: k.AIR_SPEED_MULT || 1.35, SLOW_MULT: k.SLOW_MULT || 0.5, KB_DECAY: k.KB_DECAY || 0.88,
    };
    C.KB_SUM = C.KB_DECAY / (1 - C.KB_DECAY); // un kbx inicial termina deslizando kbx * KB_SUM píxeles
    C.MAX_RISE = (C.JUMP_V * C.JUMP_V) / (2 * C.GU) + (C.JUMP_V2 * C.JUMP_V2) / (2 * C.GU);
    return C;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

  // Ruido determinístico en [0,1): mismo bot + mismo link = mismo valor, así una ruta "mala" de
  // un bot fácil es una preferencia estable y no un cambio de idea a cada decisión.
  function hash01(n) {
    n = (n ^ 61) ^ (n >>> 16);
    n = n + (n << 3);
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967296;
  }

  /* ---------------------------------------------------------------- modelo físico */
  function speedOf(p) {
    var c = phys();
    return c.SPEED * (p.power && p.power.aire ? c.AIR_MULT : 1) * (p.slowT > 0 ? c.SLOW_MULT : 1);
  }

  function stateOf(p) {
    return {
      x: p.x, y: p.y, vy: p.vy || 0, kbx: p.kbx || 0, jumps: p.jumpsLeft,
      stunMs: p.hitStunT || 0, slowMs: p.slowT || 0, airMs: p.power && p.power.aire ? p.power.t : 0,
    };
  }

  function hazardAt(hz, x, y, PW) {
    for (var i = 0; i < hz.length; i++) {
      var h = hz[i];
      if (x + PW > h.x && x - PW < h.x + h.w && y >= h.y - 4 && y <= h.y + 6) return true;
    }
    return false;
  }

  /* Simula frame a frame (paso = dts frames de 60 fps) desde el estado `s` con una política de
     control `pol` hasta aterrizar, morir o agotar PREDICT_MAX_FRAMES:
       aimLo/aimHi   dirigirse hasta quedar dentro de ese intervalo de x (y ahí soltar)
       dir           dirección fija (si no hay aim)
       holdDir/holdUntilY  forzar esa dirección mientras y <= holdUntilY (salir de un borde)
       jumpNow       saltar en el primer frame
       jumpAtApex    segundo salto en el primer frame con vy >= 0 después de haber subido
     Devuelve { plat, x, frames, dead, solid }: plat = índice donde aterriza (-1 si no),
     dead = cae al vacío o toca una púa, solid = aterriza con el centro del cuerpo sobre la
     plataforma (no apenas colgado del borde). */
  function predict(s, pol, info, dts) {
    var c = phys(), plats = info.plats, hz = info.hazards, PW = c.PW;
    var x = s.x, y = s.y, vy = s.vy, kbx = s.kbx, jumps = s.jumps;
    var stun = s.stunMs, slow = s.slowMs, airP = s.airMs;
    var dtMs = dts * 16.6667, decay = Math.pow(c.KB_DECAY, dts);
    var jumpReq = !!pol.jumpNow, apex = !!pol.jumpAtApex, rose = !!pol.rose || vy < 0;
    var hasAim = pol.aimLo != null;
    for (var f = 1; f <= PREDICT_MAX_FRAMES; f++) {
      if (apex && rose && vy >= 0 && !jumpReq) { jumpReq = true; apex = false; }
      var dir;
      if (pol.holdDir && y <= pol.holdUntilY) dir = pol.holdDir;
      else if (hasAim) dir = x < pol.aimLo ? 1 : x > pol.aimHi ? -1 : 0;
      else dir = pol.dir || 0;
      var spd = c.SPEED * (airP > 0 ? c.AIR_MULT : 1) * (slow > 0 ? c.SLOW_MULT : 1);
      var vx = stun > 0 ? 0 : dir * spd;
      if (jumpReq && jumps > 0) { vy = jumps === c.MAX_JUMPS ? c.JUMP_V : c.JUMP_V2; jumps--; rose = true; }
      jumpReq = false;
      vy += (vy < 0 ? c.GU : c.GD) * dts;
      var prevY = y;
      y += vy * dts;
      kbx *= decay;
      if (Math.abs(kbx) < 0.05) kbx = 0;
      x += (vx + kbx) * dts;
      if (x < 14) x = 14; else if (x > c.W - 14) x = c.W - 14;
      stun -= dtMs; slow -= dtMs; airP -= dtMs;
      if (vy >= 0) {
        for (var i = 0; i < plats.length; i++) {
          var pl = plats[i];
          if (prevY <= pl.y + 1 && y >= pl.y && x + PW > pl.x && x - PW < pl.x + pl.w) {
            return { plat: i, x: x, frames: f, dead: hazardAt(hz, x, pl.y, PW), solid: x >= pl.x && x <= pl.x + pl.w };
          }
        }
      }
      if (y > c.H + 60) return { plat: -1, x: x, frames: f, dead: true, solid: false };
      if (hz.length && hazardAt(hz, x, y, PW)) return { plat: -1, x: x, frames: f, dead: true, solid: false };
    }
    return { plat: -1, x: x, frames: PREDICT_MAX_FRAMES, dead: false, solid: false };
  }

  function landsOn(r, plat) { return r.plat === plat && !r.dead; }

  // Plataforma sobre la que está parado `p` (mismo criterio de apoyo que stepPlayer), o -1.
  function platUnder(p, plats) {
    if (!p.grounded) return -1;
    var PW = phys().PW;
    for (var i = 0; i < plats.length; i++) {
      var pl = plats[i];
      if (Math.abs(pl.y - p.y) < 1 && p.x + PW > pl.x && p.x - PW < pl.x + pl.w) return i;
    }
    return -1;
  }

  /* ---------------------------------------------------------------- mapa: tramos seguros y links */
  // Tramo de x donde el CENTRO del cuerpo puede pararse sin caerse ni pisar una púa. Hazards.place
  // (world.js) siempre pega las púas a un borde, pero por las dudas se queda con el lado más largo.
  function safeSpan(pl, hz) {
    var PW = phys().PW;
    var lo = pl.x + EDGE_STOP, hi = pl.x + pl.w - EDGE_STOP;
    for (var i = 0; i < hz.length; i++) {
      var h = hz[i];
      if (pl.y < h.y - 4 || pl.y > h.y + 6) continue;
      var bLo = h.x - PW - 4, bHi = h.x + h.w + PW + 4;
      if (bHi <= lo || bLo >= hi) continue;
      if (bLo - lo >= hi - bHi) hi = Math.min(hi, bLo); else lo = Math.max(lo, bHi);
    }
    return { lo: lo, hi: hi, ok: hi - lo >= 4 };
  }

  // Intervalo al que apuntar en el aire para caer bien adentro de una plataforma.
  function aimOf(sp) {
    if (!sp.ok) return null;
    var inset = Math.min(22, (sp.hi - sp.lo) * 0.3);
    return { lo: sp.lo + inset, hi: sp.hi - inset };
  }

  function gapX(a, b) {
    if (a.x + a.w < b.x) return b.x - (a.x + a.w);
    if (b.x + b.w < a.x) return a.x - (b.x + b.w);
    return 0;
  }

  function groundState(x, y) {
    return { x: x, y: y, vy: 0, kbx: 0, jumps: phys().MAX_JUMPS, stunMs: 0, slowMs: 0, airMs: 0 };
  }

  // Tramos contiguos de despegue desde A que, saltando y dirigiéndose a B, aterrizan en B.
  function jumpRuns(info, a, b, dbl) {
    var A = info.plats[a], sa = info.spans[a], aim = info.aims[b];
    var xs = [];
    for (var x = sa.lo; x < sa.hi; x += TAKEOFF_STEP) xs.push(x);
    xs.push(sa.hi);
    var out = [], start = -1, frames = [], lands = [];
    for (var i = 0; i <= xs.length; i++) {
      var ok = false;
      if (i < xs.length) {
        var r = predict(groundState(xs[i], A.y), { aimLo: aim.lo, aimHi: aim.hi, jumpNow: true, jumpAtApex: dbl }, info, 1);
        ok = landsOn(r, b) && r.solid;
        frames[i] = r.frames;
        lands[i] = r.x;
      }
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        var mid = (start + i - 1) >> 1;
        out.push({
          from: a, to: b, kind: dbl ? "double" : "jump", side: 0,
          lo: xs[start], hi: xs[i - 1], width: xs[i - 1] - xs[start], air: frames[mid], landX: lands[mid],
        });
        start = -1;
      }
    }
    return out;
  }

  // Dejarse caer por el borde `side` de A hasta B. Nunca por un borde con púas: el tramo seguro
  // no llega hasta ese borde justamente porque hay que pisarlas para salir por ahí.
  function dropLink(info, a, b, side) {
    var c = phys(), A = info.plats[a], sa = info.spans[a], aim = info.aims[b];
    if (side < 0 ? sa.lo > A.x + EDGE_STOP + 0.5 : sa.hi < A.x + A.w - EDGE_STOP - 0.5) return null;
    var fx = side < 0 ? A.x - c.PW - 0.5 : A.x + A.w + c.PW + 0.5;
    var r = predict(groundState(fx, A.y), { aimLo: aim.lo, aimHi: aim.hi, holdDir: side, holdUntilY: A.y + 2 }, info, 1);
    if (!landsOn(r, b) || !r.solid) return null;
    var edge = side < 0 ? sa.lo : sa.hi;
    return { from: a, to: b, kind: "drop", side: side, lo: edge, hi: edge, width: 30, air: r.frames, landX: r.x };
  }

  function buildLinks(info) {
    var c = phys(), plats = info.plats, n = plats.length, links = [];
    for (var a = 0; a < n; a++) {
      var out = [];
      links.push(out);
      if (!info.spans[a].ok) continue;
      for (var b = 0; b < n; b++) {
        if (b === a || !info.spans[b].ok) continue;
        var A = plats[a], B = plats[b];
        if (A.y - B.y > c.MAX_RISE + 6 || gapX(A, B) > MAX_LINK_GAP) continue;
        var singles = jumpRuns(info, a, b, false);
        var wideSingle = singles.some(function (L) { return L.width >= 24; });
        out.push.apply(out, singles);
        // El doble salto solo se considera si el simple no alcanza con margen: es más lento y
        // gasta la red de seguridad que queda para el aire.
        if (!wideSingle) out.push.apply(out, jumpRuns(info, a, b, true));
        if (B.y > A.y + 4) {
          var dl = dropLink(info, a, b, -1), dr = dropLink(info, a, b, 1);
          if (dl) out.push(dl);
          if (dr) out.push(dr);
        }
      }
    }
    return links;
  }

  function mapSignature(plats, hz) {
    var s = plats.length * 7919 + hz.length * 104729;
    for (var i = 0; i < plats.length; i++) s += plats[i].x * 3 + plats[i].y * 5 + plats[i].w * 7 + i;
    for (var j = 0; j < hz.length; j++) s += hz[j].x * 11 + hz[j].y * 13 + hz[j].w * 17;
    return s;
  }

  /* El análisis del mapa (tramos + links) se hace una vez por mapa y lo comparten todos los
     bots. Se invalida por identidad del array de plataformas Y por firma de su contenido: si
     algún modo futuro moviera o sacara plataformas en el lugar, el bot no seguiría usando un
     grafo viejo con índices que ya no existen. */
  var mapInfo = null, mapSerial = 0;
  function getMapInfo(map) {
    var plats = map.platforms, hz = map.hazards || [];
    var sig = mapSignature(plats, hz);
    if (mapInfo && mapInfo.plats === plats && mapInfo.sig === sig) return mapInfo;
    var info = { plats: plats, hazards: hz, sig: sig, id: ++mapSerial, spans: [], aims: [], links: null };
    for (var i = 0; i < plats.length; i++) {
      var sp = safeSpan(plats[i], hz);
      info.spans.push(sp);
      info.aims.push(aimOf(sp));
    }
    info.links = buildLinks(info);
    // Vista plana de todos los links (índice L.idx) + qué links llegan a cada plataforma: es el
    // grafo sobre el que corre linkValues().
    info.all = []; info.into = [];
    for (var p = 0; p < plats.length; p++) info.into.push([]);
    info.links.forEach(function (ls) {
      ls.forEach(function (L) { L.idx = info.all.length; info.all.push(L); info.into[L.to].push(L.idx); });
    });
    mapInfo = info;
    return info;
  }

  /* ---------------------------------------------------------------- rutas */
  function linkKey(L) { return L.from + ">" + L.to + ":" + L.kind + ":" + Math.round(L.lo) + ":" + L.side; }
  function isBanned(st, L) { var u = st.banned[linkKey(L)]; return u !== undefined && u > st.t; }

  function linkCost(L, id, cfg) {
    // Un tramo de despegue angosto pide precisión: se paga como riesgo.
    var risk = L.width >= 30 ? 0 : (30 - L.width) * 1.1;
    var kindN = L.kind === "double" ? 3 : L.kind === "drop" ? 6 + L.side : 0;
    var noise = 1 + cfg.routeNoise * hash01(id * 7919 + L.from * 131 + L.to * 17 + kindN + Math.round(L.lo));
    return (L.air + KIND_PENALTY[L.kind] + risk + HOP_COST) * noise;
  }

  function walkFrames(x, L, info) {
    var d = L.kind === "drop" ? Math.abs(x - (L.side < 0 ? info.spans[L.from].lo : info.spans[L.from].hi)) : distToInterval(x, L.lo, L.hi);
    return d / phys().SPEED;
  }

  /* Costo (en frames) de llegar a `goal` DESPUÉS de haber tomado cada link: V[L.idx]. Es un
     Dijkstra hacia atrás sobre links y no sobre plataformas porque así cuenta también lo que se
     camina en cada plataforma intermedia (desde donde aterriza un salto hasta donde despega el
     siguiente). Con costos por plataforma eso quedaba afuera, y como el primer tramo sí se
     contaba caminando, el bot podía preferir volver a la plataforma de la que venía y rebotar
     entre dos para siempre. */
  function linkValues(info, goal, st, id, cfg) {
    var all = info.all, n = all.length, V = [], done = [];
    for (var i = 0; i < n; i++) { V.push(all[i].to === goal && !isBanned(st, all[i]) ? 0 : Infinity); done.push(false); }
    for (var it = 0; it < n; it++) {
      var u = -1;
      for (var k = 0; k < n; k++) if (!done[k] && V[k] < Infinity && (u < 0 || V[k] < V[u])) u = k;
      if (u < 0) break;
      done[u] = true;
      var M = all[u], through = linkCost(M, id, cfg) + V[u];
      var preds = info.into[M.from];
      for (var j = 0; j < preds.length; j++) {
        var J = all[preds[j]];
        if (done[J.idx] || J.to === goal || isBanned(st, J)) continue;
        var d = walkFrames(J.landX, M, info) + through;
        if (d < V[J.idx]) V[J.idx] = d;
      }
    }
    return V;
  }

  // Costo para llegar a `goal` estando parado en `p` a la altura `x` (Infinity = no hay ruta).
  function costFrom(st, info, p, x) {
    if (!st.V || p < 0) return Infinity;
    if (p === st.objPlat) return 0;
    var best = Infinity, ls = info.links[p];
    for (var j = 0; j < ls.length; j++) {
      var L = ls[j];
      if (isBanned(st, L) || !(st.V[L.idx] < Infinity)) continue;
      var c = walkFrames(x, L, info) + linkCost(L, st.id, st.cfg) + st.V[L.idx];
      if (c < best) best = c;
    }
    return best;
  }

  function reachableFrom(info, from, st) {
    var seen = [], stack = [from];
    for (var i = 0; i < info.plats.length; i++) seen.push(false);
    seen[from] = true;
    while (stack.length) {
      var u = stack.pop(), ls = info.links[u];
      for (var j = 0; j < ls.length; j++) {
        var L = ls[j];
        if (!seen[L.to] && !isBanned(st, L)) { seen[L.to] = true; stack.push(L.to); }
      }
    }
    return seen;
  }

  function distToInterval(x, lo, hi) { return x < lo ? lo - x : x > hi ? x - hi : 0; }

  // Mejor primer salto desde P considerando dónde está parado AHORA (caminar también cuesta).
  function chooseLink(st, info, P, x) {
    var best = null, bestCost = Infinity, curCost = Infinity;
    var ls = info.links[P];
    for (var j = 0; j < ls.length; j++) {
      var L = ls[j];
      if (isBanned(st, L) || !(st.V[L.idx] < Infinity)) continue;
      var cost = walkFrames(x, L, info) + linkCost(L, st.id, st.cfg) + st.V[L.idx];
      if (cost < bestCost) { bestCost = cost; best = L; }
      if (L === st.link) curCost = cost;
    }
    // Histéresis: no abandonar el plan en curso por una alternativa apenas mejor.
    if (st.link && curCost <= bestCost * 1.2 + 6) return st.link;
    return best;
  }

  function pickTakeoff(L, x, cfg) {
    if (L.kind === "drop") return null;
    var margin = Math.min(L.width / 2, 10);
    var t = clamp(x, L.lo + margin, L.hi - margin);
    t += (Math.random() - 0.5) * L.width * cfg.takeoffNoise;
    return clamp(t, L.lo, L.hi);
  }

  // Sin ruta hasta el rival: la plataforma alcanzable que deja más cerca de él.
  function pickHoldPlat(st, info, P, tgt) {
    var reach = reachableFrom(info, P, st);
    var best = P, bestScore = Infinity, curScore = Infinity;
    for (var i = 0; i < info.plats.length; i++) {
      if (!reach[i] || !info.spans[i].ok) continue;
      var sp = info.spans[i];
      var nx = clamp(tgt.x, sp.lo, sp.hi);
      var score = Math.abs(nx - tgt.x) + Math.abs(info.plats[i].y - tgt.y) * 0.6 + (i === P ? 0 : 40);
      if (score < bestScore) { bestScore = score; best = i; }
      if (i === st.holdPlat) curScore = score;
    }
    if (st.holdPlat >= 0 && st.holdPlat < reach.length && reach[st.holdPlat] && curScore <= bestScore + 40) best = st.holdPlat;
    st.holdPlat = best;
    return best;
  }

  function clampToSpan(x, info, P, inset) {
    var sp = info.spans[P];
    var lo = sp.lo + inset, hi = sp.hi - inset;
    if (lo > hi) return (sp.lo + sp.hi) / 2;
    return clamp(x, lo, hi);
  }

  /* ---------------------------------------------------------------- estado por bot */
  var states = {};
  function newState() {
    return {
      t: 0, thinkT: 0, dtEma: 16.6667, mapId: 0,
      intent: { kind: "idle" }, link: null, takeoffX: null, verifyFails: 0, dropOk: false,
      air: null, rescueT: -1e9, rescueDir: 0,
      id: 0, cfg: null, objPlat: -1, V: null, holding: false, holdPlat: -1, lastTargetPlat: -1,
      banned: {}, lastJumpT: -1e9, landT: 0, wasGrounded: false,
      reactUntil: 0, lastStun: 0, lastDir: 0,
      pendingAttack: null, pauseUntil: 0, flipUntil: 0, flipSide: 0, side: 1, lastSwapT: -1e9,
      progressKey: "", bestProgress: Infinity, progressT: 0,
      state: "IDLE", errorLogged: false,
    };
  }
  function getState(id) { return states[id] || (states[id] = newState()); }

  function resetNav(st, mapId) {
    st.mapId = mapId;
    st.intent = { kind: "idle" }; st.link = null; st.takeoffX = null; st.air = null;
    st.objPlat = -1; st.V = null; st.holdPlat = -1; st.lastTargetPlat = -1;
    st.banned = {}; st.progressKey = ""; st.pendingAttack = null;
  }

  function failLink(st, L) {
    st.banned[linkKey(L)] = st.t + BAN_MS;
    st.link = null; st.takeoffX = null;
    st.intent = { kind: "idle" };
    st.thinkT = 0; // re-planificar ya, no esperar a la próxima decisión
  }

  /* ---------------------------------------------------------------- percepción del objetivo */
  // Dónde está (o va a estar) el rival: su plataforma si está parado; si está en el aire, dónde
  // aterriza manteniendo lo que tiene apretado. offstage = esa trayectoria termina en el vacío.
  function targetInfo(me, info) {
    if (me.grounded) return { plat: platUnder(me, info.plats), x: me.x, y: me.y, offstage: false };
    var inp = me.input || {};
    var dir = inp.left && !inp.right ? -1 : inp.right && !inp.left ? 1 : 0;
    var r = predict(stateOf(me), { dir: dir }, info, 1);
    if (landsOn(r, r.plat) && r.plat >= 0) return { plat: r.plat, x: r.x, y: info.plats[r.plat].y, offstage: false };
    return { plat: -1, x: me.x, y: me.y, offstage: !!r.dead };
  }

  function allyAhead(players, ai, tgt, side) {
    var myD = (ai.x - tgt.x) * side;
    for (var k in players) {
      var o = players[k];
      if (!o || o === ai || !o.alive || !o.isBot || Math.abs(o.y - ai.y) > 4) continue;
      var d = (o.x - tgt.x) * side;
      if (d > 0 && d < myD) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- decisión */
  function think(id, st, ai, me, info, cfg, players) {
    if (st.pendingAttack && st.pendingAttack.until <= st.t) st.pendingAttack = null;
    var P = platUnder(ai, info.plats);

    if (!me) {
      st.objPlat = -1; st.V = null; st.link = null;
      st.intent = P >= 0 ? { kind: "idle", goalX: clampToSpan(ai.x, info, P, COMFORT_INSET) } : { kind: "idle" };
      if (P >= 0) st.state = "IDLE";
      return;
    }

    var tgt = targetInfo(me, info);
    var objPlat = tgt.plat >= 0 ? tgt.plat : st.lastTargetPlat;
    if (tgt.plat >= 0) st.lastTargetPlat = tgt.plat;
    if (objPlat >= info.plats.length) objPlat = -1;
    st.objPlat = objPlat;
    st.V = objPlat >= 0 ? linkValues(info, objPlat, st, id, cfg) : null;
    st.holding = false;
    if (st.V && P >= 0 && !(costFrom(st, info, P, ai.x) < Infinity)) {
      // No hay forma segura de llegar: acercarse lo que se pueda y esperar, no tirarse.
      var hp = pickHoldPlat(st, info, P, tgt);
      st.holding = true;
      if (hp !== objPlat) { objPlat = st.objPlat = hp; st.V = linkValues(info, hp, st, id, cfg); }
    }

    considerAttack(st, ai, me, info, cfg, tgt);

    if (P < 0) { st.state = st.air && st.air.rescue ? "RECOVER" : "IN_AIR"; return; }

    if (tgt.offstage) {
      // El rival va camino al vacío: no perseguirlo afuera. Esperar en el borde por si vuelve.
      st.intent = { kind: "guard", goalX: clampToSpan(me.x, info, P, GUARD_INSET) };
      st.state = "EDGE_GUARD";
    } else if (objPlat < 0 || (objPlat === P && st.holding)) {
      st.intent = { kind: "hold", goalX: clampToSpan(tgt.x, info, P, COMFORT_INSET) };
      st.state = "HOLD";
    } else if (objPlat === P) {
      combatIntent(st, ai, me, tgt, P, info, cfg, players);
    } else {
      var L = chooseLink(st, info, P, ai.x);
      if (L) {
        if (L !== st.link) { st.link = L; st.takeoffX = pickTakeoff(L, ai.x, cfg); st.verifyFails = 0; st.dropOk = false; }
        st.intent = { kind: "navigate" };
        st.state = "NAVIGATE";
      } else {
        st.intent = { kind: "hold", goalX: clampToSpan(tgt.x, info, P, COMFORT_INSET) };
        st.state = "HOLD";
      }
    }
    if (st.intent.kind !== "navigate") st.link = null;
    watchProgress(st, ai, info, P);
  }

  function combatIntent(st, ai, me, tgt, P, info, cfg, players) {
    var A = Sim.getAttacks(), c = phys(), pl = info.plats[P];
    var dx = tgt.x - ai.x, adx = Math.abs(dx);
    var side = adx > 6 ? (dx < 0 ? 1 : -1) : st.side; // +1 = estoy a la derecha del rival
    if (st.flipUntil > st.t) side = st.flipSide;
    st.side = side;

    var kickPush = A.kick.kbX * c.KB_SUM + A.kick.reach;
    // Lo que le queda al rival detrás suyo (hacia donde lo empuja mi golpe) y a mí detrás mío,
    // medido hasta donde uno realmente se cae (el cuerpo aguanta PW colgado del borde).
    var targetRoom = side > 0 ? tgt.x - (pl.x - c.PW) : (pl.x + pl.w + c.PW) - tgt.x;
    var myRoom = side > 0 ? (pl.x + pl.w + c.PW) - ai.x : ai.x - (pl.x - c.PW);

    var spacing = cfg.spacing;
    if (allyAhead(players, ai, tgt, side)) spacing += 38; // otro NPC ya está encima: no apilarse

    // Acorralado: tengo el vacío a la espalda, el rival del lado de adentro, mirándome y en
    // rango — una patada suya me saca. Salir por arriba (saltarlo, verificado) o, si no se
    // puede, pelear pegado en vez de retroceder hacia el borde. Sin el "mirándome y en rango"
    // esto se cumplía casi siempre en plataformas angostas (el empuje de la patada del build web
    // es de ~150px) y el bot se la pasaba saltando por encima del rival.
    var threatened = me.facing === side && adx < A.kick.reach + 40;
    var cornered = threatened && myRoom < kickPush * 0.6 && targetRoom > myRoom + 40;
    if (cornered && Math.random() < cfg.cornerSense) {
      // SWAP_COOLDOWN_MS: sin esto, del otro lado puede volver a quedar "acorralado" enseguida y
      // encadenar saltos por encima del rival de ida y vuelta.
      if (Math.random() < cfg.swapChance && st.t - st.lastSwapT > SWAP_COOLDOWN_MS) {
        var land = tgt.x - side * 60;
        var sp = info.spans[P];
        if (land - 14 >= sp.lo + COMFORT_INSET && land + 14 <= sp.hi - COMFORT_INSET) {
          st.lastSwapT = st.t;
          st.intent = { kind: "hop", aimLo: land - 14, aimHi: land + 14, until: st.t + 300 };
          st.state = "REPOSITION";
          return;
        }
      }
      spacing = Math.min(spacing, 16);
    }
    // Rival al borde: oportunidad de sacarlo — presionar (la patada se elige en considerAttack).
    if (targetRoom < kickPush && Math.random() < cfg.edgeSense) spacing = Math.min(spacing, A.kick.reach - 14);

    var goal;
    if (me.attack && me.facing === side && adx < A.kick.reach + 16 && ai.attackCooldown > 80 &&
        myRoom > kickPush && Math.random() < cfg.dodgeChance) {
      goal = ai.x + side * 40; // un golpe viene y no puedo contestar: paso atrás (hay lugar)
      st.state = "RETREAT";
    } else if (st.pauseUntil > st.t) {
      goal = ai.x;
      st.state = "CHASE";
    } else if (adx > 120 && Math.random() < perThink(cfg.pauseRate, cfg)) {
      st.pauseUntil = st.t + 250 + Math.random() * 350;
      goal = ai.x;
      st.state = "CHASE";
    } else {
      goal = tgt.x + side * spacing;
      st.state = adx <= A.kick.reach + 6 ? "ATTACK" : "CHASE";
      if (adx > 110 && st.t - st.lastJumpT > FEINT_GAP_MS && Math.random() < perThink(cfg.hopRate, cfg)) {
        var hx = ai.x - side * 70; // saltito hacia el rival, sin pasarse
        st.intent = { kind: "hop", aimLo: hx - 12, aimHi: hx + 12, until: st.t + 200 };
        return;
      }
    }
    st.intent = { kind: "chase", goalX: clampToSpan(goal, info, P, COMFORT_INSET) };
  }

  function considerAttack(st, ai, me, info, cfg, tgt) {
    if (ai.attack || ai.attackCooldown > 90 || st.pendingAttack || st.t < st.reactUntil) return;
    var A = Sim.getAttacks(), c = phys();
    var dx = me.x - ai.x, adx = Math.abs(dx);
    if (Math.abs(me.y - ai.y - 10) >= 56) return; // mismo alcance vertical que stepPlayer (dy < 60)
    var slack = Math.random() < cfg.whiffChance ? cfg.whiffPx : 0;
    if (adx > A.kick.reach - 4 + slack) return;
    if (Math.random() > cfg.attackChance) return;

    var pl = me.grounded && tgt.plat >= 0 ? info.plats[tgt.plat] : null;
    var nearEdge = true; // en el aire, una patada lo aleja de donde quiere volver
    if (pl) {
      var room = dx > 0 ? (pl.x + pl.w + c.PW) - me.x : me.x - (pl.x - c.PW);
      nearEdge = room < A.kick.kbX * c.KB_SUM + 24;
    }
    var type;
    if (adx > A.punch.reach - 3) type = "kick";
    else if (nearEdge && Math.random() < cfg.edgeSense) type = "kick";
    else type = Math.random() < cfg.kickMix ? "kick" : "punch";
    st.pendingAttack = { type: type, until: st.t + 240 };
  }

  // Si no hay progreso hacia la meta en STUCK_MS, cambiar de estrategia en vez de insistir.
  function watchProgress(st, ai, info, P) {
    var it = st.intent, metric;
    var key = it.kind + ":" + (st.link ? linkKey(st.link) : "") + ":" + st.objPlat;
    if (it.kind === "navigate") {
      var cf = costFrom(st, info, P, ai.x); // incluye lo que falta caminar hasta el despegue
      metric = cf < Infinity ? cf * 10 : 0;
    } else if (it.goalX != null) {
      var gap = Math.abs(ai.x - it.goalX);
      metric = gap <= 8 ? -1 : gap; // ya llegó: no hay atasco que medir
    } else metric = -1;

    if (key !== st.progressKey || metric < 0) {
      st.progressKey = key; st.bestProgress = metric < 0 ? Infinity : metric; st.progressT = st.t;
      return;
    }
    if (metric < st.bestProgress - 3) { st.bestProgress = metric; st.progressT = st.t; return; }
    if (st.t - st.progressT < STUCK_MS) return;

    st.progressT = st.t; st.bestProgress = Infinity;
    if (it.kind === "navigate" && st.link) failLink(st, st.link);
    else if (it.kind === "chase") { st.flipSide = -st.side; st.flipUntil = st.t + 2500; }
    st.state = "UNSTUCK";
  }

  /* ---------------------------------------------------------------- motor: en el piso */
  function seek(x, goal, st, dead) {
    var d = goal - x;
    // Si ya venía caminando hacia la meta, sigue hasta pasarla por poco; si estaba quieto, solo
    // arranca fuera de la zona muerta. Evita el temblequeo izquierda/derecha sobre la meta.
    if (st.lastDir !== 0 && sign(d) === st.lastDir && Math.abs(d) > 1.5) return st.lastDir;
    if (Math.abs(d) <= dead) return 0;
    return sign(d);
  }

  function aimDir(x, lo, hi) { return x < lo ? 1 : x > hi ? -1 : 0; }

  function standableElsewhere(info, P, x, y) {
    for (var i = 0; i < info.plats.length; i++) {
      if (i === P || Math.abs(info.plats[i].y - y) >= 1) continue;
      var sp = info.spans[i];
      if (sp.ok && x >= sp.lo && x <= sp.hi) return true;
    }
    return false;
  }

  /* La regla que ninguna dificultad puede saltearse: un paso que saca el centro del cuerpo del
     tramo seguro (borde o púa) no se da. Se evalúa cada frame con el paso real de ese frame,
     así que no hay "ventana ciega" entre decisiones. allowSide = la única salida autorizada: un
     drop o un salto ya verificados por simulación. */
  function groundSafeDir(st, ai, info, P, dir, dts, allowSide) {
    if (!dir || dir === allowSide || P < 0) return dir;
    var sp = info.spans[P];
    var nx = ai.x + (dir * speedOf(ai) + (ai.kbx || 0)) * dts;
    if (sp.ok && nx >= sp.lo && nx <= sp.hi) return dir;
    if ((dir > 0 && ai.x < sp.lo) || (dir < 0 && ai.x > sp.hi)) return dir; // volviendo hacia adentro
    if (standableElsewhere(info, P, nx, info.plats[P].y)) return dir;
    st.state = "AVOID_FALL";
    return 0;
  }

  // Un golpe me está deslizando hacia afuera: caminar en contra apenas el hitstun lo permite.
  function knockbackCounter(st, ai, info, P) {
    var kb = ai.kbx || 0;
    if (Math.abs(kb) < 0.3 || ai.hitStunT > 0) return 0;
    var sp = info.spans[P];
    var fx = ai.x + kb * phys().KB_SUM;
    if (fx >= sp.lo && fx <= sp.hi) return 0;
    if (standableElsewhere(info, P, fx, info.plats[P].y)) return 0;
    st.state = "AVOID_FALL";
    return kb > 0 ? -1 : 1;
  }

  function navStep(st, ai, info, dts, P, out) {
    var c = phys(), L = st.link, aim = info.aims[L.to], pl = info.plats[P];
    if (!aim) { failLink(st, L); return; }

    if (L.kind === "drop") {
      var sp = info.spans[P];
      out.dir = L.side;
      var nx = ai.x + L.side * speedOf(ai) * dts;
      if ((L.side > 0 && nx > sp.hi) || (L.side < 0 && nx < sp.lo)) {
        // Por salir del tramo seguro: recién acá se confirma, con el estado real, que la caída
        // termina en la plataforma de destino. Si no, no se sale.
        if (!st.dropOk) {
          var s = stateOf(ai);
          s.x = L.side < 0 ? pl.x - c.PW - 0.5 : pl.x + pl.w + c.PW + 0.5;
          s.vy = 0;
          var r = predict(s, { aimLo: aim.lo, aimHi: aim.hi, holdDir: L.side, holdUntilY: pl.y + 2 }, info, dts);
          st.dropOk = landsOn(r, L.to);
          if (!st.dropOk) { out.dir = 0; if (!(ai.slowT > 0)) failLink(st, L); return; }
        }
        st.air = { target: L.to, aimLo: aim.lo, aimHi: aim.hi, holdDir: L.side, holdUntilY: pl.y + 2, jumpAtApex: false, rose: false, rescue: false };
      }
      return;
    }

    // Salto: caminar hasta el punto de despegue, verificar con el estado REAL y recién ahí saltar.
    var tx = st.takeoffX != null ? st.takeoffX : clamp(ai.x, L.lo, L.hi);
    if (Math.abs(ai.x - tx) > 5) { out.dir = seek(ai.x, tx, st, 2); return; }
    if (st.t - st.lastJumpT < JUMP_COOLDOWN_MS || st.t - st.landT < 50) return;
    var dbl = L.kind === "double";
    var rj = predict(stateOf(ai), { aimLo: aim.lo, aimHi: aim.hi, jumpNow: true, jumpAtApex: dbl }, info, dts);
    if (landsOn(rj, L.to)) {
      out.jump = true;
      out.dir = aimDir(ai.x, aim.lo, aim.hi);
      st.air = { target: L.to, aimLo: aim.lo, aimHi: aim.hi, jumpAtApex: dbl, rose: true, rescue: false };
      st.state = "JUMP";
      return;
    }
    if (ai.slowT > 0) return; // lento por hielo: esperar a que se pase, el link no tiene la culpa
    st.verifyFails++;
    if (st.verifyFails % 10 === 0) st.takeoffX = L.lo + Math.random() * L.width; // probar otro punto del tramo
    if (st.verifyFails >= 40) failLink(st, L);
  }

  function hopStep(st, ai, info, P, dts, out) {
    var it = st.intent;
    st.intent = { kind: "idle" }; // un solo intento, salga o no
    if (it.until < st.t || st.t - st.lastJumpT < JUMP_COOLDOWN_MS) return;
    var r = predict(stateOf(ai), { aimLo: it.aimLo, aimHi: it.aimHi, jumpNow: true }, info, dts);
    if (!landsOn(r, P) || !r.solid) return;
    out.jump = true;
    out.dir = aimDir(ai.x, it.aimLo, it.aimHi);
    st.air = { target: P, aimLo: it.aimLo, aimHi: it.aimHi, jumpAtApex: false, rose: true, rescue: false };
    st.state = "JUMP";
  }

  function groundMotor(st, ai, info, dts) {
    var P = platUnder(ai, info.plats);
    var out = { dir: 0, jump: false, attack: null };
    st.air = null; // cualquier plan de vuelo se arma de nuevo abajo si corresponde
    if (P < 0) return out;
    var allowSide = 0;
    if (st.t >= st.reactUntil) {
      var it = st.intent;
      if (it.kind === "navigate" && st.link && st.link.from === P) {
        navStep(st, ai, info, dts, P, out);
        if (st.link && st.link.kind === "drop" && st.dropOk) allowSide = st.link.side;
      } else if (it.kind === "hop") {
        hopStep(st, ai, info, P, dts, out);
      } else if (it.goalX != null) {
        out.dir = seek(ai.x, it.goalX, st, 5);
      }
    }
    if (out.jump) allowSide = out.dir; // el salto ya se verificó con esta dirección
    out.dir = groundSafeDir(st, ai, info, P, out.dir, dts, allowSide);
    var counter = knockbackCounter(st, ai, info, P);
    if (counter) out.dir = counter;
    return out;
  }

  /* ---------------------------------------------------------------- motor: en el aire */
  function airDir(ai, air) {
    if (air.holdDir && ai.y <= air.holdUntilY) return air.holdDir;
    return aimDir(ai.x, air.aimLo, air.aimHi);
  }

  function airPol(air, jumpNow, noApex) {
    return {
      aimLo: air.aimLo, aimHi: air.aimHi, holdDir: air.holdDir, holdUntilY: air.holdUntilY,
      jumpNow: jumpNow, jumpAtApex: !noApex && !jumpNow && air.jumpAtApex, rose: air.rose,
    };
  }

  function airMotor(st, ai, info, dts) {
    // Reacción: recién golpeado (o en el aire sin haberlo decidido) sigue con lo que tenía
    // apretado hasta "darse cuenta". Acá es donde un bot fácil pierde partidas de verdad.
    if (st.t < st.reactUntil) return { dir: st.lastDir, jump: false, attack: null };
    var s = stateOf(ai), air = st.air;
    if (air && air.target >= info.plats.length) air = st.air = null;
    if (air) {
      if (ai.vy < 0) air.rose = true;
      var dir = airDir(ai, air);
      var r0 = predict(s, airPol(air, false, false), info, dts);
      if (landsOn(r0, air.target)) {
        var jump = false;
        if (air.jumpAtApex && air.rose && ai.vy >= 0 && ai.jumpsLeft > 0) {
          // En el ápice: ¿el segundo salto hace falta de verdad? Si no, se guarda para emergencias.
          air.jumpAtApex = false;
          jump = !landsOn(predict(s, airPol(air, false, true), info, dts), air.target);
        }
        st.state = air.rescue ? "RECOVER" : "IN_AIR";
        return { dir: dir, jump: jump, attack: null };
      }
      if (ai.jumpsLeft > 0 && landsOn(predict(s, airPol(air, true, true), info, dts), air.target)) {
        air.jumpAtApex = false;
        st.state = "RECOVER";
        return { dir: dir, jump: true, attack: null };
      }
    }
    return rescue(st, ai, info, s, dts);
  }

  /* El plan de vuelo ya no aterriza en ningún lado seguro (lo golpearon, lo empujaron, se cayó
     de un borde): probar todas las plataformas con y sin el salto que le queda, y quedarse con
     la que aterriza con seguridad y mejor lo deja respecto de su objetivo. */
  function rescue(st, ai, info, s, dts) {
    if (st.t - st.rescueT < RESCUE_EVERY_MS) {
      return { dir: st.air ? airDir(ai, st.air) : st.rescueDir, jump: false, attack: null };
    }
    st.rescueT = st.t;
    var c = phys(), plats = info.plats, best = null;
    var opts = ai.jumpsLeft > 0 ? (s.vy < -1 ? ["none", "now", "apex"] : ["none", "now"]) : ["none"];
    for (var i = 0; i < plats.length; i++) {
      var aim = info.aims[i];
      if (!aim || plats[i].y < ai.y - c.MAX_RISE - 10) continue;
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var r = predict(s, { aimLo: aim.lo, aimHi: aim.hi, jumpNow: o === "now", jumpAtApex: o === "apex", rose: s.vy < 0 }, info, dts);
        if (r.plat < 0 || r.dead) continue;
        var d = costFrom(st, info, r.plat, r.x);
        if (!(d < Infinity)) d = 400;
        var score = d + (o === "none" ? 0 : 30) + r.frames * 0.25 + (r.solid ? 0 : 25);
        if (!best || score < best.score) best = { score: score, aim: aim, opt: o, plat: r.plat };
      }
    }
    st.state = "RECOVER";
    if (best) {
      st.air = {
        target: best.plat, aimLo: best.aim.lo, aimHi: best.aim.hi, jumpAtApex: best.opt === "apex",
        rose: s.vy < 0 || best.opt === "now", rescue: true,
      };
      st.rescueDir = airDir(ai, st.air);
      return { dir: st.rescueDir, jump: best.opt === "now", attack: null };
    }
    // Nada seguro todavía: ir hacia la plataforma más cercana en horizontal y estirar el vuelo
    // con el salto que quede una vez pasado el ápice. En los próximos frames se vuelve a buscar.
    st.air = null;
    var nearest = -1, nd = Infinity;
    for (var j = 0; j < plats.length; j++) {
      var sp = info.spans[j];
      if (!sp.ok || plats[j].y < ai.y - 40) continue;
      var dd = distToInterval(ai.x, sp.lo, sp.hi);
      if (dd < nd) { nd = dd; nearest = j; }
    }
    st.rescueDir = nearest >= 0 ? aimDir(ai.x, info.spans[nearest].lo, info.spans[nearest].hi) : 0;
    return { dir: st.rescueDir, jump: ai.jumpsLeft > 0 && s.vy >= 0, attack: null };
  }

  /* ---------------------------------------------------------------- golpe */
  function attackMotor(st, ai, me, info, out, dts) {
    var pa = st.pendingAttack;
    if (!pa || !me) return out;
    if (pa.until <= st.t) { st.pendingAttack = null; return out; }
    if (ai.attack || ai.attackCooldown > 0 || st.t < st.reactUntil) return out;
    var dx = me.x - ai.x, want = dx >= 0 ? 1 : -1;
    if (Math.abs(dx) > 3 && ai.facing !== want) {
      // El golpe sale para donde mira: primero un frame hacia el rival para darse vuelta. En el
      // aire no, que ese frame puede arruinar un aterrizaje justo.
      if (!ai.grounded || ai.hitStunT > 0 || out.jump) return out;
      var turn = groundSafeDir(st, ai, info, platUnder(ai, info.plats), want, dts, 0);
      if (turn) out.dir = turn;
      return out;
    }
    out.attack = pa.type;
    st.pendingAttack = null;
    return out;
  }

  /* ---------------------------------------------------------------- API */
  function release(id) {
    Sim.handleInput(id, "left", false);
    Sim.handleInput(id, "right", false);
  }

  function apply(id, st, out) {
    var dir = out.dir || 0;
    Sim.handleInput(id, "left", dir < 0);
    Sim.handleInput(id, "right", dir > 0);
    if (out.jump) { Sim.handleInput(id, "jump", true); st.lastJumpT = st.t; }
    if (out.attack) Sim.handleInput(id, out.attack, true);
    st.lastDir = dir;
  }

  function tickInner(id, targetId, dt, cfg, st) {
    var players = Sim.getPlayers();
    var ai = players[id];
    if (!ai) return;
    st.id = id; st.cfg = cfg;
    if (!(dt >= 0)) dt = 16.6667;
    dt = Math.min(dt, 100);
    st.t += dt;
    st.dtEma += (dt - st.dtEma) * 0.1;

    if (!ai.alive) {
      release(id);
      st.state = "DEAD"; st.intent = { kind: "idle" }; st.air = null; st.link = null; st.pendingAttack = null;
      return;
    }
    var map = Sim.getCurrentMap();
    if (!map || !map.platforms || !map.platforms.length) { release(id); return; }
    var info = getMapInfo(map);
    if (st.mapId !== info.id) resetNav(st, info.id);

    var me = players[targetId];
    if (me && !me.alive) me = null;

    var stun = ai.hitStunT || 0;
    if (stun > st.lastStun + 1) st.reactUntil = st.t + cfg.reactMs;
    st.lastStun = stun;
    if (ai.grounded && !st.wasGrounded) {
      st.landT = st.t; st.air = null;
      st.thinkT = Math.min(st.thinkT, cfg.thinkMs * 0.35); // recién aterrizado: reorientarse pronto
    }
    if (!ai.grounded && st.wasGrounded && !st.air) st.reactUntil = Math.max(st.reactUntil, st.t + cfg.reactMs);
    st.wasGrounded = ai.grounded;

    st.thinkT -= dt;
    if (st.thinkT <= 0) {
      st.thinkT = Math.max(40, cfg.thinkMs + (Math.random() * 2 - 1) * cfg.thinkJitter);
      think(id, st, ai, me, info, cfg, players);
    }

    var dts = clamp(st.dtEma / 16.6667, 0.25, 2.5);
    var out = ai.grounded ? groundMotor(st, ai, info, dts) : airMotor(st, ai, info, dts);
    out = attackMotor(st, ai, me, info, out, dts);
    apply(id, st, out);
  }

  /* Un frame de un bot. La IA nunca puede tirar abajo el juego: cualquier excepción suelta las
     teclas del bot, descarta su plan y se reporta una sola vez por consola. */
  function tick(id, targetId, dt, cfg) {
    var st = getState(id);
    try {
      tickInner(id, targetId, dt, cfg || DIFFICULTY.medium, st);
    } catch (e) {
      try { release(id); } catch (e2) { /* Sim en un estado raro: nada más que hacer */ }
      st.intent = { kind: "idle" }; st.air = null; st.link = null; st.pendingAttack = null;
      if (!st.errorLogged) { st.errorLogged = true; console.warn("BotAI:", e); }
    }
  }

  // Olvida todo el estado de los bots (nuevo nivel / nueva partida).
  function reset() { states = {}; }

  // Solo diagnóstico (consola): qué está pensando un bot.
  function inspect(id) {
    var st = states[id];
    if (!st) return null;
    return {
      state: st.state, intent: st.intent.kind, objPlat: st.objPlat, holding: st.holding,
      link: st.link ? linkKey(st.link) : null, airTarget: st.air ? st.air.target : null,
      takeoffX: st.takeoffX, verifyFails: st.verifyFails,
      banned: Object.keys(st.banned).filter(function (k) { return st.banned[k] > st.t; }),
    };
  }

  return { DIFFICULTY: DIFFICULTY, tick: tick, reset: reset, inspect: inspect };
})();
