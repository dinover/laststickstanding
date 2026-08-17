/* Stickman rig + run/jump/attack animation. Pure function of state -> pixels: it reads
   position/velocity/facing/attack off the game's player object and draws one frame.
   No feet are drawn — legs end in a rounded line tip, like a classic stickman. */

var DEG = Math.PI / 180;

/* ---- easing / table sampling ---- */
function smoothstep(u) { return u * u * (3 - 2 * u); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Loops: t=1 wraps back to t=0, for cyclic animations like running.
function sampleTable(table, phase) {
  var t = ((phase % 1) + 1) % 1;
  for (var i = 0; i < table.length - 1; i++) {
    var k0 = table[i], k1 = table[i + 1];
    if (t >= k0.t && t <= k1.t) {
      var u = k1.t === k0.t ? 0 : smoothstep((t - k0.t) / (k1.t - k0.t));
      return { a: lerp(k0.a, k1.a, u), b: lerp(k0.b, k1.b, u) };
    }
  }
  return { a: table[0].a, b: table[0].b };
}

// Doesn't loop: t clamps to [0,1], for one-shot animations like a punch or kick, where
// t=1 (the end of the strike) must stay the end pose rather than wrapping to the start.
function sampleTableOnce(table, phase) {
  var t = clamp(phase, 0, 1);
  for (var i = 0; i < table.length - 1; i++) {
    var k0 = table[i], k1 = table[i + 1];
    if (t >= k0.t && t <= k1.t) {
      var u = k1.t === k0.t ? 0 : smoothstep((t - k0.t) / (k1.t - k0.t));
      return { a: lerp(k0.a, k1.a, u), b: lerp(k0.b, k1.b, u) };
    }
  }
  return { a: table[table.length - 1].a, b: table[table.length - 1].b };
}

/* Eight breakpoints per stride, tuned for a RUN (fighters closing distance), not a stroll:
   bigger reach front-to-back, a sharper heel-to-butt knee snap, and a real airborne-looking
   tuck at the top of the swing. A single sine gives a metronome; this gives a sprint. */
var LEG_KEYS = [
  { t: 0.00, a: 36, b: 4 },
  { t: 0.14, a: 16, b: 6 },
  { t: 0.32, a: -18, b: 8 },
  { t: 0.48, a: -34, b: 12 },
  { t: 0.60, a: -14, b: 51 },
  { t: 0.76, a: 16, b: 33 },
  { t: 0.90, a: 32, b: 12 },
  { t: 1.00, a: 36, b: 4 },
];
var ARM_KEYS = [
  { t: 0.00, a: -22, b: 9 },
  { t: 0.25, a: 65, b: -55 },
  { t: 0.50, a: 36, b: -14 },
  { t: 0.75, a: -95, b: 45 },
  { t: 1.00, a: -12, b: 1 },
];

/* One-shot strikes, keyframed the same way as the run cycle but sampled with
   sampleTableOnce() over the attack's 0..1 progress (t=0 is the moment the attack button
   was pressed, t=1 is fully recovered) instead of looping. Follow-through overshoot (the limb
   drifting past its resting angle before easing back) is baked in as the last two keyframes. */
var PUNCH_ARM_KEYS = [
  { t: 0.00, a: -78, b: 120 },
  { t: 0.20, a: -58, b: 76 },
  { t: 0.40, a: 74, b: -75 },
  { t: 0.55, a: 59, b: -29 },
  { t: 0.62, a: 40, b: -40 },
  { t: 0.80, a: 15, b: -11 },
  { t: 0.92, a: -14, b: -4 },
  { t: 1.00, a: -20, b: 2 },
];
var KICK_LEG_KEYS = [
  { t: 0.00, a: 9, b: 11 },
  { t: 0.20, a: 59, b: 73 },
  { t: 0.40, a: 83, b: 66 },
  { t: 0.50, a: 100, b: -12 },
  { t: 0.60, a: 113, b: 0 },
  { t: 0.68, a: 113, b: -1 },
  { t: 0.85, a: 69, b: 5 },
  { t: 0.94, a: 25, b: 41 },
  { t: 1.00, a: 20, b: 46 },
];

/* Standing still: just two fixed poses (no time axis), gently modulated by the breathing
   cycle at draw time. Kept as {a,b} pairs rather than a bare number so the editor can treat
   them exactly like every other limb pose. */
var IDLE_LEGS = [
  { a: -23, b: -7 },
  { a: 26, b: 27 },
];
var IDLE_ARMS = [
  { a: 70, b: -74 },
  { a: 50, b: -79 },
];

/* Jump: only two keyframes each — t=0 is the instant of launch (rising fast), t=1 is about
   to land (falling fast). sampleTableOnce over the vy-derived 0..1 "how much of the way
   through the air" value in between. Legs and arms are independent per side since they don't
   mirror each other the way a stride does. */
var JUMP_LEGA_KEYS = [
  { t: 0.00, a: -3, b: 88 },
  { t: 1.00, a: 10, b: 12 },
];
var JUMP_LEGB_KEYS = [
  { t: 0.00, a: -34, b: 66 },
  { t: 1.00, a: -14, b: 16 },
];
var JUMP_ARMA_KEYS = [
  { t: 0.00, a: 121, b: -27 },
  { t: 1.00, a: 46, b: 34 },
];
var JUMP_ARMB_KEYS = [
  { t: 0.00, a: -102, b: -40 },
  { t: 1.00, a: -22, b: 28 },
];

/* Fixed one-off poses: the limb NOT being driven by a keyframe table during an attack (the
   punching stance's legs, the kicking leg's planted support leg, the guard/balance arms).
   Same {a,b} shape as IDLE_LEGS/IDLE_ARMS so the editor can treat every pose in the rig
   uniformly, whether it's cyclic, one-shot, or completely static. */
var STANCE = {
  punchLegs: [{ a: -17, b: 25 }, { a: 36, b: 41 }],      // rear / lead
  punchGuardArm: [{ a: -14, b: 85 }],                    // off-hand held by the chin
  kickSupportLeg: [{ a: -28, b: -26 }],                  // planted leg bracing the kick
  kickArms: [{ a: -60, b: 100 }, { a: 29, b: -30 }],     // thrown back for balance
};

/* Every scalar that shapes the *dynamic* motion (lean, twist, bob, breathing, squash/stretch,
   secondary-motion lag...) lives here instead of as an inline literal, so the animation editor
   can expose "how much does X lean" as a slider without touching drawStickman's logic. Values
   below are exactly what shipped before this was pulled out — this refactor changes nothing
   about how the game looks by default, only what's tunable. */
var TUNE = {
  runLean: 19, punchLeanBase: 9.5, punchLeanSnap: 20, kickLeanSnap: 14.5, airLeanMax: 8, idleLeanMix: 0.3,
  runTwist: 4, punchTwist: 5, kickTwist: 9.5, headTwistRunMix: 1,
  hitLean: 28, hitHeadShift: 2,
  runBob: 5.4, headBobRun: 3, headLagPhase: 0.03, pelvisDrive: 3,
  breatheAmp: 1.6, idleBobAmp: 0.3, idleSwayX: 1.5, idleWeightSwayX: 2.3, idleWeightLegSpread: 4,
  idleShoulderRotAmp: 4.4, idleHeadTurnAmp: 3, idleHandDriftAmp: 4.2, armSwayAmp: 5.8,
  headSpringK: 0.99,
  squashScaleY: 0.4, squashScaleX: 0.31, squashWaveScaleY: 0.08, squashWaveScaleX: 0.05,
  stretchScaleY: 0, stretchScaleX: 0, takeoffScaleY: 0.23, takeoffScaleX: 0.2,
  actionPopSquash: 0.07, actionPopStretch: 0.03,
};

var THIGH = 12.5, SHIN = 13.5, UARM = 10, FARM = 11;

/* angleDeg is UNSIGNED: positive always means "rotated toward the facing direction".
   facing (+1/-1) is applied exactly once, here — callers must never pre-multiply by it,
   or the mirroring cancels itself out (sin(a*facing) === facing*sin(a) for facing=+-1). */
function limbEnd(ox, oy, angleDeg, len, facing) {
  var rad = angleDeg * DEG;
  return { x: ox + Math.sin(rad) * len * facing, y: oy + Math.cos(rad) * len };
}

/**
 * jointBend is UNSIGNED. Two folding rules, because knees and elbows hinge differently:
 *  - "away" (legs): the shin always folds away from the facing direction relative to the
 *    thigh — a lifted leg tucks the heel up behind it, never flails the shin out in front.
 *  - "center" (arms, default): the forearm always folds IN, back toward the body's vertical
 *    centerline, whichever way the upper arm is currently swung. That's what a real elbow
 *    does — pumping an arm back doesn't hyperextend the forearm further back, it bends the
 *    elbow so the forearm comes up and in.
 * Extension past straight (a kick or punch snapping out) is modelled by letting jointBend
 * go negative, which swings the lower segment past the upper one instead of folding it in.
 */
function limb(ctx, hipX, hipY, upperAngle, jointBend, upperLen, lowerLen, facing, widthA, widthB, drawEndDot, foldAway) {
  var lowerAngle = foldAway
    ? upperAngle - jointBend
    : upperAngle - (upperAngle < 0 ? -1 : 1) * jointBend;
  var mid = limbEnd(hipX, hipY, upperAngle, upperLen, facing);
  var end = limbEnd(mid.x, mid.y, lowerAngle, lowerLen, facing);
  if (window.SNAIL_MODE) {
    // one stroke for the whole limb (avg width) instead of two tapered segments, and no
    // joint-dot fills — a limb is 1 draw call instead of 4.
    ctx.lineWidth = (widthA + widthB) / 2;
    ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(mid.x, mid.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    return end;
  }
  ctx.lineWidth = widthA;
  ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(mid.x, mid.y); ctx.stroke();
  ctx.lineWidth = widthB;
  ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.lineTo(end.x, end.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(mid.x, mid.y, 2, 0, Math.PI * 2); ctx.fill();
  if (drawEndDot) { ctx.beginPath(); ctx.arc(end.x, end.y, 2.4, 0, Math.PI * 2); ctx.fill(); }
  // power aura, per bone: every limb (thigh+shin, upper arm+forearm) that goes through here
  // gets its own overlay automatically — this is what makes fuego/hielo/tierra/aire hug the
  // actual current pose instead of a generic shape around the whole body.
  if (CURRENT_AURA) {
    auraSegment(ctx, hipX, hipY, mid.x, mid.y, CURRENT_AURA);
    auraSegment(ctx, mid.x, mid.y, end.x, end.y, CURRENT_AURA);
  }
  return end;
}
function limbLeg(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB) {
  return limb(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB, false, true);
}
function limbArm(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB, dot) {
  return limb(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB, dot, false);
}

/* ---------------------------------------------------------------- power FX
   Single source of truth for what each orb power looks like — screen.html only ever reads
   POWER_COLORS (for the orb pickup itself) and sets the plain state fields (power/burnT/
   burnFlashT/slowT) on the player object; every bit of *rendering* for what those fields mean
   lives here, right next to the rig that draws it. */
var POWER_COLORS = { fuego: "#ff5a2e", hielo: "#4fd7ff", tierra: "#8a6a3a", aire: "#c9ffb0" };

// Aire: a few motes orbiting the body — reads as swirling wind rather than a solid border,
// which is what makes it visually distinct from the other three at a glance. Kept as a single
// body-bounds halo (not per-limb, unlike the three below) because "orbiting the figure" is the
// whole point of the effect — hugging individual bones would just make it look like sparks.
function drawOrbitAura(ctx, cx, midY, halfW, halfH, t, color) {
  var n = 3;
  var rx = halfW + 6, ry = (halfH + 4) * 0.85;
  ctx.lineWidth = 2;
  ctx.shadowColor = color; ctx.shadowBlur = 8;
  for (var i = 0; i < n; i++) {
    var speed = 2.4 + i * 0.6;
    var a = t * speed + i * (Math.PI * 2 / n);
    var trailA = a - 0.4; // a short arc behind the head, so it reads as a swirl in motion
    var x = cx + Math.cos(a) * rx, y = midY + Math.sin(a) * ry;
    var tx = cx + Math.cos(trailA) * rx, ty = midY + Math.sin(trailA) * ry;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.65;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
}

// The module-level "what's burning/frosting/crusting right now" context. Set once per player
// right before their legs are drawn, read by every limb()/torso/neck stroke that follows, and
// cleared once the rig is done. This is what lets fuego/hielo/tierra hug the ACTUAL current
// pose bone-by-bone instead of a generic blob around the whole body: every segment the rig
// already draws (thigh, shin, upper arm, forearm, spine, neck) gets its own little overlay.
var CURRENT_AURA = null;
function beginPowerAura(p) {
  if (p.power) CURRENT_AURA = { type: p.power.type, t: p.idleT || 0 };
  // Una VÍCTIMA quemándose (burnT) o congelada (slowT) — infligido por OTRO jugador con ese
  // poder — no tiene p.power propio, así que antes se quedaba sin este aura y dependía solo
  // del recolor+glow (fuego) o de nada en absoluto (hielo no tenía ni eso: el aura de cristales
  // por hueso solo salía para quien sostenía el orbe). Reusa el mismo tratamiento ronda por
  // hueso que ya existía — es lo que hace que arda/congele de verdad en vez de ser un blob o
  // un simple cambio de color plano.
  else if (p.burnT > 0) CURRENT_AURA = { type: "fuego", t: p.idleT || 0 };
  else if (p.slowT > 0) CURRENT_AURA = { type: "hielo", t: p.idleT || 0 };
  else CURRENT_AURA = null;
}

// Draws one bone's worth of aura, called from inside limb() (so legs+arms get it automatically)
// and explicitly for the torso/neck strokes. Saves/restores fillStyle itself so callers never
// have to think about it — the rig's own joint-dot fills right after must see the real body
// color again, not whatever these shapes last set.
function auraSegment(ctx, x1, y1, x2, y2, aura) {
  if (!aura) return;
  var savedFill = ctx.fillStyle, savedStroke = ctx.strokeStyle, savedWidth = ctx.lineWidth;
  var dx = x2 - x1, dy = y2 - y1;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var nx = -dy / len, ny = dx / len;
  var t = aura.t;

  if (aura.type === "fuego") {
    // small flame tongues riding along the bone, each licking mostly UPWARD (real fire rises
    // regardless of which way the limb is angled) with its own flicker phase so a whole arm
    // reads as dancing flame rather than one uniform pulse.
    var n = 3;
    for (var i = 0; i < n; i++) {
      var u = (i + 0.5) / n;
      var px = x1 + dx * u, py = y1 + dy * u;
      var flick = 0.5 + 0.5 * Math.sin(t * 10 + i * 2.3 + u * 7);
      var reach = 4 + flick * 6;
      var sway = Math.sin(t * 15 + i * 4.1) * 2.5;
      ctx.fillStyle = "rgba(255," + (110 + Math.round(flick * 90)) + ",35," + (0.22 + flick * 0.4).toFixed(2) + ")";
      ctx.beginPath();
      ctx.moveTo(px - 2, py);
      ctx.lineTo(px + sway, py - reach);
      ctx.lineTo(px + 2, py);
      ctx.closePath();
      ctx.fill();
    }
  } else if (aura.type === "hielo") {
    // Crystal shards perched perpendicular to the bone, shimmering slowly — still deliberately
    // calmer than fire's flicker (per spec, "less glow"), but bumped from 3 shards on a single
    // side to 4 alternating sides + bigger/brighter, since at the original size this read as
    // "apenas se nota" even on the orb holder, let alone on a victim who now also gets it.
    var n2 = 4;
    for (var j = 0; j < n2; j++) {
      var u2 = (j + 0.5) / n2;
      var px2 = x1 + dx * u2, py2 = y1 + dy * u2;
      var shimmer = 0.42 + 0.32 * Math.sin(t * 2.4 + j * 1.7 + u2 * 4);
      var side = j % 2 === 0 ? 1 : -1;
      var sx = px2 + nx * 3.8 * side, sy = py2 + ny * 3.8 * side;
      ctx.fillStyle = "rgba(170,230,255," + shimmer.toFixed(2) + ")";
      ctx.beginPath();
      ctx.moveTo(sx, sy - 3.8);
      ctx.lineTo(sx + 2, sy);
      ctx.lineTo(sx, sy + 3.8);
      ctx.lineTo(sx - 2, sy);
      ctx.closePath();
      ctx.fill();
    }
  } else if (aura.type === "tierra") {
    // Rock nubs jutting off the bone. Antes eran solo 2 por hueso y apenas se notaban; ahora
    // son 5, más grandes, y alternan tamaño/tono por índice para leer como un borde rocoso de
    // verdad en vez de un par de motitas sueltas. Sigue sin término de tiempo (estático,
    // "borde marrón de tierra estático" — a diferencia del resto, que sí flickea/fluye).
    var n3 = 5;
    for (var k = 0; k < n3; k++) {
      var u3 = (k + 0.5) / n3 * 0.82 + 0.09;
      var px3 = x1 + dx * u3, py3 = y1 + dy * u3;
      var jitter = ((Math.round(x1) * 7 + Math.round(y1) * 13 + k * 31) % 5) - 2;
      var ox = px3 + nx * (4.5 + jitter), oy = py3 + ny * (4.5 + jitter);
      var sz = 2.6 + (k % 3) * 0.6; // 2.6 / 3.2 / 3.8 alternado, para que no sean todos iguales
      ctx.fillStyle = k % 2 === 0 ? "#8a6a3a" : "#6f5530";
      ctx.beginPath();
      ctx.moveTo(ox - sz, oy);
      ctx.lineTo(ox, oy - sz);
      ctx.lineTo(ox + sz, oy);
      ctx.lineTo(ox, oy + sz * 0.9);
      ctx.closePath();
      ctx.fill();
    }
  } else if (aura.type === "aire") {
    // short gusts sliding continuously along the bone (base -> tip, looping), on top of the
    // orbiting motes drawn once for the whole body — this is what makes air hug each limb the
    // same way fire/ice/earth do, while the motes still sell "swirling around the figure".
    var n4 = 2;
    for (var m = 0; m < n4; m++) {
      var u4 = (t * (0.6 + m * 0.35) + m * 0.5) % 1;
      var tailU = Math.max(0, u4 - 0.16);
      var px4 = x1 + dx * u4, py4 = y1 + dy * u4;
      var tx = x1 + dx * tailU, ty = y1 + dy * tailU;
      var off = Math.sin(t * 6 + m * 3) * 3;
      ctx.strokeStyle = "rgba(220,255,225," + (0.55 - u4 * 0.25).toFixed(2) + ")";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(tx + nx * off, ty + ny * off);
      ctx.lineTo(px4 + nx * off, py4 + ny * off);
      ctx.stroke();
    }
  }
  ctx.fillStyle = savedFill; ctx.strokeStyle = savedStroke; ctx.lineWidth = savedWidth;
}

// The "just got burned" pop: refreshed every time fuego lands a hit (and every DoT tick while
// it keeps burning), decaying out over ~0.2s. Drawn IN FRONT of the body (called after the
// limbs/head), unlike the aura above. Used to be one flat additive ellipse over the whole
// silhouette — now it's a handful of embers popping off and drifting up, since the persistent
// per-bone flame aura (beginPowerAura, above) already carries the "on fire" read the rest of
// the time; this only needs to sell the TICK, not the whole state.
function drawBurnFlash(ctx, p, cx, midY, halfH) {
  if (!(p.burnFlashT > 0)) return;
  var a = clamp(p.burnFlashT / 220, 0, 1);
  var n = 5;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (var i = 0; i < n; i++) {
    // Determinista por jugador+índice (no Math.random): así dos jugadores quemándose a la vez
    // no comparten el mismo patrón de chispas, pero el mismo jugador es estable cuadro a
    // cuadro en vez de titilar en posiciones nuevas cada frame.
    var seed = (p.id || 0) * 13 + i * 7;
    var ang = ((seed * 37) % 100) / 100 * Math.PI * 2;
    var dist = 3 + ((seed * 53) % 100) / 100 * 12;
    var rise = (1 - a) * 14; // suben a medida que se apagan
    var sx = cx + Math.cos(ang) * dist * 0.6;
    var sy = midY - halfH * 0.3 + Math.sin(ang) * dist * 0.4 - rise;
    ctx.globalAlpha = a * (0.5 + 0.5 * Math.sin(seed));
    ctx.fillStyle = i % 2 === 0 ? "#ffb347" : POWER_COLORS.fuego;
    ctx.beginPath(); ctx.arc(sx, sy, 1.6 * a + 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p - needs: x, y (feet), vx, vy, facing, grounded,
 *                     attack ({type,t,dur}|null), walkCycle (0..1), idleT, squash (0..1)
 * @param {string} color
 * @param {object} [dbg] - optional out-param; if passed, filled with the computed hip/shoulder/
 *                         head anchor points + facing + scaleX so a tool (the anim editor) can
 *                         draw draggable handles in exact alignment with the real render. Costs
 *                         nothing when omitted — every game call site leaves it undefined.
 * @return {{headY:number}} so callers can position an HP bar / nametag above the head
 */
function drawStickman(ctx, p, color, dbg) {
  var snail = !!window.SNAIL_MODE;
  var cx = p.x, feet = p.y;
  var running = p.grounded && p.vx !== 0;
  var scaleX = 1, scaleY = 1;
  if (!snail) {
    // squash/stretch/action-pop only computed off snail mode — it's pure juice (a transform +
    // a handful of sin() calls per player per frame) that a low-end TV never needs to pay for.
    var squash = p.squash || 0;
    var stretch = !p.grounded ? clamp(Math.abs(p.vy) / 14, 0, 1) : 0;
    // jump takeoff pop: a brief stretch right after launch, independent of fall-stretch above.
    var jumpAntic = clamp((p.jumpAnticT || 0) / 90, 0, 1);
    var takeoffStretch = jumpAntic * Math.sin(jumpAntic * Math.PI);
    // landing bounce refinement: on top of the linear squash decay, add a tiny damped-sine
    // (over-compress -> micro rebound -> settle), so the landing reads like a ball, not a clamp.
    var squashWave = squash > 0 ? Math.sin(squash * Math.PI * 2.4) * squash * squash * 0.35 : 0;
    scaleY = 1 - squash * TUNE.squashScaleY + squashWave * TUNE.squashWaveScaleY + stretch * TUNE.stretchScaleY + takeoffStretch * TUNE.takeoffScaleY;
    scaleX = 1 + squash * TUNE.squashScaleX - squashWave * TUNE.squashWaveScaleX - stretch * TUNE.stretchScaleX - takeoffStretch * TUNE.takeoffScaleX;
    // dynamic whole-body scale pop (3-8%, per spec) layered on top of the squash/stretch skew
    // above — a brief uniform enlarge on landings/takeoffs/hits reads as extra weight and impact
    // without touching the squash math that already drives the skew itself.
    var actionPop = 1 + clamp(squash, 0, 1) * TUNE.actionPopSquash + clamp(takeoffStretch, 0, 1) * TUNE.actionPopStretch;
    scaleX *= actionPop; scaleY *= actionPop;
  }

  var phaseNow = p.walkCycle || 0;
  // two soft bounces per stride (weight passing over each foot) — bigger than a walk's,
  // since a sprinting stride has real vertical drive. Kept even in snail mode: without it a
  // moving stickman visibly slides instead of running, which reads as broken, not "optimized".
  var runBob = running ? -Math.abs(Math.sin(phaseNow * Math.PI * 2)) * TUNE.runBob : 0;
  // idle micro-motion (breathing, weight-shift, shoulder/head sway, hand drift) and the
  // running pelvis/shoulder counter-twist are pure secondary-motion flourish — skip all of it
  // in snail mode instead of computing seven sin() calls a player never gets to appreciate on
  // a struggling TV. The stance still reads correctly, just perfectly still between strides.
  var idleActive = !snail && p.grounded && !running;
  var breathe = idleActive ? Math.sin(p.idleT * 1.1) * TUNE.breatheAmp : 0;
  var idleBob = idleActive ? Math.sin(p.idleT * 1.6) * TUNE.idleBobAmp + breathe * 0.6 : 0;
  var idleWeight = idleActive ? Math.sin(p.idleT * 0.35) : 0;
  var idleShoulderRot = idleActive ? Math.sin(p.idleT * 0.5 + 1.1) * TUNE.idleShoulderRotAmp : 0;
  var idleHeadTurn = idleActive ? Math.sin(p.idleT * 0.8 + 2.4) * TUNE.idleHeadTurnAmp : 0;
  var idleHandDrift = idleActive ? Math.sin(p.idleT * 1.3 + 0.6) * TUNE.idleHandDriftAmp : 0;

  // Shorter, stockier proportions than before.
  // pelvis rotation: while running the hips drive fore-aft opposite the trailing/leading leg,
  // half a stride out of phase with the shoulder twist below — a real stride counter-rotates
  // hips and shoulders, it doesn't move the torso as one rigid slab.
  var pelvisDrive = (running && !snail) ? Math.sin(phaseNow * Math.PI * 2 + Math.PI) * TUNE.pelvisDrive * p.facing : 0;
  var bodyH = 37 * scaleY;
  var hipY = feet - bodyH * 0.52 - runBob - idleBob;
  var hipX = cx + pelvisDrive + (idleActive ? Math.sin(p.idleT * 0.7) * TUNE.idleSwayX + idleWeight * TUNE.idleWeightSwayX : 0);

  var punching = p.attack && p.attack.type === "punch";
  var kicking = p.attack && p.attack.type === "kick";
  var attackDur = p.attack ? (p.attack.dur || (p.attack.type === "kick" ? 280 : 230)) : 1;
  // 0 -> 1 across the attack window (wind-up through recovery); 'snap' peaks at the midpoint
  // for effects that should crest and fade rather than move linearly.
  var attackLin = p.attack ? clamp(1 - p.attack.t / attackDur, 0, 1) : 0;
  var snap = p.attack ? Math.sin(attackLin * Math.PI) : 0;

  // lean: driving forward hard while running, punching with the shoulder behind the fist,
  // arched back on the way up, tucked forward on the way down through the air.
  var lean = 0;
  if (running) lean = p.facing * TUNE.runLean;
  else if (punching) lean = p.facing * (TUNE.punchLeanBase + snap * TUNE.punchLeanSnap);
  else if (kicking) lean = -p.facing * snap * TUNE.kickLeanSnap; // counter-lean away from the kicking leg
  else if (!p.grounded) lean = p.facing * clamp(p.vy / 9, -1, 1) * TUNE.airLeanMax;
  else lean = idleShoulderRot * TUNE.idleLeanMix;

  // knockback: torso tilts away from the hit and springs back over ~180ms (secondary motion,
  // not an instant snap). hitStunT/hitDir are additive fields set by screen.html on a landed hit.
  var hitStun = clamp((p.hitStunT || 0) / 180, 0, 1);
  var hitKick = hitStun * Math.sin(hitStun * Math.PI); // rises then eases back to 0
  lean += -(p.hitDir || 1) * hitKick * TUNE.hitLean;

  // pelvis vs shoulder rotation split: while running the shoulders twist a touch more than the
  // hips and slightly out of phase, so the torso doesn't rotate as one rigid block. Punches and
  // kicks add their own drive-through twist (shoulder leads the hip into the strike, same idea
  // as a real boxer rotating the trunk behind a punch) so the follow-through reads in the torso,
  // not just the arm.
  var twist = 0;
  if (!snail) {
    if (running) twist = Math.sin(phaseNow * Math.PI * 2 + 0.6) * TUNE.runTwist;
    if (punching) twist += p.facing * snap * TUNE.punchTwist;
    else if (kicking) twist -= p.facing * snap * TUNE.kickTwist;
  }
  var shoulderLean = lean + twist;

  var shoulderY = hipY - bodyH * 0.5 + breathe * 0.5;
  var leanRad = lean * DEG;
  var shoulderRad = shoulderLean * DEG;
  var shoulderX = hipX + Math.sin(shoulderRad) * (hipY - shoulderY);
  // slight secondary lag on the head, like it's loosely hinged rather than welded on.
  var headLagPhase = running ? phaseNow - TUNE.headLagPhase : phaseNow;
  var headBob = running ? -Math.abs(Math.sin(headLagPhase * Math.PI * 2)) * TUNE.headBobRun : 0;
  var headLeanTarget = shoulderLean + (running ? twist * TUNE.headTwistRunMix : idleHeadTurn);
  var headLean;
  if (snail) {
    // snap straight to the target instead of spring-lagging toward it — one less lerp and no
    // persistent state to carry between frames.
    headLean = headLeanTarget;
  } else {
    // secondary motion (overlap): the head doesn't snap to its target angle instantly, it eases
    // toward it frame to frame — so when the torso whips around (landing, a strike, a hit), the
    // head visibly trails behind for a couple frames instead of every part stopping in lockstep.
    // State lives on the player object itself (persists frame to frame for free, no extra arrays).
    p._headSpring = p._headSpring == null ? headLeanTarget : lerp(p._headSpring, headLeanTarget, TUNE.headSpringK);
    headLean = p._headSpring;
  }
  var headRad = headLean * DEG;
  var headX = shoulderX + Math.sin(headRad) * 10 - (p.hitDir || 1) * hitKick * TUNE.hitHeadShift;
  var headY = shoulderY - 13 - headBob + idleBob * 0.3;

  if (dbg) {
    dbg.hipX = hipX; dbg.hipY = hipY; dbg.shoulderX = shoulderX; dbg.shoulderY = shoulderY;
    dbg.headX = headX; dbg.headY = headY; dbg.facing = p.facing; dbg.scaleX = scaleX; dbg.cx = cx; dbg.feet = feet;
  }

  // squash/stretch is forced to scaleX=1 in snail mode (and usually resolves to it in normal
  // mode too, between hits/landings) — skip the transform entirely rather than pay for a
  // save/translate/scale/translate round-trip that would just be a no-op.
  var scaled = scaleX !== 1;
  if (scaled) {
    ctx.save();
    ctx.translate(cx, feet);
    ctx.scale(scaleX, 1);
    ctx.translate(-cx, -feet);
  }
  // round caps/joins make the software rasterizer stroke extra corner geometry on every
  // segment; butt/miter are the cheap defaults, and at this line width the visual difference
  // is negligible next to the frame-rate win.
  ctx.lineCap = snail ? "butt" : "round";
  ctx.lineJoin = snail ? "miter" : "round";
  // power status recolor: hielo paints the victim's whole body ice-blue for as long as the
  // slow lasts, in BOTH modes (cheap — it's just which color the same strokes use). Snail mode
  // additionally recolors by burn/own-power instead of drawing any of the fancier aura/flash
  // effects below, which is the "redibujar los bordes con los colores del orbe" fallback.
  var drawColor = color;
  if (snail) {
    if (p.burnT > 0) drawColor = POWER_COLORS.fuego;
    else if (p.slowT > 0) drawColor = POWER_COLORS.hielo;
    else if (p.power) drawColor = POWER_COLORS[p.power.type];
  } else if (p.burnT > 0) {
    // Recolor + el shadowBlur que ya se aplica más abajo a drawColor = el "borde exterior"
    // con glow que antes solo pasaba en snail mode. Antes de esto, en modo normal quien se
    // quemaba no cambiaba de color en absoluto — solo tenía el flash puntual cada tick.
    drawColor = POWER_COLORS.fuego;
  } else if (p.slowT > 0) {
    drawColor = POWER_COLORS.hielo;
  }
  ctx.strokeStyle = drawColor;
  ctx.fillStyle = drawColor;
  if (!snail) {
    ctx.shadowColor = drawColor;
    ctx.shadowBlur = 6;
  }

  // ---- own-power aura ----
  // aire also gets one whole-body orbit halo (drawn here, behind everything) on TOP of the
  // per-bone gusts every limb()/torso/neck call adds below via CURRENT_AURA — the halo sells
  // "swirling around the figure", the gusts sell "hugging each limb".
  if (!snail) {
    beginPowerAura(p);
    if (p.power && p.power.type === "aire") {
      var auraMidY = (headY + feet) / 2 - 4, auraHalfH = (feet - headY) / 2 + 6;
      drawOrbitAura(ctx, hipX, auraMidY, 17, auraHalfH, p.idleT || 0, POWER_COLORS.aire);
      ctx.strokeStyle = drawColor; ctx.fillStyle = drawColor; // restore before the rig itself
    }
  }

  // ---- legs first, so the torso overlaps them like a real silhouette ----
  if (kicking) {
    // planted support leg takes a slight backward give, bracing the kick
    limbLeg(ctx, hipX, hipY, STANCE.kickSupportLeg[0].a, STANCE.kickSupportLeg[0].b, THIGH, SHIN, p.facing, 4.6, 3.4);
    // kicking leg: keyframed across the strike (raise the knee, snap the shin out, retract)
    var kk = sampleTableOnce(KICK_LEG_KEYS, attackLin);
    limbLeg(ctx, hipX, hipY, kk.a, kk.b, THIGH, SHIN + 1, p.facing, 4.6, 3.4);
  } else if (!p.grounded) {
    var t = (clamp(p.vy / 9, -1, 1) + 1) / 2; // 0 = launching upward, 1 = falling fast
    // Rising: both knees pull up, shins tucking back behind the thighs (heel toward the
    // seat) for a tight, readable jump silhouette. Falling: legs stretch back out, reaching
    // down for the ground.
    var jla = sampleTableOnce(JUMP_LEGA_KEYS, t);
    var jlb = sampleTableOnce(JUMP_LEGB_KEYS, t);
    limbLeg(ctx, hipX, hipY, jla.a, jla.b, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, jlb.a, jlb.b, THIGH, SHIN, p.facing, 4.6, 3.4);
  } else if (running) {
    var legBack = sampleTable(LEG_KEYS, phaseNow);
    var legFront = sampleTable(LEG_KEYS, phaseNow + 0.5);
    limbLeg(ctx, hipX, hipY, legBack.a, legBack.b, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, legFront.a, legFront.b, THIGH, SHIN, p.facing, 4.6, 3.4);
  } else if (punching) {
    // a boxer's base: rear leg braced, lead leg planted a touch forward.
    limbLeg(ctx, hipX, hipY, STANCE.punchLegs[0].a, STANCE.punchLegs[0].b, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, STANCE.punchLegs[1].a, STANCE.punchLegs[1].b, THIGH, SHIN, p.facing, 4.6, 3.4);
  } else {
    // fighting stance: staggered, knees bent and ready, not a flat-footed idle stand.
    // weight-shift biases the two legs oppositely, so the stance visibly favors one side.
    limbLeg(ctx, hipX, hipY, IDLE_LEGS[0].a + idleWeight * TUNE.idleWeightLegSpread, IDLE_LEGS[0].b, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, IDLE_LEGS[1].a - idleWeight * TUNE.idleWeightLegSpread, IDLE_LEGS[1].b, THIGH, SHIN, p.facing, 4.6, 3.4);
  }

  // ---- torso ----
  ctx.lineWidth = 4.8;
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.quadraticCurveTo(hipX + Math.sin(leanRad) * 6, (hipY + shoulderY) / 2, shoulderX, shoulderY);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(hipX, hipY, 2.1, 0, Math.PI * 2); ctx.fill();
  auraSegment(ctx, hipX, hipY, shoulderX, shoulderY, CURRENT_AURA);

  // ---- arms ----
  if (punching) {
    // off arm stays cocked by the chin, guard-style
    limbArm(ctx, shoulderX, shoulderY, STANCE.punchGuardArm[0].a, STANCE.punchGuardArm[0].b, UARM, FARM, p.facing, 4.2, 3.2, false);
    // punching arm: keyframed across the strike (wind-up -> throw -> recovery)
    var pa = sampleTableOnce(PUNCH_ARM_KEYS, attackLin);
    limbArm(ctx, shoulderX, shoulderY, pa.a, pa.b, UARM, FARM, p.facing, 4.2, 3.4, true);
  } else if (kicking) {
    limbArm(ctx, shoulderX, shoulderY, STANCE.kickArms[0].a, STANCE.kickArms[0].b, UARM, FARM, p.facing, 4.2, 3.2, true); // thrown back for balance
    limbArm(ctx, shoulderX, shoulderY, STANCE.kickArms[1].a, STANCE.kickArms[1].b, UARM, FARM, p.facing, 4.2, 3.2, true);
  } else if (!p.grounded) {
    var ta = (clamp(p.vy / 9, -1, 1) + 1) / 2;
    // angle convention: 0 = hanging down, 180 = reaching straight up. Rising throws both
    // arms up for lift; falling brings them down and forward to brace for the landing.
    var jaa = sampleTableOnce(JUMP_ARMA_KEYS, ta);
    var jab = sampleTableOnce(JUMP_ARMB_KEYS, ta);
    limbArm(ctx, shoulderX, shoulderY, jaa.a, jaa.b, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, jab.a, jab.b, UARM, FARM, p.facing, 4.2, 3.2);
  } else if (running) {
    var armBack = sampleTable(ARM_KEYS, phaseNow + 0.5);
    var armFront = sampleTable(ARM_KEYS, phaseNow);
    limbArm(ctx, shoulderX, shoulderY, armBack.a, armBack.b, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, armFront.a, armFront.b, UARM, FARM, p.facing, 4.2, 3.2);
  } else {
    // simple resting pose: elbows stay put, relaxed by the sides; only the forearms turn in
    // to bring the fists together in front of the body. Rises and falls gently with the breath.
    var armSway = breathe * TUNE.armSwayAmp;
    limbArm(ctx, shoulderX, shoulderY, IDLE_ARMS[0].a - armSway + idleHandDrift, IDLE_ARMS[0].b, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, IDLE_ARMS[1].a + armSway - idleHandDrift, IDLE_ARMS[1].b, UARM, FARM, p.facing, 4.2, 3.2);
  }

  // ---- head ----
  ctx.lineWidth = 4.4;
  ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(headX, headY + 8); ctx.stroke();
  auraSegment(ctx, shoulderX, shoulderY, headX, headY + 8, CURRENT_AURA);
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.ellipse(headX, headY, 7.6, 8.8, 0, 0, Math.PI * 2); ctx.stroke();

  if (!snail) ctx.shadowBlur = 0;
  // burn flash last, on top of everything, like a hit spark
  if (!snail) drawBurnFlash(ctx, p, hipX, (headY + feet) / 2 - 4, (feet - headY) / 2 + 6);
  CURRENT_AURA = null; // don't leak into whatever gets drawn next (ghost trails, another player)
  if (scaled) ctx.restore();

  return { headY: headY };
}
