/* Juice layer: camera (shake/zoom/trauma), hit-stop, a pooled particle system, and small
   screen-space effects (flash / impact streaks / vignette). Pure additive systems — nothing
   here reads or writes physics/damage/control state. Plain globals, same style as stickman.js. */

/* ---- easing helpers (kept alongside stickman.js's smoothstep/lerp) ---- */
function easeOutBack(t) {
  var c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/* ---- Camera: everything world-space is drawn between begin()/end(). Never move the world
   directly — shake/zoom/trauma live here so any system can perturb the view without touching
   draw code. Trauma decays and shake is derived from it (trauma^2) via a smoothed random-walk
   (lerp toward a new random target a few times a second), not raw per-frame randomness. */
var Camera = {
  x: 0, y: 0, zoom: 1,
  shakeX: 0, shakeY: 0,
  trauma: 0,
  _zoomVel: 0,
  _noiseX: 0, _noiseY: 0, _noiseTX: 0, _noiseTY: 0, _noiseTimer: 0,
  _breathT: 0,

  addTrauma: function (amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  },

  zoomImpulse: function (amount) {
    this._zoomVel += amount;
  },

  update: function (dt) {
    // trauma decay
    this.trauma = Math.max(0, this.trauma - dt * 0.0022);
    var t2 = this.trauma * this.trauma;

    // smoothed shake noise: pick a new random target every ~40ms, lerp toward it every frame
    this._noiseTimer -= dt;
    if (this._noiseTimer <= 0) {
      this._noiseTimer = 40;
      this._noiseTX = (Math.random() * 2 - 1);
      this._noiseTY = (Math.random() * 2 - 1);
    }
    this._noiseX += (this._noiseTX - this._noiseX) * Math.min(1, dt * 0.02);
    this._noiseY += (this._noiseTY - this._noiseY) * Math.min(1, dt * 0.02);
    var maxShake = 14;
    this.shakeX = this._noiseX * maxShake * t2;
    this.shakeY = this._noiseY * maxShake * t2;

    // zoom: spring back to 1
    this.zoom += this._zoomVel;
    this._zoomVel *= 0.001; // consumed almost immediately, see below
    this.zoom += (1 - this.zoom) * Math.min(1, dt * 0.02);

    // subtle idle "alive" camera breathing — never enough to be noticed as motion sickness
    this._breathT += dt * 0.0006;
  },

  begin: function (ctx, W, H) {
    ctx.save();
    var breathe = Math.sin(this._breathT) * 0.6;
    ctx.translate(W / 2, H / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-W / 2, -H / 2);
    ctx.translate(this.shakeX + breathe, this.shakeY);
  },

  end: function (ctx) {
    ctx.restore();
  },
};

/* ---- HitStop: freezes physics + animation + camera for a handful of ms on a big hit.
   The render loop still draws (the frozen frame), it just stops calling update logic. */
var HitStop = {
  t: 0,
  trigger: function (ms) {
    this.t = Math.max(this.t, ms);
  },
  active: function () {
    return this.t > 0;
  },
  update: function (dt) {
    if (this.t > 0) this.t = Math.max(0, this.t - dt);
  },
};

/* ---- Particles: fixed-size pool, zero per-frame allocation. Each slot is reused via index;
   spawn() claims the oldest/first inactive slot (or overwrites the oldest if the pool is full,
   so a burst never silently drops the newest particles). */
var Particles = (function () {
  var POOL_SIZE = 220;
  var pool = [];
  for (var i = 0; i < POOL_SIZE; i++) {
    pool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: "#fff", glow: 6, gravity: 0 });
  }
  var cursor = 0;

  function spawn(opts) {
    var p = pool[cursor];
    cursor = (cursor + 1) % POOL_SIZE;
    p.active = true;
    p.x = opts.x; p.y = opts.y;
    p.vx = opts.vx || 0; p.vy = opts.vy || 0;
    p.life = p.maxLife = opts.life || 400;
    p.size = opts.size || 2.4;
    p.color = opts.color || "#fff";
    p.glow = opts.glow != null ? opts.glow : 8;
    p.gravity = opts.gravity != null ? opts.gravity : 0.0009;
    p.drag = opts.drag != null ? opts.drag : 0.002;
    return p;
  }

  // Small helper presets so call sites in screen.html stay one-liners.
  function burst(x, y, n, opts) {
    opts = opts || {};
    for (var i = 0; i < n; i++) {
      var ang = Math.random() * Math.PI * 2;
      var spd = (opts.minSpd || 0.5) + Math.random() * (opts.maxSpd || 2.2);
      spawn({
        x: x, y: y,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd * (opts.vSquash != null ? opts.vSquash : 1),
        life: (opts.minLife || 250) + Math.random() * (opts.lifeRange || 250),
        size: (opts.minSize || 1.4) + Math.random() * (opts.sizeRange || 1.8),
        color: opts.color || "#fff",
        glow: opts.glow != null ? opts.glow : 8,
        gravity: opts.gravity != null ? opts.gravity : 0.0009,
        drag: opts.drag != null ? opts.drag : 0.002,
      });
    }
  }

  function landingDust(x, y, facing, strength, color) {
    var n = Math.min(10, 3 + Math.round(strength * 8));
    for (var i = 0; i < n; i++) {
      var side = Math.random() < 0.5 ? -1 : 1;
      spawn({
        x: x + side * Math.random() * 6, y: y - Math.random() * 3,
        vx: side * (0.4 + Math.random() * 1.6 * strength),
        vy: -0.2 - Math.random() * 0.6 * strength,
        life: 260 + Math.random() * 220,
        size: 1.2 + Math.random() * 1.6,
        color: color || "rgba(255,255,255,.65)",
        glow: 4,
        gravity: 0.0016,
        drag: 0.004,
      });
    }
  }

  function punchSparks(x, y, dir, color) {
    for (var i = 0; i < 7; i++) {
      var ang = (Math.random() - 0.5) * 1.4; // narrow cone
      var c = Math.cos(ang), s = Math.sin(ang);
      var vx = (dir * c) * (3 + Math.random() * 3.5);
      var vy = s * (3 + Math.random() * 3.5);
      spawn({
        x: x, y: y, vx: vx, vy: vy,
        life: 70 + Math.random() * 60,
        size: 1.6 + Math.random() * 1.6,
        color: color || "#fff",
        glow: 10,
        gravity: 0,
        drag: 0.012,
      });
    }
  }

  function eliminationBurst(x, y, color) {
    burst(x, y, 46, {
      minSpd: 1.2, maxSpd: 5.2, minLife: 380, lifeRange: 420,
      minSize: 1.6, sizeRange: 2.6, color: color, glow: 12, gravity: 0.0012, drag: 0.0026,
    });
  }

  function update(dt) {
    for (var i = 0; i < POOL_SIZE; i++) {
      var p = pool[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.vy += p.gravity * dt;
      var dragK = Math.max(0, 1 - p.drag * dt);
      p.vx *= dragK; p.vy *= dragK;
      p.x += p.vx * (dt * 0.06);
      p.y += p.vy * (dt * 0.06);
    }
  }

  function draw(ctx) {
    for (var i = 0; i < POOL_SIZE; i++) {
      var p = pool[i];
      if (!p.active) continue;
      var a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (typeof SNAIL_MODE === "undefined" || !SNAIL_MODE) {
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.glow;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  return { spawn: spawn, burst: burst, landingDust: landingDust, punchSparks: punchSparks, eliminationBurst: eliminationBurst, update: update, draw: draw };
})();

/* ---- Trails: lightweight snapshot ghosts for motion trails. Stores only the fields
   drawStickman() actually reads, so callers can redraw a ghost by calling drawStickman again
   with a reduced alpha — no separate silhouette-draw path needed. Snapshots live on the player
   object itself (p._trail) since ad-hoc per-player fields are already the pattern in this game. */
var Trails = {
  maxGhosts: 3,
  minIntervalMs: 26,

  push: function (p, nowMs) {
    if (!p._trail) p._trail = [];
    if (!p._trailT) p._trailT = 0;
    if (nowMs - p._trailT < this.minIntervalMs) return;
    p._trailT = nowMs;
    p._trail.push({
      x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing, grounded: p.grounded,
      attack: p.attack ? { type: p.attack.type, t: p.attack.t, dur: p.attack.dur } : null,
      walkCycle: p.walkCycle, idleT: p.idleT, squash: p.squash,
    });
    if (p._trail.length > this.maxGhosts) p._trail.shift();
  },

  draw: function (ctx, p, drawFn) {
    // ghost trails redraw the full stickman 1-3x per attacking player, per frame — skip
    // them entirely in snail mode, they're pure juice with no gameplay meaning.
    if (typeof SNAIL_MODE !== "undefined" && SNAIL_MODE) return;
    if (!p._trail || !p._trail.length) return;
    var n = p._trail.length;
    for (var i = 0; i < n; i++) {
      var g = p._trail[i];
      ctx.save();
      ctx.globalAlpha = 0.10 + (i / n) * 0.16;
      drawFn(ctx, g);
      ctx.restore();
    }
  },

  clear: function (p) {
    if (p._trail) p._trail.length = 0;
  },
};

/* ---- ScreenFX: screen-space overlay (flash + short impact streaks near a point). Drawn
   outside Camera.begin/end so it never shakes/zooms with the world. */
var ScreenFX = {
  flashA: 0,
  streaks: [], // {x,y,dir,t,maxT}

  flash: function (strength) {
    this.flashA = Math.min(1, this.flashA + strength);
  },

  impactStreak: function (x, y, dir) {
    this.streaks.push({ x: x, y: y, dir: dir, t: 90, maxT: 90 });
    if (this.streaks.length > 12) this.streaks.shift();
  },

  update: function (dt) {
    this.flashA = Math.max(0, this.flashA - dt * 0.006);
    for (var i = this.streaks.length - 1; i >= 0; i--) {
      this.streaks[i].t -= dt;
      if (this.streaks[i].t <= 0) this.streaks.splice(i, 1);
    }
  },

  _vignetteCache: null, _vignetteW: 0, _vignetteH: 0,
  drawVignette: function (ctx, W, H) {
    // W/H are fixed per session (canvas doesn't resize mid-round), so the gradient is
    // identical every frame — build it once and reuse instead of allocating 60x/sec.
    if (!this._vignetteCache || this._vignetteW !== W || this._vignetteH !== H) {
      var grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, "rgba(0,0,0,.28)");
      this._vignetteCache = grad;
      this._vignetteW = W; this._vignetteH = H;
    }
    ctx.fillStyle = this._vignetteCache;
    ctx.fillRect(0, 0, W, H);
  },

  draw: function (ctx, W, H) {
    for (var i = 0; i < this.streaks.length; i++) {
      var s = this.streaks[i];
      var a = s.t / s.maxT;
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = "rgba(255,80,120,.9)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(s.x - 10 * s.dir, s.y - 1); ctx.lineTo(s.x + 10 * s.dir, s.y - 1); ctx.stroke();
      ctx.strokeStyle = "rgba(90,220,255,.9)";
      ctx.beginPath(); ctx.moveTo(s.x - 10 * s.dir, s.y + 1); ctx.lineTo(s.x + 10 * s.dir, s.y + 1); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (this.flashA > 0.002) {
      ctx.fillStyle = "rgba(255,255,255," + (this.flashA * 0.55) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  },
};
