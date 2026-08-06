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
   was pressed, t=1 is fully recovered) instead of looping. */
var PUNCH_ARM_KEYS = [
  { t: 0.00, a: -43, b: 100 },
  { t: 0.20, a: -58, b: 76 },
  { t: 0.40, a: 74, b: -75 },
  { t: 0.55, a: 59, b: -29 },
  { t: 0.62, a: 40, b: -40 },
  { t: 0.80, a: 15, b: -11 },
  { t: 1.00, a: -14, b: -4 },
];
var KICK_LEG_KEYS = [
  { t: 0.00, a: 10, b: 14 },
  { t: 0.20, a: 59, b: 73 },
  { t: 0.40, a: 83, b: 66 },
  { t: 0.50, a: 88, b: 17 },
  { t: 0.60, a: 113, b: 0 },
  { t: 0.68, a: 113, b: -1 },
  { t: 0.85, a: 69, b: 5 },
  { t: 1.00, a: 25, b: 41 },
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
  { t: 0.00, a: 18, b: 88 },
  { t: 1.00, a: 10, b: 12 },
];
var JUMP_LEGB_KEYS = [
  { t: 0.00, a: -4, b: 66 },
  { t: 1.00, a: -14, b: 16 },
];
var JUMP_ARMA_KEYS = [
  { t: 0.00, a: 168, b: 20 },
  { t: 1.00, a: 46, b: 34 },
];
var JUMP_ARMB_KEYS = [
  { t: 0.00, a: -146, b: 24 },
  { t: 1.00, a: -22, b: 28 },
];

/* Overshoot tails appended after the strike settles: the limb doesn't stop dead on the resting
   angle, it drifts a touch past it and eases back — classic follow-through. Only added at the
   very end of the existing tables (t stays within 0..1, sampleTableOnce is untouched). */
