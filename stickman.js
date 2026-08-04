/* Stickman rig + run/jump/attack animation. Pure function of state -> pixels: it reads
   position/velocity/facing/attack off the game's player object and draws one frame.
   No feet are drawn — legs end in a rounded line tip, like a classic stickman. */

var DEG = Math.PI / 180;

/* ---- easing / table sampling ---- */
function smoothstep(u) { return u * u * (3 - 2 * u); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function stage(t, from, to) { return smoothstep(clamp((t - from) / (to - from), 0, 1)); }

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

/* Eight breakpoints per stride, tuned for a RUN (fighters closing distance), not a stroll:
   bigger reach front-to-back, a sharper heel-to-butt knee snap, and a real airborne-looking
   tuck at the top of the swing. A single sine gives a metronome; this gives a sprint. */
var LEG_KEYS = [
  { t: 0.00, a: 36, b: 4 },
  { t: 0.14, a: 16, b: 6 },
  { t: 0.32, a: -18, b: 8 },
  { t: 0.48, a: -34, b: 12 },
  { t: 0.60, a: -14, b: 74 },
  { t: 0.76, a: 16, b: 40 },
  { t: 0.90, a: 32, b: 12 },
  { t: 1.00, a: 36, b: 4 },
];
var ARM_KEYS = [
  { t: 0.00, a: -36, b: 30 },
  { t: 0.25, a: -6, b: 16 },
  { t: 0.50, a: 32, b: 34 },
  { t: 0.75, a: 4, b: 18 },
  { t: 1.00, a: -36, b: 30 },
];

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
  var scaleY = 1 - squash * 0.16 + stretch * 0.08;
  var scaleX = 1 + squash * 0.18 - stretch * 0.05;

  var phaseNow = p.walkCycle || 0;
  // two soft bounces per stride (weight passing over each foot) — bigger than a walk's,
  // since a sprinting stride has real vertical drive.
  var runBob = running ? -Math.abs(Math.sin(phaseNow * Math.PI * 2)) * 3.4 : 0;
  // idle: a slow chest-rise breathing cycle, plus a slower weight-shift sway.
  var breathe = p.grounded && !running ? Math.sin(p.idleT * 1.1) * 1.6 : 0;
  var idleBob = p.grounded && !running ? Math.sin(p.idleT * 1.6) * 0.6 + breathe * 0.6 : 0;

  // Shorter, stockier proportions than before.
  var bodyH = 37 * scaleY;
  var hipY = feet - bodyH * 0.52 - runBob - idleBob;
  var hipX = cx + (p.grounded && !running ? Math.sin(p.idleT * 0.7) * 1 : 0);

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

  var shoulderY = hipY - bodyH * 0.5 + breathe * 0.5;
  var leanRad = lean * DEG;
  var shoulderX = hipX + Math.sin(leanRad) * (hipY - shoulderY);
  // slight secondary lag on the head, like it's loosely hinged rather than welded on.
  var headLagPhase = running ? phaseNow - 0.05 : phaseNow;
  var headBob = running ? -Math.abs(Math.sin(headLagPhase * Math.PI * 2)) * 3.4 : 0;
  var headX = shoulderX + Math.sin(leanRad) * 10;
  var headY = shoulderY - 13 - headBob + idleBob * 0.3;

  ctx.save();
  ctx.translate(cx, feet);
  ctx.scale(scaleX, 1);
  ctx.translate(-cx, -feet);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;

  var THIGH = 12.5, SHIN = 13.5, UARM = 10, FARM = 11;

  // ---- legs first, so the torso overlaps them like a real silhouette ----
  if (kicking) {
    // planted support leg takes a slight backward give, bracing the kick
    limbLeg(ctx, hipX, hipY, -14, 10, THIGH, SHIN, p.facing, 4.6, 3.4);
    // three clean stages: raise the knee high and tucked, snap the shin out at body height,
    // then pull it back in — instead of jumping straight to an extended leg.
    var raise = stage(attackLin, 0, 0.4);
    var throwT = stage(attackLin, 0.35, 0.68);
    var retract = stage(attackLin, 0.75, 1);
    var kHip = lerp(14, 48, raise) + lerp(0, 24, throwT) - lerp(0, 16, retract);
    var kBend = lerp(14, 82, raise) - lerp(0, 96, throwT) + lerp(0, 55, retract);
    limbLeg(ctx, hipX, hipY, kHip, kBend, THIGH, SHIN + 1, p.facing, 4.6, 3.4);
  } else if (!p.grounded) {
    var t = (clamp(p.vy / 9, -1, 1) + 1) / 2; // 0 = launching upward, 1 = falling fast
    // Rising: both knees pull up, shins tucking back behind the thighs (heel toward the
    // seat) for a tight, readable jump silhouette. Falling: legs stretch back out, reaching
    // down for the ground.
    var hipA = lerp(18, 10, t), kneeA = lerp(88, 12, t);
    var hipB = lerp(-4, -14, t), kneeB = lerp(66, 16, t);
    limbLeg(ctx, hipX, hipY, hipA, kneeA, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, hipB, kneeB, THIGH, SHIN, p.facing, 4.6, 3.4);
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
    limbLeg(ctx, hipX, hipY, -11, 9, THIGH, SHIN, p.facing, 4.6, 3.4);
    limbLeg(ctx, hipX, hipY, 10, 8, THIGH, SHIN, p.facing, 4.6, 3.4);
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
    // punching arm: draws the elbow back first, then drives the fist out and snaps it
    // through — a real hook/cross, not just a hand sliding forward.
    var windup = stage(attackLin, 0, 0.3);
    var throwA = stage(attackLin, 0.25, 0.62);
    var recover = stage(attackLin, 0.7, 1);
    var elbowAngle = lerp(-2, -34, windup) + lerp(0, 76, throwA) - lerp(0, 40, recover);
    var reach = lerp(0.15, 0.05, windup) + lerp(0, 0.95, throwA) - lerp(0, 0.35, recover);
    var pElbow = limbEnd(shoulderX, shoulderY, elbowAngle, FARM, p.facing);
    var pHand = limbEnd(pElbow.x, pElbow.y, 88 * clamp(reach, 0, 1), FARM + 1, p.facing);
    ctx.lineWidth = 4.2;
    ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(pElbow.x, pElbow.y); ctx.stroke();
    ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.moveTo(pElbow.x, pElbow.y); ctx.lineTo(pHand.x, pHand.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(pElbow.x, pElbow.y, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(pHand.x, pHand.y, 3, 0, Math.PI * 2); ctx.fill();
  } else if (kicking) {
    limbArm(ctx, shoulderX, shoulderY, -30, 40, UARM, FARM, p.facing, 4.2, 3.2, true); // thrown back for balance
    limbArm(ctx, shoulderX, shoulderY, 26, 34, UARM, FARM, p.facing, 4.2, 3.2, true);
  } else if (!p.grounded) {
    var ta = (clamp(p.vy / 9, -1, 1) + 1) / 2;
    // angle convention: 0 = hanging down, 180 = reaching straight up. Rising throws both
    // arms up for lift; falling brings them down and forward to brace for the landing.
    var shA = lerp(168, 46, ta), elA = lerp(20, 34, ta);
    var shB = lerp(-146, -22, ta), elB = lerp(24, 28, ta);
    limbArm(ctx, shoulderX, shoulderY, shA, elA, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, shB, elB, UARM, FARM, p.facing, 4.2, 3.2);
  } else if (running) {
    var armBack = sampleTable(ARM_KEYS, phaseNow + 0.5);
    var armFront = sampleTable(ARM_KEYS, phaseNow);
    limbArm(ctx, shoulderX, shoulderY, armBack.a, armBack.b, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, armFront.a, armFront.b, UARM, FARM, p.facing, 4.2, 3.2);
  } else {
    // simple resting pose: elbows stay put, relaxed by the sides; only the forearms turn in
    // to bring the fists together in front of the body. Rises and falls gently with the breath.
    var armSway = breathe * 4;
    limbArm(ctx, shoulderX, shoulderY, -8 - armSway, 40, UARM, FARM, p.facing, 4.2, 3.2);
    limbArm(ctx, shoulderX, shoulderY, 8 + armSway, -24, UARM, FARM, p.facing, 4.2, 3.2);
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
