/* Partículas en GPU (ParticleContainer de Pixi, blending aditivo). Reemplaza el pool de 220
   círculos con shadowBlur de V1, que era de lo más caro de cada cuadro: acá hay miles de sprites
   baratos y el brillo lo pone el bloom. */

import { Container, Particle, ParticleContainer, Texture, Graphics, type Renderer as PixiRenderer } from "pixi.js";

interface P {
  sprite: Particle;
  active: boolean;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
  drag: number;
  spin: number;
  shrink: boolean;
}

export interface SpawnOpts {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  life?: number;
  size?: number;
  color?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
  alpha?: number;
  shrink?: boolean;
}

export function makeDotTexture(renderer: PixiRenderer, radius = 16): Texture {
  const g = new Graphics();
  // disco suave: capas concéntricas con alfa creciente hacia el centro
  const steps = 8;
  for (let i = steps; i >= 1; i--) {
    const r = (radius * i) / steps;
    g.circle(radius, radius, r).fill({ color: 0xffffff, alpha: 0.12 + (1 - i / steps) * 0.5 });
  }
  const tex = renderer.generateTexture({ target: g, resolution: 1 });
  g.destroy();
  return tex;
}

export class ParticleSystem {
  readonly container: ParticleContainer;
  private pool: P[] = [];
  private cursor = 0;

  constructor(private texture: Texture, size: number, additive = true) {
    this.container = new ParticleContainer({
      dynamicProperties: { position: true, vertex: true, rotation: true, color: true },
    });
    if (additive) this.container.blendMode = "add";
    for (let i = 0; i < size; i++) {
      const sprite = new Particle({ texture, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
      this.container.addParticle(sprite);
      this.pool.push({ sprite, active: false, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, gravity: 0, drag: 0, spin: 0, shrink: true });
    }
  }

  spawn(o: SpawnOpts) {
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    p.active = true;
    p.vx = o.vx || 0;
    p.vy = o.vy || 0;
    p.life = p.maxLife = o.life || 400;
    p.size = o.size || 2.4;
    p.gravity = o.gravity ?? 0.0009;
    p.drag = o.drag ?? 0.002;
    p.spin = o.spin || 0;
    p.shrink = o.shrink ?? true;
    const s = p.sprite;
    s.x = o.x;
    s.y = o.y;
    s.tint = o.color ?? 0xffffff;
    s.alpha = o.alpha ?? 1;
    const sc = (p.size * 2) / this.texture.width;
    s.scaleX = s.scaleY = sc;
    s.rotation = 0;
  }

  burst(x: number, y: number, n: number, o: {
    minSpd?: number; maxSpd?: number; minLife?: number; lifeRange?: number; minSize?: number; sizeRange?: number;
    color?: number; gravity?: number; drag?: number; vSquash?: number; cone?: { dir: number; spread: number };
  } = {}) {
    for (let i = 0; i < n; i++) {
      const ang = o.cone ? o.cone.dir + (Math.random() - 0.5) * o.cone.spread : Math.random() * Math.PI * 2;
      const spd = (o.minSpd ?? 0.5) + Math.random() * (o.maxSpd ?? 2.2);
      this.spawn({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd * (o.vSquash ?? 1),
        life: (o.minLife ?? 250) + Math.random() * (o.lifeRange ?? 250),
        size: (o.minSize ?? 1.4) + Math.random() * (o.sizeRange ?? 1.8),
        color: o.color,
        gravity: o.gravity,
        drag: o.drag,
      });
    }
  }

  update(dt: number) {
    const f = dt * 0.06;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      const s = p.sprite;
      if (p.life <= 0) { p.active = false; s.alpha = 0; continue; }
      p.vy += p.gravity * dt;
      const dk = Math.max(0, 1 - p.drag * dt);
      p.vx *= dk; p.vy *= dk;
      s.x += p.vx * f;
      s.y += p.vy * f;
      const a = p.life / p.maxLife;
      s.alpha = Math.min(1, a * 1.4);
      if (p.shrink) {
        const sc = ((p.size * 2) / this.texture.width) * (0.45 + a * 0.55);
        s.scaleX = s.scaleY = sc;
      }
      if (p.spin) s.rotation += p.spin * dt;
    }
  }

  clear() {
    for (const p of this.pool) { p.active = false; p.sprite.alpha = 0; }
  }
}

export function hexToNum(color: string): number {
  if (color.startsWith("#")) {
    const h = color.length === 4 ? color.slice(1).split("").map((c) => c + c).join("") : color.slice(1, 7);
    return parseInt(h, 16);
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(",").map((v) => parseFloat(v));
    return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
  }
  return 0xffffff;
}

export type { Container };
