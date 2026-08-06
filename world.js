/* World layer: map archetypes + biomes + procedural background/parallax + platform skin +
   ambient FX + hazard scaffold. Pure additive layer — never touches physics, collisions or
   controls. screen.html still owns stepPlayer()'s platform collision loop; this file only
   produces the platform rectangles it consumes and draws things around them. Plain globals,
   same style as fx.js / stickman.js (no bundler, no modules). */

/* ---- Modo caracol: perf toggle for low-end TV browsers, flipped on by screen.html's own
   frame-time monitor. Every hot-path shadowBlur is skipped and per-frame gradients are
   cached/reused instead of recreated. Read window.SNAIL_MODE directly (not a cached copy) so
   this file reacts the instant the monitor engages it mid-round, not just on next page load. */

/* ==================================================================== reachability */
/* Given the game's own movement constants, decide whether a straight jump can carry a
   player from one platform's top edge to another's. Used by the generator to guarantee
   every platform is reachable from at least one other — no more "hope it's fine" random
   placement. */
function makeReachability(consts) {
  var SPEED = consts.SPEED, JUMP_V = consts.JUMP_V, GU = consts.GRAVITY_UP, GD = consts.GRAVITY_DOWN;

  // time to rise from JUMP_V to vy=0, then fall through a height delta dy (dy>0 = falling further)
  function airTime(dy) {
    var tUp = -JUMP_V / GU;
    var apexDrop = -0.5 * (JUMP_V * JUMP_V) / -GU * -1; // = JUMP_V^2/(2*GU), height climbed above start
    apexDrop = (JUMP_V * JUMP_V) / (2 * GU);
    var remaining = apexDrop + dy; // total fall distance from apex down to landing height
    if (remaining < 0) {
      // landing above the apex: reduced rise time only (steep upward hop)
      // solve JUMP_V*t + 0.5*GU*t^2 = -(-dy) using upward branch
      var a = 0.5 * GU, b = JUMP_V, c = -(-dy);
      var disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      var t = (-b + Math.sqrt(disc)) / (2 * a);
      return t > 0 ? t : null;
    }
    var tDown = Math.sqrt((2 * remaining) / GD);
    return tUp + tDown;
  }

  function maxHorizontal(dy) {
    var t = airTime(dy);
    if (t == null) return 0;
    return SPEED * t;
  }

  // a, b: {x, y, w, h}. reachable if b's top span can be reached from a's top span by a
  // horizontal jump respecting max rise height and max horizontal travel for that dy.
  function reachable(a, b) {
    var dy = b.y - a.y; // positive = b is lower
    var maxRise = (JUMP_V * JUMP_V) / (2 * GU);
    if (dy < -maxRise - 4) return false; // b too far above to reach at all
    var reach = maxHorizontal(dy) * 0.86; // small safety margin, not a frame-perfect edge case
    var gap = rectGapX(a, b);
    return gap <= reach;
  }

  function rectGapX(a, b) {
    var aLo = a.x, aHi = a.x + a.w, bLo = b.x, bHi = b.x + b.w;
    if (aHi < bLo) return bLo - aHi;
    if (bHi < aLo) return aLo - bHi;
    return 0; // overlapping horizontally
  }

  // BFS connectivity check across the whole platform set (undirected: if a can reach b,
  // assume the reverse hop is also makeable at worst by a drop+jump).
  function allConnected(platforms) {
    if (platforms.length <= 1) return true;
    var n = platforms.length;
    var adj = [];
    for (var i = 0; i < n; i++) adj.push([]);
    for (var i2 = 0; i2 < n; i2++) {
      for (var j = i2 + 1; j < n; j++) {
        if (reachable(platforms[i2], platforms[j]) || reachable(platforms[j], platforms[i2])) {
          adj[i2].push(j); adj[j].push(i2);
        }
      }
    }
    var seen = new Array(n).fill(false);
    var stack = [0];
    seen[0] = true;
    var count = 1;
    while (stack.length) {
      var cur = stack.pop();
      for (var k = 0; k < adj[cur].length; k++) {
        var nb = adj[cur][k];
        if (!seen[nb]) { seen[nb] = true; count++; stack.push(nb); }
      }
    }
    return count === n;
  }

  return { reachable: reachable, allConnected: allConnected, maxHorizontal: maxHorizontal };
}