PUNCH_ARM_KEYS[PUNCH_ARM_KEYS.length - 1] = { t: 0.92, a: -14, b: -4 };
PUNCH_ARM_KEYS.push({ t: 1.00, a: -20, b: 2 });
KICK_LEG_KEYS[KICK_LEG_KEYS.length - 1] = { t: 0.94, a: 25, b: 41 };
KICK_LEG_KEYS.push({ t: 1.00, a: 20, b: 46 });

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
  return end;
}
function limbLeg(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB) {
  return limb(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB, false, true);
}
function limbArm(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB, dot) {
  return limb(ctx, hipX, hipY, a, b, upperLen, lowerLen, facing, wA, wB, dot, false);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p - needs: x, y (feet), vx, vy, facing, grounded,
 *                     attack ({type,t,dur}|null), walkCycle (0..1), idleT, squash (0..1)
 * @param {string} color
 * @return {{headY:number}} so callers can position an HP bar / nametag above the head
 */
function drawStickman(ctx, p, color) {
  var cx = p.x, feet = p.y;
  var running = p.grounded && p.vx !== 0;
  var squash = p.squash || 0;
  var stretch = !p.grounded ? clamp(Math.abs(p.vy) / 14, 0, 1) : 0;
  // jump takeoff pop: a brief stretch right after launch, independent of fall-stretch above.
  var jumpAntic = clamp((p.jumpAnticT || 0) / 90, 0, 1);
  var takeoffStretch = jumpAntic * Math.sin(jumpAntic * Math.PI);
  // landing bounce refinement: on top of the linear squash decay, add a tiny damped-sine
  // (over-compress -> micro rebound -> settle), so the landing reads like a ball, not a clamp.
  var squashWave = squash > 0 ? Math.sin(squash * Math.PI * 2.4) * squash * squash * 0.35 : 0;
  var scaleY = 1 - squash * 0.16 + squashWave * 0.06 + stretch * 0.08 + takeoffStretch * 0.14;
  var scaleX = 1 + squash * 0.18 - squashWave * 0.05 - stretch * 0.05 - takeoffStretch * 0.08;

  var phaseNow = p.walkCycle || 0;
  // two soft bounces per stride (weight passing over each foot) — bigger than a walk's,
  // since a sprinting stride has real vertical drive.
  var runBob = running ? -Math.abs(Math.sin(phaseNow * Math.PI * 2)) * 3.9 : 0;
  // idle: a slow chest-rise breathing cycle, plus a slower weight-shift sway.
  var breathe = p.grounded && !running ? Math.sin(p.idleT * 1.1) * 1.6 : 0;
  var idleBob = p.grounded && !running ? Math.sin(p.idleT * 1.6) * 0.6 + breathe * 0.6 : 0;
  // weight-shift: a slow, low-frequency sway that favors one leg at a time (not symmetric
  // breathing) — biases the two idle leg angles oppositely.
  var idleWeight = p.grounded && !running ? Math.sin(p.idleT * 0.35) : 0;
  // shoulder rotation + head micro-turn, each at their own slow frequency so idle never
  // reads as one robotic bob repeating in lockstep.
  var idleShoulderRot = p.grounded && !running ? Math.sin(p.idleT * 0.5 + 1.1) * 2.2 : 0;
  var idleHeadTurn = p.grounded && !running ? Math.sin(p.idleT * 0.8 + 2.4) * 1.4 : 0;
  var idleHandDrift = p.grounded && !running ? Math.sin(p.idleT * 1.3 + 0.6) * 2 : 0;

  // Shorter, stockier proportions than before.
  var bodyH = 37 * scaleY;
  var hipY = feet - bodyH * 0.52 - runBob - idleBob;
  var hipX = cx + (p.grounded && !running ? Math.sin(p.idleT * 0.7) * 1 + idleWeight * 1.4 : 0);

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
  if (running) lean = p.facing * 13;
  else if (punching) lean = p.facing * (4 + snap * 5);
  else if (kicking) lean = -p.facing * snap * 5; // counter-lean away from the kicking leg
  else if (!p.grounded) lean = p.facing * clamp(p.vy / 9, -1, 1) * 6;
  else lean = idleShoulderRot * 0.3;

  // knockback: torso tilts away from the hit and springs back over ~180ms (secondary motion,
  // not an instant snap). hitStunT/hitDir are additive fields set by screen.html on a landed hit.
  var hitStun = clamp((p.hitStunT || 0) / 180, 0, 1);
  var hitKick = hitStun * Math.sin(hitStun * Math.PI); // rises then eases back to 0
  lean += -(p.hitDir || 1) * hitKick * 16;

  // pelvis vs shoulder rotation split: while running the shoulders twist a touch more than the
  // hips and slightly out of phase, so the torso doesn't rotate as one rigid block.
  var twist = running ? Math.sin(phaseNow * Math.PI * 2 + 0.6) * 4 : 0;
  var shoulderLean = lean + twist;

  var shoulderY = hipY - bodyH * 0.5 + breathe * 0.5;
  var leanRad = lean * DEG;
  var shoulderRad = shoulderLean * DEG;
  var shoulderX = hipX + Math.sin(shoulderRad) * (hipY - shoulderY);
  // slight secondary lag on the head, like it's loosely hinged rather than welded on.
  var headLagPhase = running ? phaseNow - 0.09 : phaseNow;
  var headBob = running ? -Math.abs(Math.sin(headLagPhase * Math.PI * 2)) * 3.4 : 0;
  var headLean = shoulderLean + (running ? twist * 0.4 : idleHeadTurn);
  var headRad = headLean * DEG;
  var headX = shoulderX + Math.sin(headRad) * 10 - (p.hitDir || 1) * hitKick * 3;
  var headY = shoulderY - 13 - headBob + idleBob * 0.3;

  ctx.save();
  ctx.translate(cx, feet);
  ctx.scale(scaleX, 1);
  ctx.translate(-cx, -feet);
  // round caps/joins make the software rasterizer stroke extra corner geometry on every
  // segment; butt/miter are the cheap defaults, and at this line width the visual difference
  // is negligible next to the frame-rate win.
  ctx.lineCap = window.SNAIL_MODE ? "butt" : "round";
  ctx.lineJoin = window.SNAIL_MODE ? "miter" : "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (!window.SNAIL_MODE) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
  }

  var THIGH = 12.5, SHIN = 13.5, UARM = 10, FARM = 11;

  // ---- legs first, so the torso overlaps them like a real silhouette ----
  if (kicking) {
    // planted support leg takes a slight backward give, bracing the kick
    limbLeg(ctx, hipX, hipY, -14, 10, THIGH, SHIN, p.facing, 4.6, 3.4);
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
    limbLeg(ctx, hipX, hipY, -10, 8, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, 14, 10, THIGH, SHIN, p.facing, 4.6, 3.4);
  } else {
    // fighting stance: staggered, knees bent and ready, not a flat-footed idle stand.
    // weight-shift biases the two legs oppositely, so the stance visibly favors one side.
    limbLeg(ctx, hipX, hipY, IDLE_LEGS[0].a + idleWeight * 5, IDLE_LEGS[0].b, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, IDLE_LEGS[1].a - idleWeight * 5, IDLE_LEGS[1].b, THIGH, SHIN, p.facing, 4.6, 3.4);
  }

  // ---- torso ----
  ctx.lineWidth = 4.8;
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.quadraticCurveTo(hipX + Math.sin(leanRad) * 6, (hipY + shoulderY) / 2, shoulderX, shoulderY);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(hipX, hipY, 2.1, 0, Math.PI * 2); ctx.fill();

  // ---- arms ----
  if (punching) {
    // off arm stays cocked by the chin, guard-style
    limbArm(ctx, shoulderX, shoulderY, -20, 46, UARM, FARM, p.facing, 4.2, 3.2, false);
    // punching arm: keyframed across the strike (wind-up -> throw -> recovery)
    var pa = sampleTableOnce(PUNCH_ARM_KEYS, attackLin);
    limbArm(ctx, shoulderX, shoulderY, pa.a, pa.b, UARM, FARM, p.facing, 4.2, 3.4, true);
  } else if (kicking) {
    limbArm(ctx, shoulderX, shoulderY, -30, 40, UARM, FARM, p.facing, 4.2, 3.2, true); // thrown back for balance
    limbArm(ctx, shoulderX, shoulderY, 26, 34, UARM, FARM, p.facing, 4.2, 3.2, true);
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
    var armSway = breathe * 4;
    limbArm(ctx, shoulderX, shoulderY, IDLE_ARMS[0].a - armSway + idleHandDrift, IDLE_ARMS[0].b, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, IDLE_ARMS[1].a + armSway - idleHandDrift, IDLE_ARMS[1].b, UARM, FARM, p.facing, 4.2, 3.2);
  }

  // ---- head ----
  ctx.lineWidth = 4.4;
  ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(headX, headY + 8); ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.ellipse(headX, headY, 7.6, 8.8, 0, 0, Math.PI * 2); ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.restore();

  return { headY: headY };
}
