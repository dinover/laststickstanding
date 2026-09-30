/* Efectos de poderes y estados con el motor de partículas de Pixi (@spd789562/particle-emitter, el
   port a v8 del emisor oficial). Separa lo que en V1 se veía igual:

   - QUIEN TIENE EL PODER (mejora): el efecto vive en sus armas. Fuego = puños (y la patada) en
     llamas; hielo = escarcha que cae de los puños; tierra = polvo de piedra que se desprende de la
     armadura; aire = ráfagas de viento y chispas eléctricas alrededor del cuerpo.
   - QUIEN LO SUFRE (estado): el efecto cubre el cuerpo entero. Quemado = llamas y humo saliendo de
     todo el cuerpo; congelado = nieve cayendo alrededor.
   - Golpes con elemento: explosión de fuego, estallido de esquirlas de hielo o piedras al pegarle a
     alguien con armadura.

   La parte "pegada al cuerpo" (puños al rojo, cristales, placas de piedra, anillo del tiempo que
   queda) la dibuja stickPixi.ts sobre el esqueleto. */

import { Emitter, type EmitterConfigV3 } from "@spd789562/particle-emitter";
import { ParticleContainer, Rectangle, Texture } from "pixi.js";
import type { RenderPlayer } from "./art/stickman";
import { makeCanvas } from "./art/world";
import type { Rig } from "./rig";

/* ---------------------------------------------------------------- atlas de partículas */
/* El ParticleContainer de Pixi v8 exige que todas las texturas compartan la misma fuente: todas las
   formas van en un solo canvas. Blancas, para teñirlas con el comportamiento "color". */
type TexName = "dot" | "flame" | "smoke" | "shard" | "streak" | "flake" | "rock" | "ember";
const CELL = 32;
let atlasCache: Record<TexName, Texture> | null = null;

function atlas(): Record<TexName, Texture> {
  if (atlasCache) return atlasCache;
  const names: TexName[] = ["dot", "flame", "smoke", "shard", "streak", "flake", "rock", "ember"];
  const c = makeCanvas(CELL * names.length, CELL);
  const ctx = c.getContext("2d")!;
  const at = (i: number) => { ctx.setTransform(1, 0, 0, 1, i * CELL + CELL / 2, CELL / 2); };
  const radial = (r: number, stops: [number, string][]) => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    for (const [o, col] of stops) g.addColorStop(o, col);
    return g;
  };
  // dot
  at(0); ctx.fillStyle = radial(15, [[0, "rgba(255,255,255,1)"], [0.4, "rgba(255,255,255,.6)"], [1, "rgba(255,255,255,0)"]]); ctx.fillRect(-16, -16, 32, 32);
  // flame: gota con la punta arriba y el núcleo abajo
  at(1);
  ctx.fillStyle = radial(14, [[0, "rgba(255,255,255,1)"], [0.55, "rgba(255,255,255,.55)"], [1, "rgba(255,255,255,0)"]]);
  ctx.beginPath(); ctx.moveTo(0, -15); ctx.bezierCurveTo(7, -5, 11, 3, 8, 9); ctx.bezierCurveTo(5, 15, -5, 15, -8, 9); ctx.bezierCurveTo(-11, 3, -7, -5, 0, -15); ctx.fill();
  // smoke: tres manchas superpuestas
  at(2);
  for (const [x, y, r] of [[-4, 2, 10], [5, -1, 9], [0, -5, 8]] as const) {
    ctx.fillStyle = radial(r, [[0, "rgba(255,255,255,.55)"], [1, "rgba(255,255,255,0)"]]);
    ctx.save(); ctx.translate(x, y); ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
  }
  // shard: esquirla de cristal alargada (apunta a la derecha, se alinea con la velocidad)
  at(3);
  ctx.fillStyle = "rgba(255,255,255,.95)";
  ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-2, -4.5); ctx.lineTo(-13, 0); ctx.lineTo(-2, 4.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-2, -4.5); ctx.lineTo(-2, 0); ctx.closePath(); ctx.fill();
  // streak: raya de velocidad
  at(4);
  const lg = ctx.createLinearGradient(-15, 0, 15, 0);
  lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(0.7, "rgba(255,255,255,.9)"); lg.addColorStop(1, "rgba(255,255,255,1)");
  ctx.fillStyle = lg; ctx.beginPath(); ctx.moveTo(-15, 0); ctx.lineTo(13, -1.8); ctx.quadraticCurveTo(15.5, 0, 13, 1.8); ctx.closePath(); ctx.fill();
  // flake: copito de 6 brazos
  at(5);
  ctx.strokeStyle = "rgba(255,255,255,1)"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * -11, Math.sin(a) * -11); ctx.lineTo(Math.cos(a) * 11, Math.sin(a) * 11); ctx.stroke();
  }
  // rock: piedrita irregular con cara de luz
  at(6);
  ctx.fillStyle = "rgba(200,200,200,1)";
  ctx.beginPath(); ctx.moveTo(-9, 3); ctx.lineTo(-6, -8); ctx.lineTo(5, -10); ctx.lineTo(11, -1); ctx.lineTo(6, 9); ctx.lineTo(-5, 9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath(); ctx.moveTo(-6, -8); ctx.lineTo(5, -10); ctx.lineTo(2, -2); ctx.lineTo(-7, 0); ctx.closePath(); ctx.fill();
  // ember: brasa chica y dura
  at(7); ctx.fillStyle = radial(7, [[0, "rgba(255,255,255,1)"], [0.5, "rgba(255,255,255,.8)"], [1, "rgba(255,255,255,0)"]]); ctx.fillRect(-8, -8, 16, 16);

  const base = Texture.from(c);
  const out = {} as Record<TexName, Texture>;
  names.forEach((n, i) => { out[n] = new Texture({ source: base.source, frame: new Rectangle(i * CELL, 0, CELL, CELL) }); });
  atlasCache = out;
  return out;
}