/* ==================================================================== map archetypes */
var MapArchetypes = (function () {
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Each builder returns { platforms: [{x,y,w,h}], hazardCandidates: [platformIndex,...] }
  // hazardCandidates marks edges it's safe to attach a hazard to (i.e. not the only route).
  var archetypes = {

    arena: function (rng, W, H) {
      var floorW = 480 + rng() * 220;
      var floorX = (W - floorW) / 2 + (rng() - 0.5) * 60;
      var plats = [{ x: floorX, y: 460 + (rng() - 0.5) * 14, w: floorW, h: 26 }];
      var sideW = 130 + rng() * 50;
      var sideY = 320 + (rng() - 0.5) * 30;
      plats.push({ x: 70 + rng() * 40, y: sideY, w: sideW, h: 18 });
      plats.push({ x: W - 70 - sideW - rng() * 40, y: sideY, w: sideW, h: 18 });
      var midW = 150 + rng() * 60;
      plats.push({ x: (W - midW) / 2, y: 210 + (rng() - 0.5) * 24, w: midW, h: 18 });
      return { platforms: plats, hazardCandidates: [1, 2] };
    },

    puente: function (rng, W, H) {
      var islandW = 190 + rng() * 60;
      var y0 = 380 + (rng() - 0.5) * 30;
      var plats = [
        { x: 50 + rng() * 20, y: y0, w: islandW, h: 24 },
        { x: W - 50 - islandW - rng() * 20, y: y0, w: islandW, h: 24 },
      ];
      var bridgeW = 140 + rng() * 60;
      plats.push({ x: (W - bridgeW) / 2, y: y0 - (70 + rng() * 40), w: bridgeW, h: 14 });
      // small perches above each island so the bridge isn't the only option
      plats.push({ x: 90 + rng() * 30, y: y0 - 150 - rng() * 20, w: 110, h: 16 });
      plats.push({ x: W - 90 - 110 - rng() * 30, y: y0 - 150 - rng() * 20, w: 110, h: 16 });
      return { platforms: plats, hazardCandidates: [] }; // the void itself is the hazard
    },

    torre: function (rng, W, H) {
      var n = 5 + Math.floor(rng() * 2);
      var plats = [];
      var y = 480;
      var side = rng() < 0.5 ? 1 : -1;
      var x = W / 2 - 90;
      for (var i = 0; i < n; i++) {
        var w = 150 - i * 8 + rng() * 30;
        x = clamp(x + side * (60 + rng() * 60), 60, W - 60 - w);
        plats.push({ x: x, y: y, w: w, h: 18 });
        y -= 70 + rng() * 20;
        side *= rng() < 0.7 ? -1 : 1;
      }
      return { platforms: plats, hazardCandidates: plats.map(function (_, i) { return i; }).slice(0, -1) };
    },

    escalera: function (rng, W, H) {
      var n = 5 + Math.floor(rng() * 2);
      var plats = [];
      var stepW = 150 + rng() * 30;
      var x0 = 50, x1 = W - 50 - stepW;
      var y0 = 470, y1 = 190;
      for (var i = 0; i < n; i++) {
        var t = i / (n - 1);
        var x = x0 + (x1 - x0) * t + (rng() - 0.5) * 20;
        var y = y0 + (y1 - y0) * t + (rng() - 0.5) * 14;
        plats.push({ x: x, y: y, w: stepW - t * 30, h: 17 });
      }
      return { platforms: plats, hazardCandidates: [] };
    },

    islas: function (rng, W, H) {
      var w = 220 + rng() * 60;
      var y = 360 + (rng() - 0.5) * 40;
      var plats = [
        { x: 60 + rng() * 20, y: y, w: w, h: 24 },
        { x: W - 60 - w - rng() * 20, y: y, w: w, h: 24 },
      ];
      // two small stepping perches offset in height, no direct central bridge
      plats.push({ x: W / 2 - 130 + (rng() - 0.5) * 30, y: y - 120 - rng() * 30, w: 110, h: 16 });
      plats.push({ x: W / 2 + 20 + (rng() - 0.5) * 30, y: y - 200 - rng() * 30, w: 110, h: 16 });
      return { platforms: plats, hazardCandidates: [2, 3] };
    },

    anillo: function (rng, W, H) {
      var cx = W / 2, cy = 300 + (rng() - 0.5) * 20;
      var rx = 260 + rng() * 40, ry = 140 + rng() * 20;
      var n = 5 + Math.floor(rng() * 2);
      var plats = [];
      for (var i = 0; i < n; i++) {
        var ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        var w = 120 + rng() * 40;
        var x = cx + Math.cos(ang) * rx - w / 2;
        var y = cy + Math.sin(ang) * ry;
        plats.push({ x: clamp(x, 40, W - 40 - w), y: clamp(y, 160, 470), w: w, h: 16 });
      }
      return { platforms: plats, hazardCandidates: plats.map(function (_, i) { return i; }) };
    },

    crater: function (rng, W, H) {
      var halfW = 300 + rng() * 60;
      var y = 440 + (rng() - 0.5) * 20;
      var plats = [
        { x: 50, y: y, w: halfW, h: 26 },
        { x: W - 50 - halfW, y: y, w: halfW, h: 26 },
      ];
      var midW = 130 + rng() * 40;
      plats.push({ x: (W - midW) / 2, y: y - 130 - rng() * 30, w: midW, h: 16 });
      var sideW = 100 + rng() * 20;
      plats.push({ x: 130 + rng() * 30, y: y - 90 - rng() * 20, w: sideW, h: 14 });
      plats.push({ x: W - 130 - sideW - rng() * 30, y: y - 90 - rng() * 20, w: sideW, h: 14 });
      return { platforms: plats, hazardCandidates: [2] };
    },

    piramide: function (rng, W, H) {
      var layers = 3 + Math.floor(rng() * 2);
      var plats = [];
      var baseW = 620 + rng() * 100;
      var y = 470;
      for (var i = 0; i < layers; i++) {
        var layerW = baseW - i * (baseW / (layers + 0.6));
        var count = layers - i;
        var totalGap = 40 * (count - 1);
        var segW = (layerW - totalGap) / count;
        var startX = (W - layerW) / 2 + (rng() - 0.5) * 20;
        for (var s = 0; s < count; s++) {
          plats.push({ x: startX + s * (segW + 40), y: y, w: segW, h: 16 });
        }
        y -= 78 + rng() * 12;
      }
      return { platforms: plats, hazardCandidates: [] };
    },
  };

  var ids = Object.keys(archetypes);

  function build(id, rng, W, H) {
    return archetypes[id](rng, W, H);
  }

  return { ids: ids, build: build };
})();

