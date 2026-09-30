/* Muñeco V2 en Pixi: el pintor de stickPaint.ts sobre Graphics (vectores en GPU, sin subir un canvas
   por jugador por cuadro), más lo que solo existe en el juego:

   - Estela de golpe ("swoosh") con una malla de Pixi que cubre el arco real que barrió el puño o
     el pie (muestreado de la curva de animación), en vez de repetir el muñeco entero como fantasma.
   - Haz de luz al agarrar un poder, ecos del poder de aire, fundido de muerte con AlphaFilter.
   - Accesorio: el dibujo V1 (Canvas 2D, afinado a mano) en un sprite propio que se mueve y rota con
     la cabeza, un poco más abajo que antes para que quede puesto. */

import { AlphaFilter, CanvasSource, Container, Graphics, MeshSimple, Sprite, Texture } from "pixi.js";
import { POWER_COLORS, POWER_TYPES } from "@lss/shared";
import { drawAccessory, firstActivePower, type RenderPlayer } from "./art/stickman";
import { makeCanvas } from "./art/world";
import { solveRig, type Pt, type Rig, type RigState } from "./rig";
import { hatDrop, hexN, mixNum, paintSilhouette, paintStick, SWOOSH_TINT, type HeadStyle } from "./stickPaint";

export type { HeadStyle } from "./stickPaint";
export { mixNum } from "./stickPaint";

const DEG = Math.PI / 180;
const SMEAR_N = 10;

/* ---------------------------------------------------------------- accesorio */
const ANIMATED_HATS = new Set(["halo", "flame", "propeller", "orbit"]);

class HatSprite {
  sprite = new Sprite(Texture.EMPTY);
  private canvas = makeCanvas(2, 2);
  private source: CanvasSource | null = null;
  private key = "";
  private static readonly BOX = 76;

  constructor() { this.sprite.anchor.set(0.5); }

  update(kind: string, head: Pt, rotDeg: number, facing: number, t: number, scale: number) {
    const visible = !!kind && kind !== "none";
    this.sprite.visible = visible;
    if (!visible) return;
    const key = kind + ":" + facing + ":" + scale;
    if (key !== this.key || ANIMATED_HATS.has(kind)) {
      const px = Math.ceil(HatSprite.BOX * scale);
      if (key !== this.key) {
        this.canvas.width = px; this.canvas.height = px;
        this.source?.destroy();
        this.source = new CanvasSource({ resource: this.canvas });
        this.sprite.texture = new Texture({ source: this.source });
        this.sprite.scale.set(1 / scale);
        this.key = key;
      }
      const ctx = this.canvas.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      ctx.setTransform(scale, 0, 0, scale, px / 2, px / 2);
      drawAccessory(ctx, kind, 0, hatDrop(kind), 0, facing, t);
      this.source!.update();
    }
    this.sprite.position.set(head.x, head.y);
    this.sprite.rotation = rotDeg * DEG;
  }

  destroy() { this.sprite.destroy(); this.source?.destroy(); }
}

/* ---------------------------------------------------------------- estela de golpe */
/* "Swoosh" como en los juegos de pelea: una malla (MeshSimple de Pixi) que cubre el área que barrió
   el miembro en los últimos ~70 ms de animación. Borde exterior = trayectoria de la punta, borde
   interior = trayectoria de la mitad del miembro. La textura se desvanece hacia lo viejo (u) y hacia
   adentro (v), con un filo brillante sobre el borde exterior. */
let swooshTex: Texture | null = null;
function swooshTexture(): Texture {
  if (swooshTex) return swooshTex;
  const W = 128, H = 64;
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const across = Math.pow(1 - v, 1.6) * 0.75 + (v < 0.1 ? (1 - v / 0.1) * 0.35 : 0);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const along = Math.pow(u, 1.8);
      const a = Math.min(1, across * along);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  swooshTex = Texture.from(c);
  return swooshTex;
}

function swooshMesh(): MeshSimple {
  const n = SMEAR_N;
  const uvs = new Float32Array(n * 4);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    uvs.set([u, 0, u, 1], i * 4);
    if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  }
  const m = new MeshSimple({ texture: swooshTexture(), vertices: new Float32Array(n * 4), uvs, indices: new Uint32Array(idx) });
  m.visible = false;
  return m;
}

/** Haz de luz vertical al agarrar un poder: suave a los costados y que se desvanece hacia arriba. */
let beamTex: Texture | null = null;
function beamSprite(): Sprite {
  if (!beamTex) {
    const W = 64, H = 128, c = makeCanvas(W, H), ctx = c.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = Math.abs(x / (W - 1) - 0.5) * 2, v = y / (H - 1);
      const a = Math.pow(1 - u, 2.2) * Math.pow(v, 1.4);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    beamTex = Texture.from(c);
  }
  const s = new Sprite(beamTex);
  s.anchor.set(0.5, 1);
  s.visible = false;
  return s;
}

/* ---------------------------------------------------------------- vista del muñeco */
export interface StickDrawOpts {
  low: boolean;
  head: HeadStyle;
  /** 0..1: destello blanco al recibir un golpe. */
  whiten: number;
  /** Resolución del sprite del accesorio. */
  scale: number;
  alpha: number;
}