/* ---------------------------------------------------------------- recetas */
type V = { value: number | string; time: number };
const list = (...pairs: [number | string, number][]): { list: V[] } => ({ list: pairs.map(([value, time]) => ({ value, time })) });

interface Recipe {
  tex: TexName;
  additive: boolean;
  life: [number, number];
  freq: number;
  max: number;
  perWave?: number;
  emitterLife?: number;
  alpha: { list: V[] };
  scale: { list: V[] };
  scaleMin?: number;
  color: { list: V[] };
  /** Aceleración (mundo, px/s²) + velocidad inicial y dirección en grados (0 = derecha, 90 = abajo). */
  accel?: { x: number; y: number };
  speed: [number, number];
  dir: [number, number];
  alignToVelocity?: boolean;
  spin?: [number, number];
  shape?: { type: "torus"; data: { x: number; y: number; radius: number; innerRadius?: number } } | { type: "rect"; data: { x: number; y: number; w: number; h: number } };
}

function config(r: Recipe): EmitterConfigV3 {
  const t = atlas();
  const behaviors: EmitterConfigV3["behaviors"] = [
    { type: "alpha", config: { alpha: r.alpha } },
    { type: "scale", config: { scale: r.scale, minMult: r.scaleMin ?? 1 } },
    { type: "color", config: { color: r.color } },
    { type: "rotationStatic", config: { min: r.dir[0], max: r.dir[1] } },
    { type: "moveAcceleration", config: { accel: r.accel || { x: 0, y: 0 }, minStart: r.speed[0], maxStart: r.speed[1], rotate: !!r.alignToVelocity } },
    { type: "textureSingle", config: { texture: t[r.tex] } },
  ];
  if (r.spin) behaviors.push({ type: "rotation", config: { accel: 0, minSpeed: r.spin[0], maxSpeed: r.spin[1], minStart: 0, maxStart: 0 } });
  else if (!r.alignToVelocity) behaviors.push({ type: "noRotation", config: { rotation: 0 } });
  if (r.shape) behaviors.push({ type: "spawnShape", config: r.shape });
  return {
    lifetime: { min: r.life[0], max: r.life[1] },
    frequency: r.freq,
    particlesPerWave: r.perWave ?? 1,
    emitterLifetime: r.emitterLife ?? -1,
    maxParticles: r.max,
    pos: { x: 0, y: 0 },
    addAtBack: false,
    emit: false,
    autoUpdate: false,
    behaviors,
  };
}

const FIRE_COLORS = list(["ffe08a", 0], ["ffa030", 0.25], ["ff4a1a", 0.6], ["7a140a", 1]);