/* ==================================================================== biomes */
var Biomes = (function () {
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  var defs = {
    bosque: {
      name: "Bosque",
      sky: ["#0c1a12", "#173424"],
      platform: { base: "#20361f", edge: "#7be26a", glow: "rgba(123,226,106,.55)" },
      accentText: "#7be26a",
      particle: "leaves",
      particleColor: "#8fd45a",
      decor: "vines",
    },
    ruinas: {
      name: "Ruinas",
      sky: ["#0a0c18", "#1a1f30"],
      platform: { base: "#26293e", edge: "#9fb2ff", glow: "rgba(159,178,255,.5)" },
      accentText: "#9fb2ff",
      particle: "dust",
      particleColor: "#cdd6ff",
      decor: "columns",
    },
    volcan: {
      name: "Volcán",
      sky: ["#1a0a08", "#3a140c"],
      platform: { base: "#2e1613", edge: "#ff7a3c", glow: "rgba(255,122,60,.6)" },
      accentText: "#ff7a3c",
      particle: "ash",
      particleColor: "#ffb37a",
      decor: "cracks",
    },
    neon: {
      name: "Neón",
      sky: ["#08060f", "#150a26"],
      platform: { base: "#1c1330", edge: "#ff2ed6", glow: "rgba(255,46,214,.7)" },
      accentText: "#35f0e0",
      particle: "sparks",
      particleColor: "#35f0e0",
      decor: "signs",
    },
    nieve: {
      name: "Nieve",
      sky: ["#0d1522", "#1e2c40"],
      platform: { base: "#233246", edge: "#d8ecff", glow: "rgba(216,236,255,.55)" },
      accentText: "#d8ecff",
      particle: "snow",
      particleColor: "#eaf4ff",
      decor: "icicles",
    },
  };

  var ids = Object.keys(defs);
  function get(id) { return defs[id] || defs[ids[0]]; }
  function random(rng) { return ids[Math.floor(rng() * ids.length)]; }

  return { ids: ids, get: get, random: random, rgba: rgba };
})();