export class StickView {
  readonly root = new Container();
  readonly state: RigState = {};
  rig: Rig | null = null;
  private ground = new Graphics();
  private beam = beamSprite();
  private echo = new Graphics();
  private smear = swooshMesh();
  private body = new Graphics();
  private front = new Graphics();
  private hat = new HatSprite();
  private fade = new AlphaFilter({ alpha: 1 });
  private echoes: Rig[] = [];
  private echoT = 0;
  private fading = false;
  private powerKey = "";
  private powerUpT = 0;
  private lastIdle = -1;

  constructor() {
    this.root.addChild(this.beam, this.ground, this.echo, this.smear, this.body, this.hat.sprite, this.front);
  }

  draw(p: RenderPlayer, colorHex: number, hat: string, o: StickDrawOpts): Rig {
    const r = solveRig(p, this.state, o.low);
    this.rig = r;
    const t = p.idleT || 0;
    const dt = this.lastIdle < 0 ? 16.7 : Math.max(0, Math.min(60, (t - this.lastIdle) * 1000));
    this.lastIdle = t;
    const pw = p.power;

    // destello al agarrar un poder
    const key = pw ? POWER_TYPES.filter((k) => pw[k]).join(",") : "";
    if (key !== this.powerKey) { if (key) this.powerUpT = 450; this.powerKey = key; }
    if (this.powerUpT > 0) this.powerUpT = Math.max(0, this.powerUpT - dt);
    const upU = this.powerUpT / 450;

    const { main, own } = paintStick(
      { ground: this.ground.clear(), body: this.body.clear(), front: this.front.clear() },
      p, r, colorHex, { low: o.low, head: o.head, whiten: o.whiten, powerUp: upU },
    );

    const ownNow = firstActivePower(pw);
    if (upU > 0 && ownNow) {
      const c = hexN(POWER_COLORS[ownNow]), e = 1 - Math.pow(upU, 2);
      this.beam.visible = true;
      this.beam.tint = mixNum(c, 0xffffff, 0.35);
      this.beam.alpha = upU * 0.8;
      this.beam.position.set(p.x, p.y + 2);
      this.beam.scale.set((28 * (0.4 + upU * 0.6)) / 64, (30 + 90 * e) / 128);
    } else this.beam.visible = false;

    // ecos del poder de aire: siluetas planas de los últimos cuadros
    const eg = this.echo.clear();
    if (!o.low && p.alive && pw?.aire) {
      const now = t * 1000;
      if (now - this.echoT >= 22) { this.echoT = now; this.echoes.push(r); if (this.echoes.length > 5) this.echoes.shift(); }
      const c = mixNum(hexN(POWER_COLORS.aire), main, 0.3);
      this.echoes.forEach((e, i) => paintSilhouette(eg, e, c, 0.05 + ((i + 1) / (this.echoes.length + 1)) * 0.16));
    } else this.echoes.length = 0;

    // estela del golpe: el arco real que recorrió la punta en los últimos ~70 ms de animación
    this.updateSmear(p, r, own ? SWOOSH_TINT[own] : main, o.low);

    this.hat.update(hat, r.head, r.headLean * r.facing, r.facing, t, o.scale);

    // fundido de muerte con AlphaFilter: con alfa por forma se verían las superposiciones
    const fading = o.alpha < 1;
    if (fading) this.fade.alpha = o.alpha;
    if (fading !== this.fading) { this.fading = fading; this.root.filters = fading ? [this.fade] : []; }
    return r;
  }

  private updateSmear(p: RenderPlayer, r: Rig, color: number, low: boolean) {
    const s = r.strike;
    if (low || !s || !p.attack || r.spin > 0) { this.smear.visible = false; return; }
    const kick = s.kind === "kick";
    const dur = p.attack.dur || (kick ? 280 : 140);
    const span = kick ? 0.3 : 0.24;
    const v = this.smear.vertices;
    let len = 0, px = 0, py = 0;
    for (let i = 0; i < SMEAR_N; i++) {
      const u = Math.max(0.06, s.progress - span * (1 - i / (SMEAR_N - 1)));
      const q = i === SMEAR_N - 1 ? r : solveRig({ ...p, attack: { ...p.attack, t: dur * (1 - u) } }, null, false);
      const root = kick ? q.hip : q.shoulder, tip = kick ? q.footB : q.handB;
      const k = kick ? 0.42 : 0.55;
      v[i * 4] = tip.x; v[i * 4 + 1] = tip.y;
      v[i * 4 + 2] = root.x + (tip.x - root.x) * k; v[i * 4 + 3] = root.y + (tip.y - root.y) * k;
      if (i) len += Math.hypot(tip.x - px, tip.y - py);
      px = tip.x; py = tip.y;
    }
    this.smear.visible = len > 4;
    this.smear.tint = mixNum(color, 0xffffff, 0.2);
    // aparece de golpe con el latigazo y se apaga mientras se sostiene el impacto
    this.smear.alpha = Math.max(0, Math.min(1, (0.7 - s.progress) * 3.5, (s.progress - 0.1) * 8)) * 0.85;
  }

  destroy() {
    this.hat.destroy();
    this.root.destroy({ children: true });
  }
}