const R = {
  /** Puño/pie en llamas del que tiene fuego. */
  fireFist: {
    tex: "flame", additive: true, life: [0.24, 0.42], freq: 0.008, max: 70,
    alpha: list([0.9, 0], [0.7, 0.5], [0, 1]), scale: list([0.6, 0], [0.14, 1]), scaleMin: 0.6, color: FIRE_COLORS,
    accel: { x: 0, y: -320 }, speed: [10, 45], dir: [235, 305], shape: { type: "torus", data: { x: 0, y: 0, radius: 3 } },
  },
  /** Quemado: el cuerpo entero larga llamas. */
  burnBody: {
    tex: "flame", additive: true, life: [0.3, 0.55], freq: 0.01, max: 90,
    alpha: list([0.9, 0], [0.7, 0.45], [0, 1]), scale: list([0.55, 0], [0.12, 1]), scaleMin: 0.6, color: FIRE_COLORS,
    accel: { x: 0, y: -340 }, speed: [15, 45], dir: [245, 295], shape: { type: "rect", data: { x: -8, y: -50, w: 16, h: 50 } },
  },
  burnSmoke: {
    tex: "smoke", additive: false, life: [0.8, 1.3], freq: 0.07, max: 24,
    alpha: list([0, 0], [0.4, 0.2], [0, 1]), scale: list([0.45, 0], [1.3, 1]), color: list(["4a3a36", 0], ["1c1a1c", 1]),
    accel: { x: 0, y: -40 }, speed: [20, 40], dir: [250, 290], shape: { type: "rect", data: { x: -6, y: -58, w: 12, h: 20 } },
  },
  /** Hielo: escarcha que se desprende de los puños y cae. */
  frostFist: {
    tex: "dot", additive: true, life: [0.45, 0.8], freq: 0.035, max: 30,
    alpha: list([0.55, 0], [0, 1]), scale: list([0.2, 0], [0.45, 1]), color: list(["e6fbff", 0], ["4fd7ff", 1]),
    accel: { x: 0, y: 60 }, speed: [4, 14], dir: [0, 360], shape: { type: "torus", data: { x: 0, y: 0, radius: 3 } },
  },
  frostSparkle: {
    tex: "flake", additive: true, life: [0.5, 0.8], freq: 0.11, max: 10,
    alpha: list([0, 0], [1, 0.25], [0, 1]), scale: list([0.12, 0], [0.26, 0.4], [0.08, 1]), color: list(["ffffff", 0], ["9fe9ff", 1]),
    speed: [2, 8], dir: [0, 360], spin: [-180, 180], shape: { type: "rect", data: { x: -14, y: -58, w: 28, h: 56 } },
  },
  /** Congelado: nieve cayendo alrededor. */
  snow: {
    tex: "flake", additive: false, life: [0.9, 1.4], freq: 0.05, max: 30,
    alpha: list([0, 0], [0.95, 0.2], [0, 1]), scale: list([0.2, 0], [0.26, 1]), scaleMin: 0.6, color: list(["ffffff", 0], ["bfefff", 1]),
    speed: [12, 22], dir: [80, 100], spin: [-120, 120], shape: { type: "rect", data: { x: -18, y: -70, w: 36, h: 36 } },
  },
  /** Tierra: piedritas que se desprenden de la armadura. */
  pebbles: {
    tex: "rock", additive: false, life: [0.45, 0.7], freq: 0.16, max: 10,
    alpha: list([1, 0], [1, 0.7], [0, 1]), scale: list([0.2, 0], [0.14, 1]), scaleMin: 0.6, color: list(["b08a52", 0], ["6e5430", 1]),
    accel: { x: 0, y: 520 }, speed: [25, 55], dir: [215, 325], spin: [-360, 360], shape: { type: "rect", data: { x: -7, y: -44, w: 14, h: 22 } },
  },
  /** Aire: ráfagas de viento (dirección según hacia dónde se mueve) y chispas eléctricas. */
  wind: {
    tex: "streak", additive: true, life: [0.22, 0.34], freq: 0.028, max: 24,
    alpha: list([0, 0], [0.7, 0.3], [0, 1]), scale: list([0.5, 0], [0.8, 1]), color: list(["ffffff", 0], ["c9ffb0", 1]),
    speed: [140, 220], dir: [178, 182], alignToVelocity: true, shape: { type: "rect", data: { x: -10, y: -58, w: 20, h: 58 } },
  },
  zap: {
    tex: "streak", additive: true, life: [0.06, 0.12], freq: 0.06, max: 8,
    alpha: list([1, 0], [0, 1]), scale: list([0.35, 0], [0.2, 1]), color: list(["ffffff", 0], ["d8ff9a", 1]),
    speed: [60, 140], dir: [0, 360], alignToVelocity: true, shape: { type: "rect", data: { x: -12, y: -56, w: 24, h: 52 } },
  },
  /* ---- ráfagas de un solo disparo */
  fireBurst: {
    tex: "flame", additive: true, life: [0.25, 0.5], freq: 0.001, max: 40, perWave: 26, emitterLife: 0.002,
    alpha: list([1, 0], [0, 1]), scale: list([0.6, 0], [0.15, 1]), scaleMin: 0.5, color: FIRE_COLORS,
    accel: { x: 0, y: -180 }, speed: [60, 190], dir: [0, 360],
  },
  emberBurst: {
    tex: "ember", additive: true, life: [0.4, 0.8], freq: 0.001, max: 20, perWave: 14, emitterLife: 0.002,
    alpha: list([1, 0], [0, 1]), scale: list([0.35, 0], [0.1, 1]), color: list(["fff0b0", 0], ["ff6a1f", 1]),
    accel: { x: 0, y: 260 }, speed: [120, 260], dir: [190, 350], alignToVelocity: false,
  },
  iceBurst: {
    tex: "shard", additive: false, life: [0.35, 0.6], freq: 0.001, max: 20, perWave: 12, emitterLife: 0.002,
    alpha: list([1, 0], [1, 0.6], [0, 1]), scale: list([0.5, 0], [0.3, 1]), scaleMin: 0.5, color: list(["ffffff", 0], ["7fe3ff", 1]),
    accel: { x: 0, y: 420 }, speed: [110, 230], dir: [0, 360], alignToVelocity: true,
  },
  iceMist: {
    tex: "smoke", additive: true, life: [0.4, 0.7], freq: 0.001, max: 10, perWave: 7, emitterLife: 0.002,
    alpha: list([0.6, 0], [0, 1]), scale: list([0.4, 0], [1.1, 1]), color: list(["e6fbff", 0], ["4fd7ff", 1]),
    speed: [20, 50], dir: [0, 360],
  },
  rockBurst: {
    tex: "rock", additive: false, life: [0.45, 0.7], freq: 0.001, max: 14, perWave: 9, emitterLife: 0.002,
    alpha: list([1, 0], [1, 0.7], [0, 1]), scale: list([0.3, 0], [0.18, 1]), scaleMin: 0.5, color: list(["c9a46a", 0], ["6e5430", 1]),
    accel: { x: 0, y: 600 }, speed: [90, 190], dir: [200, 340], spin: [-540, 540],
  },
  powerUp: {
    tex: "dot", additive: true, life: [0.5, 0.9], freq: 0.001, max: 40, perWave: 30, emitterLife: 0.002,
    alpha: list([1, 0], [0, 1]), scale: list([0.3, 0], [0.05, 1]), color: list(["ffffff", 0], ["ffffff", 1]),
    accel: { x: 0, y: -160 }, speed: [30, 110], dir: [200, 340], shape: { type: "rect", data: { x: -14, y: -10, w: 28, h: 10 } },
  },
} satisfies Record<string, Recipe>;