/* ==================================================================== procedural background */
/* Static geometry per biome is rendered once (on map build) into an offscreen canvas per
   layer, then blitted with a tiny parallax offset each frame — no per-frame shape drawing. */
var WorldBackground = (function () {
  function makeLayerCanvas(W, H) {
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    return c;
  }

  function paintSky(ctx, W, H, biome) {
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, biome.sky[0]);
    grad.addColorStop(1, biome.sky[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function paintStarsOrEmbers(ctx, W, H, rng, color, count) {
    for (var i = 0; i < count; i++) {
      var x = rng() * W, y = rng() * H * 0.7, r = 0.6 + rng() * 1.2;
      ctx.globalAlpha = 0.25 + rng() * 0.5;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function paintSilhouetteRange(ctx, W, H, rng, baseY, amp, color, n) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, baseY);
    var x = 0, step = W / n;
    for (var i = 0; i <= n; i++) {
      x = i * step;
      var y = baseY - rng() * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }

  function paintColumns(ctx, W, H, rng, baseY, color, n) {
    ctx.fillStyle = color;
    for (var i = 0; i < n; i++) {
      var w = 14 + rng() * 10;
      var x = (W / n) * i + rng() * 20;
      var h = 60 + rng() * 90;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, baseY - h, w, h);
    }
    ctx.globalAlpha = 1;
  }

  function paintBuildings(ctx, W, H, rng, baseY, color, n) {
    ctx.fillStyle = color;
    for (var i = 0; i < n; i++) {
      var w = 30 + rng() * 50;
      var x = rng() * W;
      var h = 40 + rng() * 160;
      ctx.globalAlpha = 0.3 + rng() * 0.2;
      ctx.fillRect(x, baseY - h, w, h);
      if (rng() < 0.6) {
        ctx.fillStyle = "rgba(255,255,255,.12)";
        for (var wy = baseY - h + 10; wy < baseY - 8; wy += 14) {
          if (rng() < 0.5) ctx.fillRect(x + 4, wy, 4, 4);
        }
        ctx.fillStyle = color;
      }
    }
    ctx.globalAlpha = 1;
  }

  function paintCelestial(ctx, W, H, rng, biomeId) {
    var isNight = biomeId === "neon" || biomeId === "ruinas" || biomeId === "volcan";
    var cx = 130 + rng() * 200, cy = 70 + rng() * 40, r = 30;
    ctx.save();
    ctx.shadowBlur = 40;
    if (isNight) {
      ctx.shadowColor = "rgba(216,226,255,.5)";
      ctx.fillStyle = "rgba(230,235,255,.85)";
    } else {
      ctx.shadowColor = "rgba(255,214,140,.6)";
      ctx.fillStyle = "rgba(255,224,160,.9)";
    }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function build(biomeId, seed, W, H) {
    var biome = Biomes.get(biomeId);
    var rng = mulberry32Local(seed ^ 0x9e3779b9);
    var sky = makeLayerCanvas(W, H);
    var far = makeLayerCanvas(W, H);
    var near = makeLayerCanvas(W, H);

    var skyCtx = sky.getContext("2d");
    paintSky(skyCtx, W, H, biome);
    if (biomeId === "neon" || biomeId === "ruinas" || biomeId === "volcan") {
      paintStarsOrEmbers(skyCtx, W, H, rng, biomeId === "volcan" ? "#ffb37a" : "#dfe6ff", 70);
    }
    paintCelestial(skyCtx, W, H, rng, biomeId);

    var farCtx = far.getContext("2d");
    if (biomeId === "bosque") paintSilhouetteRange(farCtx, W, H, rng, 300, 90, "rgba(10,20,14,.55)", 10);
    else if (biomeId === "ruinas") paintColumns(farCtx, W, H, rng, 340, "rgba(120,130,180,.4)", 9);
    else if (biomeId === "volcan") paintSilhouetteRange(farCtx, W, H, rng, 320, 120, "rgba(40,10,8,.6)", 8);
    else if (biomeId === "neon") paintBuildings(farCtx, W, H, rng, 360, "rgba(30,20,60,.55)", 12);
    else if (biomeId === "nieve") paintSilhouetteRange(farCtx, W, H, rng, 300, 80, "rgba(20,30,45,.5)", 9);

    var nearCtx = near.getContext("2d");
    if (biomeId === "bosque") paintSilhouetteRange(nearCtx, W, H, rng, 400, 60, "rgba(8,16,10,.7)", 7);
    else if (biomeId === "ruinas") paintColumns(nearCtx, W, H, rng, 470, "rgba(60,70,110,.6)", 6);
    else if (biomeId === "volcan") paintSilhouetteRange(nearCtx, W, H, rng, 420, 70, "rgba(25,6,5,.75)", 6);
    else if (biomeId === "neon") paintBuildings(nearCtx, W, H, rng, 460, "rgba(20,14,40,.7)", 8);
    else if (biomeId === "nieve") paintSilhouetteRange(nearCtx, W, H, rng, 420, 50, "rgba(15,22,34,.65)", 7);

    return { sky: sky, far: far, near: near, biome: biome };
  }

  function draw(ctx, bg, W, H, camera) {
    if (window.SNAIL_MODE) { ctx.drawImage(bg.sky, 0, 0); return; } // one blit instead of three
    var sx = camera ? camera.shakeX : 0, sy = camera ? camera.shakeY : 0;
    ctx.drawImage(bg.sky, 0, 0);
    ctx.drawImage(bg.far, sx * 0.15, sy * 0.15);
    ctx.drawImage(bg.near, sx * 0.35, sy * 0.35);
  }

  // local mulberry32 clone so this file has no hard dependency on screen.html's copy
  function mulberry32Local(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return { build: build, draw: draw, mulberry32: mulberry32Local };
})();

/* ==================================================================== platform renderer */
var PlatformRenderer = (function () {
  function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(ctx, pl, biome) {
    var style = biome.platform;
    if (window.SNAIL_MODE) {
      // one flat fillRect: no rounded corners (arcTo path building), no highlight gradient
      // fill, no accent-edge pass. Platforms don't move, so the visual simplicity is the
      // whole tradeoff — a plain rectangle costs a fraction of the normal 3-pass draw.
      ctx.fillStyle = style.base;
      ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
      return;
    }
    // soft drop shadow beneath the platform (snail mode: flat fill, no software blur)
    ctx.save();
    if (!window.SNAIL_MODE) {
      ctx.shadowColor = "rgba(0,0,0,.4)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 6;
    }
    ctx.fillStyle = style.base;
    roundedRect(ctx, pl.x, pl.y, pl.w, pl.h, 6);
    ctx.fill();
    ctx.restore();

    // subtle top highlight (2-stop gradient) — cached on the platform object itself since a
    // given pl.y/pl.h never changes after map build, so the gradient is identical every frame.
    if (!pl._grad || pl._gradH !== pl.h) {
      pl._grad = ctx.createLinearGradient(0, pl.y, 0, pl.y + pl.h);
      pl._grad.addColorStop(0, "rgba(255,255,255,.10)");
      pl._grad.addColorStop(1, "rgba(255,255,255,0)");
      pl._gradH = pl.h;
    }
    ctx.fillStyle = pl._grad;
    roundedRect(ctx, pl.x, pl.y, pl.w, pl.h, 6);
    ctx.fill();

    // glowing accent edge
    ctx.save();
    if (!window.SNAIL_MODE) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = style.edge;
    roundedRect(ctx, pl.x + 2, pl.y, pl.w - 4, 3, 2);
    ctx.fill();
    ctx.restore();
  }

  return { draw: draw, roundedRect: roundedRect };
})();

/* ==================================================================== decorations */
var Decorations = (function () {
  function draw(ctx, pl, biomeId, seed, t) {
    var rng = WorldBackground.mulberry32(seed);
    if (biomeId === "bosque") {
      // hanging vines swaying gently from the platform's underside
      var n = 2 + Math.floor(rng() * 2);
      for (var i = 0; i < n; i++) {
        var x = pl.x + 14 + rng() * (pl.w - 28);
        var len = 10 + rng() * 16;
        var sway = Math.sin(t * 0.0015 + i) * 4;
        ctx.strokeStyle = "rgba(123,226,106,.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, pl.y + pl.h);
        ctx.quadraticCurveTo(x + sway, pl.y + pl.h + len * 0.6, x + sway * 1.4, pl.y + pl.h + len);
        ctx.stroke();
      }
    } else if (biomeId === "ruinas") {
      // small chipped chunk missing from a corner, cosmetic only
      if (rng() < 0.6) {
        ctx.fillStyle = "rgba(0,0,0,.3)";
        ctx.beginPath();
        ctx.moveTo(pl.x + pl.w - 10, pl.y);
        ctx.lineTo(pl.x + pl.w, pl.y);
        ctx.lineTo(pl.x + pl.w, pl.y + 8);
        ctx.closePath();
        ctx.fill();
      }
    } else if (biomeId === "volcan") {
      // thin ember cracks along the top
      ctx.strokeStyle = "rgba(255,122,60,.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      var cx = pl.x + pl.w * (0.3 + rng() * 0.4);
      ctx.moveTo(cx, pl.y);
      ctx.lineTo(cx - 6, pl.y + pl.h * 0.6);
      ctx.lineTo(cx + 4, pl.y + pl.h);
      ctx.stroke();
    } else if (biomeId === "neon") {
      // tiny pulsing sign light near an edge
      var blink = 0.5 + Math.sin(t * 0.004 + seed) * 0.5;
      ctx.save();
      if (!window.SNAIL_MODE) {
        ctx.shadowColor = "rgba(255,46,214,.8)";
        ctx.shadowBlur = 8 * blink;
      }
      ctx.fillStyle = "rgba(255,46,214," + (0.5 + blink * 0.5) + ")";
      ctx.beginPath();
      ctx.arc(pl.x + pl.w - 10, pl.y - 4, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (biomeId === "nieve") {
      // small snow cap along the top edge
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillRect(pl.x + 2, pl.y - 2, pl.w - 4, 2);
    }
  }
  return { draw: draw };
})();

/* ==================================================================== ambient FX */
var EnvironmentFX = (function () {
  var POOL_SIZE = 40;
  var pool = [];
  for (var i = 0; i < POOL_SIZE; i++) {
    pool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: "#fff", rot: 0, kind: "dot" });
  }
  var cursor = 0;
  var emitAccum = 0;

  function spawn(opts) {
    var p = pool[cursor];
    cursor = (cursor + 1) % POOL_SIZE;
    p.active = true;
    p.x = opts.x; p.y = opts.y;
    p.vx = opts.vx || 0; p.vy = opts.vy || 0;
    p.life = p.maxLife = opts.life || 3000;
    p.size = opts.size || 2;
    p.color = opts.color || "#fff";
    p.kind = opts.kind || "dot";
    p.rot = opts.rot || 0;
    return p;
  }

  function emit(biome, W, H, dt) {
    emitAccum += dt;
    var interval = 220; // ms between spawns, kept sparse — ambience, not weather
    if (emitAccum < interval) return;
    emitAccum = 0;
    var kind = biome.particle;
    if (kind === "leaves") {
      spawn({ x: Math.random() * W, y: -6, vx: (Math.random() - 0.5) * 0.4, vy: 0.25 + Math.random() * 0.2, life: 6000, size: 3 + Math.random() * 2, color: biome.particleColor, kind: "leaf" });
    } else if (kind === "ash") {
      spawn({ x: Math.random() * W, y: -6, vx: (Math.random() - 0.5) * 0.2, vy: 0.15 + Math.random() * 0.15, life: 7000, size: 1.5 + Math.random() * 1.5, color: biome.particleColor, kind: "dot" });
    } else if (kind === "snow") {
      spawn({ x: Math.random() * W, y: -6, vx: (Math.random() - 0.5) * 0.3, vy: 0.2 + Math.random() * 0.2, life: 8000, size: 1.5 + Math.random() * 1.8, color: biome.particleColor, kind: "dot" });
    } else if (kind === "dust") {
      spawn({ x: Math.random() * W, y: 100 + Math.random() * 350, vx: (Math.random() - 0.5) * 0.15, vy: -0.05 - Math.random() * 0.05, life: 5000, size: 1 + Math.random(), color: biome.particleColor, kind: "dot" });
    } else if (kind === "sparks") {
      spawn({ x: Math.random() * W, y: 60 + Math.random() * 400, vx: (Math.random() - 0.5) * 0.1, vy: (Math.random() - 0.5) * 0.1, life: 900, size: 1 + Math.random(), color: biome.particleColor, kind: "dot" });
    }
  }

  function update(dt, biome, W, H) {
    if (window.SNAIL_MODE) return; // ambient dust/leaves/snow are pure atmosphere, skip on low-end TVs
    emit(biome, W, H, dt);
    for (var i = 0; i < POOL_SIZE; i++) {
      var p = pool[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0 || p.y > H + 20) { p.active = false; continue; }
      if (p.kind === "leaf") { p.x += Math.sin((p.life) * 0.003) * 0.3; p.rot += dt * 0.001; }
      p.x += p.vx * (dt * 0.06);
      p.y += p.vy * (dt * 0.06);
    }
  }

  function draw(ctx) {
    for (var i = 0; i < POOL_SIZE; i++) {
      var p = pool[i];
      if (!p.active) continue;
      var a = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = p.color;
      if (p.kind === "leaf") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  return { update: update, draw: draw };
})();

/* ==================================================================== hazards (scaffold) */
/* Registry supports many hazard kinds; only "spikes" is implemented. Hazards never alter
   the existing platform-collision loop in screen.html — checkHazards() is an additive,
   separate check that reuses whatever elimination callback the host provides. */
var Hazards = (function () {
  var HazardTypes = {
    spikes: {
      draw: function (ctx, hz, t) {
        var n = Math.max(2, Math.floor(hz.w / 12));
        var step = hz.w / n;
        ctx.save();
        if (!window.SNAIL_MODE) {
          ctx.shadowColor = "rgba(255,60,60,.6)";
          ctx.shadowBlur = 6;
        }
        ctx.fillStyle = "#ff3c3c";
        for (var i = 0; i < n; i++) {
          var x = hz.x + i * step;
          ctx.beginPath();
          ctx.moveTo(x, hz.y);
          ctx.lineTo(x + step / 2, hz.y - 10);
          ctx.lineTo(x + step, hz.y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      },
      hits: function (hz, p, PW) {
        return p.x + PW > hz.x && p.x - PW < hz.x + hz.w && p.y >= hz.y - 4 && p.y <= hz.y + 6;
      },
    },
  };

  // Attach hazards to a subset of a built archetype's hazardCandidates, biased low so most
  // rounds have none — hazards are seasoning, not the default.
  function place(rng, built) {
    var hazards = [];
    if (!built.hazardCandidates || !built.hazardCandidates.length) return hazards;
    if (rng() > 0.35) return hazards; // most maps stay hazard-free
    var idx = built.hazardCandidates[Math.floor(rng() * built.hazardCandidates.length)];
    var pl = built.platforms[idx];
    if (!pl) return hazards;
    var w = Math.min(pl.w * 0.5, 60 + rng() * 30);
    hazards.push({ type: "spikes", x: pl.x + (pl.w - w) / 2, y: pl.y, w: w, h: 10 });
    return hazards;
  }

  function draw(ctx, map, t) {
    if (!map.hazards) return;
    map.hazards.forEach(function (hz) {
      var def = HazardTypes[hz.type];
      if (def) def.draw(ctx, hz, t);
    });
  }

  // check(p, map, PW) -> true if p should be eliminated this frame
  function check(p, map, PW) {
    if (!map.hazards || !map.hazards.length) return false;
    for (var i = 0; i < map.hazards.length; i++) {
      var hz = map.hazards[i];
      var def = HazardTypes[hz.type];
      if (def && def.hits(hz, p, PW)) return true;
    }
    return false;
  }

  return { place: place, draw: draw, check: check, HazardTypes: HazardTypes };
})();

/* ==================================================================== World: public API */
var World = (function () {
  var names = {
    arena: ["Arena Central", "Círculo de Combate", "Coliseo"],
    puente: ["Puente Roto", "El Abismo", "Cruce Peligroso"],
    torre: ["Torre Ascendente", "Escalinata al Cielo", "Ascenso"],
    escalera: ["Zigzag", "Senda Quebrada", "Diagonal"],
    islas: ["Islas Gemelas", "Frente a Frente", "Doble Bastión"],
    anillo: ["El Anillo", "Círculo Exterior", "Corona"],
    crater: ["El Cráter", "La Fosa", "Filo del Vacío"],
    piramide: ["La Pirámide", "Templo Escalonado", "Zigurat"],
  };

  var backgroundCache = null; // { key, bg }

  function generateMap(seed, consts) {
    var W = consts.W, H = consts.H;
    var rng = WorldBackground.mulberry32(seed);
    var reach = makeReachability(consts);
    var ids = MapArchetypes.ids;
    var archId = ids[Math.floor(rng() * ids.length)];

    var built = null, attempts = 0;
    while (attempts < 5) {
      built = MapArchetypes.build(archId, rng, W, H);
      if (reach.allConnected(built.platforms)) break;
      attempts++;
    }
    // rescue pass: if still not fully connected after retries, nudge the platform farthest
    // from the group toward the center so no zone is left unreachable.
    if (!reach.allConnected(built.platforms)) {
      var plats = built.platforms;
      var cx = W / 2;
      plats.forEach(function (pl) { pl.x += (cx - (pl.x + pl.w / 2)) * 0.15; });
    }

    var biomeId = Biomes.random(rng);
    var biome = Biomes.get(biomeId);
    var pool = names[archId] || ["Sector Desconocido"];
    var mapName = pool[Math.floor(rng() * pool.length)] + " · " + biome.name;

    var hazards = Hazards.place(rng, built);

    return {
      name: mapName,
      bg: biome.sky, // kept for backward-compat display paths that still read map.bg
      platforms: built.platforms,
      biome: biomeId,
      archetype: archId,
      hazards: hazards,
      seed: seed,
    };
  }

  function ensureBackground(map, W, H) {
    var key = map.biome + ":" + map.seed;
    if (!backgroundCache || backgroundCache.key !== key) {
      backgroundCache = { key: key, bg: WorldBackground.build(map.biome, map.seed || 1, W, H) };
    }
    return backgroundCache.bg;
  }

  function draw(ctx, W, H, map, camera, tMs, dt) {
    var bg = ensureBackground(map, W, H);
    WorldBackground.draw(ctx, bg, W, H, camera);

    var biome = Biomes.get(map.biome);
    var snail = window.SNAIL_MODE;
    for (var i = 0; i < map.platforms.length; i++) {
      var pl = map.platforms[i];
      PlatformRenderer.draw(ctx, pl, biome);
      // cosmetic-only per-platform decoration (vines, cracks, blinking signs) — skip the whole
      // pass in snail mode rather than gating shadowBlur alone inside it.
      if (!snail) Decorations.draw(ctx, pl, map.biome, (map.seed || 1) + i * 101, tMs || 0);
    }

    Hazards.draw(ctx, map, tMs || 0);
    if (!snail) {
      EnvironmentFX.update(dt || 0, biome, W, H);
      EnvironmentFX.draw(ctx);
    }
  }

  function checkHazards(p, map, PW) {
    return Hazards.check(p, map, PW);
  }

  return { generateMap: generateMap, draw: draw, checkHazards: checkHazards, makeReachability: makeReachability };
})();
