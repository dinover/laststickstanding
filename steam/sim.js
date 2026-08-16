/* Host-authoritative simulation for the Steam build of Last Stick Standing.
   This is a fresh port of screen.html's V2 gameplay (rounds, procedural maps, punch/kick,
   power orbs, snail mode) into a transport-agnostic module: no ac.* / FreeConsole calls
   anywhere. The host (see game.html) drives Sim directly every frame; guests only ever call
   Sim.applyGuestFrame() with whatever snapshot net-steam.js last delivered.

   Deliberately NOT shared with screen.html — screen.html keeps working untouched. This is a
   parallel copy so the FreeConsole build can never be affected by anything here.

   Depends on the same globals screen.html already relies on: World, Particles, Camera,
   HitStop, ScreenFX, Trails, POWER_COLORS, drawStickman (stickman.js), AudioManager
   (audio.js) — all loaded via <script> before this file in game.html. */
var Sim = (function () {
  "use strict";

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var W = 960, H = 540;
  var GRAVITY_UP = 0.95, GRAVITY_DOWN = 0.7, SPEED = 4.3, JUMP_V = -20.5;
  var PW = 13, PH = 52;
  var PUNCH_MS = 230, KICK_MS = 280, ATTACK_COOLDOWN = 380;

  var ORB_SPAWN_MS = 10000, ORB_POWER_MS = 8000, ORB_PICKUP_R = 28;
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

  function genMap(seed) {
    return World.generateMap(seed, { SPEED: SPEED, JUMP_V: JUMP_V, GRAVITY_UP: GRAVITY_UP, GRAVITY_DOWN: GRAVITY_DOWN, W: W, H: H });
  }

  var colorFor = function (id) { return "#35f0e0"; };
  var nameFor = function (id) { return "Jugador " + id; };
  var onPhaseChange = function () {};

  /* ---------------------------------------------------------------- state (host) */
  var phase = "lobby"; // lobby | fightIntro | fight | roundEnd | final
  var currentMap = MAP0;
  var currentRound = 0, totalRounds = 3;
  var roster = []; // ids fixed for the whole match
  var scores = {};
  var players = {};
  var eliminationOrder = [];
  var phaseTimer = 0;
  var snailMode = false;
  var orb = null, orbTimer = ORB_SPAWN_MS;

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
    };
  }

  function ensurePlayer(id) { if (!players[id]) players[id] = newPlayer(id); return players[id]; }

  /* ---------------------------------------------------------------- lobby / round flow */
  function spawnRoundPlayers(map) {
    var plats = map.platforms;
    roster.forEach(function (id, i) {
      var p = ensurePlayer(id);
      var plat = plats[i % plats.length];
      var pad = Math.min(22, plat.w / 3);
      var lo = plat.x + pad, hi = plat.x + plat.w - pad;
      if (hi <= lo) { lo = plat.x + plat.w / 2; hi = lo; }
      p.x = lo + Math.random() * (hi - lo);
      p.y = -20 - i * 50;
      p.vx = 0; p.vy = 0; p.hp = 100; p.alive = true;
      p.attack = null; p.attackCooldown = 0;
      p.power = null; p.burnT = 0; p.burnTickT = 0; p.burnFlashT = 0; p.slowT = 0;
    });
    orb = null;
    orbTimer = ORB_SPAWN_MS;
  }

  function nextRound() {
    currentRound++;
    if (currentRound > totalRounds) { endMatch(); return; }
    currentMap = currentRound === 1 ? MAP0 : genMap(1000 + currentRound * 37 + Math.floor(Math.random() * 900));
    eliminationOrder = [];
    spawnRoundPlayers(currentMap);
    phase = "fightIntro";
    phaseTimer = 1100;
    onPhaseChange({ t: "roundStart", round: currentRound, totalRounds: totalRounds, mapName: currentMap.name });
    AudioManager.on.roundStart(currentMap.biome);
  }

  function eliminate(p) {
    if (!p.alive) return;
    p.alive = false;
    p.deathFadeT = 420;
    eliminationOrder.push(p.id);
    HitStop.trigger(55);
    Camera.addTrauma(0.85);
    Camera.zoomImpulse(0.05);
    ScreenFX.flash(0.5);
    Particles.eliminationBurst(p.x, p.y - 24, colorFor(p.id));
    AudioManager.on.ko();
    var aliveN = roster.filter(function (id) { return players[id] && players[id].alive; }).length;
    if (aliveN === 2) AudioManager.on.clutch();
    checkRoundEnd();
  }

  function checkRoundEnd() {
    if (phase !== "fight") return;
    var alive = roster.filter(function (id) { return players[id] && players[id].alive; });
    if (alive.length <= 1) {
      if (alive.length === 1) eliminationOrder.push(alive[0]);
      eliminationOrder.forEach(function (id, idx) {
        var placement = idx + 1;
        scores[id] = (scores[id] || 0) + placement;
      });
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

  /* ---------------------------------------------------------------- power orbs */
  var ORB_TYPES = null; // resolved lazily, POWER_COLORS comes from stickman.js
  function orbTypes() { return ORB_TYPES || (ORB_TYPES = Object.keys(POWER_COLORS)); }

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
  }

  /* ---------------------------------------------------------------- player-vs-player collision */
  var COLLIDE_HW = PW + 4;
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
          var half = xOverlap / 2;
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
    if (p.input.left && !p.input.right) { p.vx = -spd; p.facing = -1; }
    else if (p.input.right && !p.input.left) { p.vx = spd; p.facing = 1; }
    else p.vx = 0;

    if (p.jumpEdge && p.grounded) { p.vy = JUMP_V; p.grounded = false; p.jumpAnticT = 90; AudioManager.on.jump(); }
    p.jumpEdge = false;

    if ((p.punchEdge || p.kickEdge) && p.attackCooldown <= 0) {
      var type = p.kickEdge ? "kick" : "punch";
      var dur = type === "kick" ? KICK_MS : PUNCH_MS;
      p.attack = { type: type, t: dur, dur: dur, hitSet: {} };
      var cdMult = (p.power && p.power.type === "aire") ? AIR_COOLDOWN_MULT : 1;
      p.attackCooldown = ATTACK_COOLDOWN * cdMult;
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
          var reach = p.attack.type === "kick" ? 44 : 34;
          var dx = o.x - p.x;
          var facingOk = p.facing > 0 ? (dx > -6 && dx < reach) : (dx < 6 && dx > -reach);
          var dy = Math.abs(o.y - p.y - 10);
          if (facingOk && dy < 60) {
            p.attack.hitSet[oid] = true;
            var dmg = p.attack.type === "kick" ? 16 : 10;
            if (o.power && o.power.type === "tierra") dmg = Math.round(dmg * ARMOR_MULT);
            var kbX = p.attack.type === "kick" ? 3.2 : 2.1;
            var kbY = p.attack.type === "kick" ? -2 : 0;
            o.hp -= dmg;
            if (p.power && p.power.type === "fuego") { o.burnT = BURN_MS; o.burnTickT = BURN_TICK_MS; o.burnFlashT = 220; }
            if (p.power && p.power.type === "hielo") o.slowT = SLOW_MS;
            o.kbx = (o.kbx || 0) + p.facing * kbX;
            o.vy += kbY;
            if (kbY < 0) o.grounded = false;

            var hitX = o.x, hitY = o.y - 14;
            var isKick = p.attack.type === "kick";
            HitStop.trigger(isKick ? 55 : 35);
            Camera.addTrauma(isKick ? 0.5 : 0.32);
            Camera.zoomImpulse(0.03);
            if (!snailMode) Particles.punchSparks(hitX, hitY, p.facing, colorFor(p.id));
            ScreenFX.impactStreak(hitX, hitY, p.facing);
            AudioManager.on.hit(p.attack.type);
            o.squash = Math.max(o.squash || 0, isKick ? 0.55 : 0.4);
            p.squash = Math.max(p.squash || 0, 0.2);
            o.hitStunT = 180;
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

    if (p.attack && !snailMode) {
      Trails.push(p, performance.now());
      Trails.draw(ctx, p, function (gctx, ghost) { drawStickman(gctx, ghost, color); });
    } else if (p._trail) {
      Trails.clear(p);
    }

    var fading = !p.alive && p.deathFadeT > 0;
    if (fading) ctx.globalAlpha = clamp(p.deathFadeT / 420, 0, 1);
    var rig = drawStickman(ctx, p, color);
    var headY = rig.headY;
    if (fading) { ctx.globalAlpha = 1; return; }

    if (phase === "fight" || phase === "fightIntro" || phase === "roundEnd") {
      var bw = 40;
      ctx.fillStyle = "rgba(0,0,0,.5)";
      ctx.fillRect(p.x - bw / 2, headY - 24, bw, 5);
      ctx.fillStyle = color;
      ctx.fillRect(p.x - bw / 2, headY - 24, bw * Math.max(0, p.hp) / 100, 5);
    }

    if (p.power) {
      var pdef = POWER_COLORS[p.power.type];
      ctx.fillStyle = pdef;
      if (!snailMode) { ctx.shadowColor = pdef; ctx.shadowBlur = 8; }
      ctx.beginPath(); ctx.arc(p.x, headY - 32, 4, 0, Math.PI * 2); ctx.fill();
      if (!snailMode) ctx.shadowBlur = 0;
    }

    if (!snailMode) {
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "10px Chakra Petch, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(nameFor(p.id), p.x, headY - 30);
    }
  }

  /* ================================================================== public API (host) */
  function init(opts) {
    opts = opts || {};
    if (opts.colorFor) colorFor = opts.colorFor;
    if (opts.nameFor) nameFor = opts.nameFor;
    if (opts.onPhaseChange) onPhaseChange = opts.onPhaseChange;
  }

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

  function startMatch(rounds, snail) {
    totalRounds = Math.max(1, Math.min(20, rounds || 3));
    snailMode = !!snail;
    roster = Object.keys(players).map(Number);
    scores = {};
    roster.forEach(function (id) { scores[id] = 0; });
    currentRound = 0;
    nextRound();
  }

  function resetToLobby() {
    phase = "lobby";
    players = {};
    roster = [];
    scores = {};
    currentRound = 0;
    currentMap = MAP0;
    orb = null;
    orbTimer = ORB_SPAWN_MS;
    AudioManager.on.toLobby();
  }

  function step(dt) {
    var damageEnabled = phase === "fight";
    var idsToStep = phase === "lobby" ? Object.keys(players).map(Number) : roster;
    for (var si = 0; si < idsToStep.length; si++) stepPlayer(players[idsToStep[si]], dt, damageEnabled);
    resolvePlayerCollisions(idsToStep);
    updateOrbs(dt);

    if (phase === "fightIntro") {
      phaseTimer -= dt;
      if (phaseTimer <= 0) { phase = "fight"; orbTimer = ORB_SPAWN_MS; Camera.zoomImpulse(0.04); AudioManager.on.fightBegin(); onPhaseChange({ t: "fight" }); }
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
    var ids = phase === "lobby" ? Object.keys(players).map(Number) : roster;
    for (var i = 0; i < ids.length; i++) drawPlayer(ctx, players[ids[i]]);
    Particles.draw(ctx);
    Camera.end(ctx);
    ScreenFX.drawVignette(ctx, W, H);
    ScreenFX.draw(ctx, W, H);
  }

  // World.draw caches a CanvasGradient directly on each platform object (pl._grad/_gradH) the
  // first time it's rendered — a legitimate perf optimization for the single-machine render
  // path, but a live CanvasGradient is a native object with no plain-data form, so handing out
  // the SAME mutated map object over the network risks a silent serialization failure on every
  // broadcast after the first render (this exact bug hit the desktop/PeerJS build — see
  // ../desktop/sim.js). Sending freshly-built plain platform objects instead guarantees the
  // network copy can never carry a render-only field.
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
        burnFlashT: p.burnFlashT, slowT: p.slowT,
        attack: p.attack ? { type: p.attack.type, t: p.attack.t, dur: p.attack.dur } : null,
        vx: p.vx, vy: p.vy,
      };
    });
    return {
      phase: phase, round: currentRound, totalRounds: totalRounds,
      map: cleanMapForNetwork(currentMap), roster: roster, scores: scores, players: pl,
      orb: orb, snail: snailMode,
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
    lp.burnFlashT = pd.burnFlashT; lp.slowT = pd.slowT;
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
    startMatch: startMatch, resetToLobby: resetToLobby,
    step: step, draw: draw, snapshot: snapshot,
    getPhase: function () { return phase; },
    getRoster: function () { return roster; },
    getScores: function () { return scores; },
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