type RecipeName = keyof typeof R;

/* ---------------------------------------------------------------- manejador */
interface Tracked { e: Emitter; seen: number }

export class PowerFx {
  /** Fuego, escarcha, viento, chispas: suman luz. */
  readonly add = new ParticleContainer({ dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true } });
  /** Humo, nieve, piedras, esquirlas: tapan. */
  readonly norm = new ParticleContainer({ dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true } });
  private live = new Map<string, Tracked>();
  private bursts: Emitter[] = [];
  private frame = 0;
  private prev = new Map<number, { burn: number; slow: number; stun: number; power: string }>();

  constructor() {
    this.add.blendMode = "add";
  }

  private emitter(key: string, name: RecipeName): Emitter {
    let t = this.live.get(key);
    if (!t) {
      const r = R[name] as Recipe;
      t = { e: new Emitter(r.additive ? this.add : this.norm, config(r)), seen: 0 };
      this.live.set(key, t);
    }
    t.seen = this.frame;
    return t.e;
  }

  /** Enciende/apaga un emisor continuo y lo mueve con su dueño. */
  private drive(key: string, name: RecipeName, on: boolean, x: number, y: number) {
    if (!on && !this.live.has(key)) return;
    const e = this.emitter(key, name);
    e.updateOwnerPos(x, y);
    if (on && !e.emit) { e.resetPositionTracking(); e.emit = true; }
    else if (!on && e.emit) e.emit = false;
  }

  private burst(name: RecipeName, x: number, y: number, color?: string) {
    const r = R[name] as Recipe;
    const cfg = config(r);
    if (color) {
      const b = cfg.behaviors.find((x) => x.type === "color");
      if (b) b.config = { color: list(["ffffff", 0], [color.replace("#", ""), 0.35], [color.replace("#", ""), 1]) };
    }
    const e = new Emitter(r.additive ? this.add : this.norm, cfg);
    e.updateOwnerPos(x, y);
    e.emit = true;
    this.bursts.push(e);
  }

  /** Por jugador y por cuadro: qué emisores corresponden según poderes y estados. */
  update(p: RenderPlayer, r: Rig, low: boolean) {
    const id = p.id;
    const on = p.alive && !low;
    const pw = p.power;
    const kicking = !!p.attack && p.attack.type === "kick";
    // mejora: en las armas
    this.drive(id + ":fireA", "fireFist", on && !!pw?.fuego, r.handA.x, r.handA.y);
    this.drive(id + ":fireB", "fireFist", on && !!pw?.fuego, r.handB.x, r.handB.y);
    this.drive(id + ":fireK", "fireFist", on && !!pw?.fuego && kicking, r.footB.x, r.footB.y);
    this.drive(id + ":frostA", "frostFist", on && !!pw?.hielo, r.handA.x, r.handA.y);
    this.drive(id + ":frostB", "frostFist", on && !!pw?.hielo, r.handB.x, r.handB.y);
    this.drive(id + ":sparkle", "frostSparkle", on && !!pw?.hielo, p.x, p.y);
    this.drive(id + ":pebbles", "pebbles", on && !!pw?.tierra, r.hip.x, p.y);
    const windy = on && !!pw?.aire;
    this.drive(id + ":wind", "wind", windy, p.x, p.y);
    if (windy) {
      // las ráfagas salen hacia atrás cuando corre; quieto, suben en remolino
      const w = this.live.get(id + ":wind")!.e;
      const moving = Math.abs(p.vx) > 0.5 || !p.grounded;
      const ang = moving ? Math.atan2(-(p.vy || 0) * 0.3, -Math.sign(p.vx || p.facing)) : -Math.PI / 2;
      w.rotate(ang - Math.PI);
      w.frequency = moving ? 0.022 : 0.06;
    }
    this.drive(id + ":zap", "zap", windy, p.x, p.y);
    // estado: en todo el cuerpo
    const burning = on && p.burnT > 0;
    this.drive(id + ":burn", "burnBody", burning, r.hip.x, p.y);
    this.drive(id + ":smoke", "burnSmoke", burning, r.hip.x, p.y);
    this.drive(id + ":snow", "snow", on && p.slowT > 0, r.hip.x, p.y);

    // golpes con elemento: se detectan por el cambio de estado (igual en local y online)
    const pv = this.prev.get(id) || { burn: 0, slow: 0, stun: 0, power: "" };
    const chest = { x: (r.hip.x + r.shoulder.x) / 2, y: (r.hip.y + r.shoulder.y) / 2 };
    if (!low && p.alive) {
      if (p.burnT > pv.burn + 250) { this.burst("fireBurst", chest.x, chest.y); this.burst("emberBurst", chest.x, chest.y); }
      if (p.slowT > pv.slow + 250) { this.burst("iceBurst", chest.x, chest.y); this.burst("iceMist", chest.x, chest.y); }
      if (pw?.tierra && p.hitStunT > pv.stun + 30) this.burst("rockBurst", chest.x, chest.y);
      const key = pw ? Object.keys(pw).filter((k) => k !== "t").sort().join(",") : "";
      if (key && key !== pv.power) this.burst("powerUp", p.x, p.y, POWERUP_COLOR[key.split(",")[0]]);
      pv.power = key;
    }
    pv.burn = p.burnT; pv.slow = p.slowT; pv.stun = p.hitStunT;
    this.prev.set(id, pv);
  }

  /** Avanza todas las partículas; los emisores de jugadores que ya no se ven se apagan y liberan. */
  step(dtMs: number) {
    const dt = Math.min(0.05, dtMs / 1000);
    for (const [key, t] of this.live) {
      if (t.seen !== this.frame) t.e.emit = false;
      t.e.update(dt);
      if (this.frame - t.seen > 240 && t.e.particleCount === 0) { t.e.destroy(); this.live.delete(key); }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const e = this.bursts[i];
      e.update(dt);
      if (!e.emit && e.particleCount === 0) { e.destroy(); this.bursts.splice(i, 1); }
    }
    this.frame++;
  }

  clear() {
    for (const t of this.live.values()) t.e.destroy();
    for (const e of this.bursts) e.destroy();
    this.live.clear();
    this.bursts = [];
    this.prev.clear();
  }
}

const POWERUP_COLOR: Record<string, string> = { fuego: "#ff5a2e", hielo: "#4fd7ff", tierra: "#c9a46a", aire: "#c9ffb0" };
