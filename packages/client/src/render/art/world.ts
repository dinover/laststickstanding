/* Arte del mundo: fondos por bioma, plataformas, decoraciones animadas y púas. Port de V1
   (world.js) con dos cambios de fondo:
   - Lo estático (cielo, capas de parallax, plataformas, púas) se hornea UNA vez por mapa en
     canvases que el renderer sube como texturas WebGL; por cuadro solo se dibujan las
     decoraciones animadas. En V1 las plataformas se redibujaban con shadowBlur en cada cuadro.
   - Los fondos ganaron capas (bruma de horizonte, halo del astro) aprovechando que el horneado
     se paga una sola vez. */

import { getBiome, mulberry32, type BiomeId, type MapDef, type Platform, type Hazard } from "@lss/shared";
import { artCfg } from "./config";
import {
  paintArches, paintAurora, paintFog, paintLavaGlow, paintNeonSkyline, paintPines, paintSnowMountains, paintSynthGrid, paintSynthSun, paintVolcano,
} from "./scenery";

type Ctx = CanvasRenderingContext2D;
const TWO_PI = Math.PI * 2;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ================================================================ fondos */
export interface BackgroundLayers {
  sky: HTMLCanvasElement;
  far: HTMLCanvasElement;
  near: HTMLCanvasElement;
  biome: BiomeId;
}

function paintSky(ctx: Ctx, W: number, H: number, biomeId: BiomeId) {
  const b = getBiome(biomeId);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, b.sky[0]);
  grad.addColorStop(1, b.sky[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Bruma de horizonte: una banda de luz del color del bioma, lo que da profundidad al fondo.
  const haze = ctx.createLinearGradient(0, H * 0.45, 0, H);
  haze.addColorStop(0, rgba(b.light, 0));
  haze.addColorStop(0.55, rgba(b.light, 0.07));
  haze.addColorStop(1, rgba(b.light, 0.02));
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
}

function paintStars(ctx: Ctx, W: number, H: number, rng: () => number, color: string, count: number) {
  for (let i = 0; i < count; i++) {
    const x = rng() * W, y = rng() * H * 0.7, r = 0.6 + rng() * 1.2;
    ctx.globalAlpha = 0.25 + rng() * 0.5;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TWO_PI); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function paintCelestial(ctx: Ctx, rng: () => number, biomeId: BiomeId) {
  const isNight = biomeId === "neon" || biomeId === "ruinas" || biomeId === "volcan";
  const cx = 130 + rng() * 200, cy = 70 + rng() * 40, r = 30;
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 4.2);
  glow.addColorStop(0, isNight ? "rgba(216,226,255,.28)" : "rgba(255,214,140,.32)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx, cy, r * 4.2, 0, TWO_PI); ctx.fill();
  ctx.fillStyle = isNight ? "rgba(230,235,255,.9)" : "rgba(255,224,160,.95)";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TWO_PI); ctx.fill();
}

function paintSilhouetteRange(ctx: Ctx, W: number, H: number, rng: () => number, baseY: number, amp: number, color: string, n: number) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, baseY);
  const step = W / n;
  for (let i = 0; i <= n; i++) ctx.lineTo(i * step, baseY - rng() * amp);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
}

function paintColumns(ctx: Ctx, W: number, rng: () => number, baseY: number, color: string, n: number) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const w = 14 + rng() * 10;
    const x = (W / n) * i + rng() * 20;
    const h = 60 + rng() * 90;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, baseY - h, w, h);
    ctx.fillRect(x - 4, baseY - h - 6, w + 8, 6); // capitel
  }
  ctx.globalAlpha = 1;
}

/** Hornea las tres capas de un bioma a `scale` píxeles por unidad de mundo. */
export function buildBackground(biomeId: BiomeId, seed: number, W: number, H: number, scale: number): BackgroundLayers {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const sky = makeCanvas(W * scale, H * scale);
  const far = makeCanvas(W * scale, H * scale);
  const near = makeCanvas(W * scale, H * scale);

  const s = sky.getContext("2d")!, f = far.getContext("2d")!, n = near.getContext("2d")!;
  s.scale(scale, scale); f.scale(scale, scale); n.scale(scale, scale);
  paintSky(s, W, H, biomeId);

  if (biomeId === "neon") {
    paintStars(s, W, H, rng, "#dfe6ff", 70);
    paintSynthSun(s, W * (0.3 + rng() * 0.4), 300, 92);
    paintSynthGrid(f, W, H, 392);
    paintNeonSkyline(f, W, rng, 392, "rgba(22,14,46,.92)", 13, 0.28);
    paintNeonSkyline(n, W, rng, 560, "rgba(8,5,20,.9)", 9, 0.07, 120);
  } else if (biomeId === "volcan") {
    paintStars(s, W, H, rng, "#ffb37a", 50);
    paintVolcano(s, W, rng);
    paintSilhouetteRange(f, W, H, rng, 380, 110, "rgba(30,8,6,.8)", 9);
    paintLavaGlow(f, W, H);
    paintSilhouetteRange(n, W, H, rng, 470, 60, "rgba(18,4,3,.92)", 7);
  } else if (biomeId === "bosque") {
    paintCelestial(s, rng, biomeId);
    paintSilhouetteRange(s, W, H, rng, 300, 60, "rgba(20,44,30,.5)", 12);
    paintPines(f, W, rng, 380, "rgba(10,26,16,.85)", 26, 90, 170);
    paintFog(f, W, 390, 50, "#9dff8a", 0.06);
    paintPines(n, W, rng, 470, "rgba(5,14,8,.95)", 16, 120, 230);
    paintFog(n, W, 520, 60, "#b8ffc0", 0.05);
  } else if (biomeId === "nieve") {
    paintStars(s, W, H, rng, "#eaf4ff", 60);
    paintAurora(s, W, rng);
    paintSnowMountains(f, W, H, rng, 360, 170, "rgba(28,40,60,.95)", "rgba(220,236,255,.55)", 10);
    paintFog(f, W, 380, 40, "#dbeeff", 0.08);
    paintSnowMountains(n, W, H, rng, 470, 110, "rgba(16,24,38,.97)", "rgba(230,242,255,.4)", 8);
  } else {
    paintStars(s, W, H, rng, "#dfe6ff", 90);
    paintCelestial(s, rng, biomeId);
    paintArches(f, W, rng, 360, "rgba(90,100,150,.35)", 6);
    paintColumns(f, W, rng, 360, "rgba(120,130,180,.4)", 8);
    paintFog(f, W, 380, 40, "#b8c6ff", 0.05);
    paintColumns(n, W, rng, 480, "rgba(50,58,96,.7)", 6);
    paintArches(n, W, rng, 500, "rgba(40,46,80,.65)", 3);
  }
  return { sky, far, near, biome: biomeId };
}

/** Miniatura estática de un bioma (tarjetas de tema de Práctica Libre, fondo del lobby). */
export function drawBackgroundThumb(ctx: Ctx, biomeId: BiomeId, seed: number, w: number, h: number) {
  const layers = buildBackground(biomeId, seed, 1152, 648, Math.min(1, w / 1152 * 1.5));
  ctx.drawImage(layers.sky, 0, 0, w, h);
  ctx.drawImage(layers.far, 0, 0, w, h);
  ctx.drawImage(layers.near, 0, 0, w, h);
}

/* ================================================================ plataformas (estático) */
function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlatformStatic(ctx: Ctx, pl: Platform, biomeId: BiomeId) {
  const style = getBiome(biomeId).platform;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = style.base;
  roundedRect(ctx, pl.x, pl.y, pl.w, pl.h, 6);
  ctx.fill();
  ctx.restore();

  // cara con degradé vertical (luz arriba) + un borde inferior más oscuro
  const g = ctx.createLinearGradient(0, pl.y, 0, pl.y + pl.h);
  g.addColorStop(0, "rgba(255,255,255,.12)");
  g.addColorStop(0.5, "rgba(255,255,255,.02)");
  g.addColorStop(1, "rgba(0,0,0,.25)");
  ctx.fillStyle = g;
  roundedRect(ctx, pl.x, pl.y, pl.w, pl.h, 6);
  ctx.fill();

  // borde de acento (el bloom lo hace brillar)
  ctx.fillStyle = style.edge;
  roundedRect(ctx, pl.x + 2, pl.y, pl.w - 4, 3, 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.fillRect(pl.x + 6, pl.y + 0.5, pl.w - 12, 1);
}

/* Púas: base de metal oscuro y dientes con dos caras (una en sombra y otra con luz) que se ponen al
   rojo vivo hacia la punta; el bloom hace brillar solo las puntas. */
function drawSpikes(ctx: Ctx, hz: Hazard) {
  const n = Math.max(2, Math.floor(hz.w / 11));
  const step = hz.w / n;
  const h = 12;
  ctx.fillStyle = "#1c0b10";
  ctx.beginPath(); ctx.roundRect(hz.x - 1, hz.y - 2.5, hz.w + 2, 3.5, 1.5); ctx.fill();
  for (let i = 0; i < n; i++) {
    const x0 = hz.x + i * step, x1 = x0 + step, xm = x0 + step / 2;
    const tipH = h - ((i * 7) % 3) * 0.8;
    const left = ctx.createLinearGradient(0, hz.y, 0, hz.y - tipH);
    left.addColorStop(0, "#3a0d15"); left.addColorStop(0.55, "#8e1a27"); left.addColorStop(1, "#ff5a4a");
    ctx.fillStyle = left;
    ctx.beginPath(); ctx.moveTo(x0 + 0.6, hz.y - 1); ctx.lineTo(xm, hz.y - tipH); ctx.lineTo(xm, hz.y - 1); ctx.closePath(); ctx.fill();
    const right = ctx.createLinearGradient(0, hz.y, 0, hz.y - tipH);
    right.addColorStop(0, "#5c1420"); right.addColorStop(0.55, "#c42a36"); right.addColorStop(1, "#ffb09a");
    ctx.fillStyle = right;
    ctx.beginPath(); ctx.moveTo(xm, hz.y - tipH); ctx.lineTo(x1 - 0.6, hz.y - 1); ctx.lineTo(xm, hz.y - 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,236,220,.95)";
    ctx.beginPath(); ctx.arc(xm, hz.y - tipH + 1.2, 0.9, 0, Math.PI * 2); ctx.fill();
  }
}

/** Hornea plataformas + púas de un mapa en un canvas transparente. */
export function buildPlatformLayer(map: MapDef, W: number, H: number, scale: number): HTMLCanvasElement {
  const c = makeCanvas(W * scale, H * scale);
  const ctx = c.getContext("2d")!;
  ctx.scale(scale, scale);
  for (const pl of map.platforms) drawPlatformStatic(ctx, pl, map.biome);
  for (const hz of map.hazards) drawSpikes(ctx, hz);
  return c;
}

/* ================================================================ decoraciones (por cuadro) */
interface Deco {
  hang: { x: number; len: number; sway?: number; ph: number; leaf?: boolean }[];
  top: { x: number; h?: number; ph: number; dir?: number; rise?: number; spd?: number; r?: number }[];
  face: { x: number; fall?: number; ph: number; spd?: number }[];
  chip?: boolean;
  banner?: { x: number; w: number; len: number; ph: number } | null;
  drip?: { x: number; len: number; ph: number; spd: number };
  sign?: { x: number; ph: number };
  marquee?: { n: number; from: number; step: number; ph: number };
  scan?: { ph: number };
  puff?: { x: number; ph: number; spd: number };
}

const loop = (t: number, ph: number, spd: number) => { const u = (t * spd + ph) % 1; return u < 0 ? u + 1 : u; };

function buildDeco(pl: Platform, biomeId: BiomeId, seed: number): Deco {
  const rng = mulberry32(seed);
  const d: Deco = { hang: [], top: [], face: [] };
  const span = Math.max(10, pl.w - 28);
  let n: number;
  if (biomeId === "bosque") {
    n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) d.hang.push({ x: pl.x + 14 + rng() * span, len: 12 + rng() * 22, sway: 3 + rng() * 4, ph: rng() * TWO_PI, leaf: rng() < 0.7 });
    n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) d.top.push({ x: pl.x + 10 + rng() * Math.max(10, pl.w - 20), h: 4 + rng() * 5, ph: rng() * TWO_PI, dir: rng() < 0.5 ? -1 : 1 });
  } else if (biomeId === "ruinas") {
    d.chip = rng() < 0.6;
    d.banner = rng() < 0.55 ? { x: pl.x + 16 + rng() * Math.max(1, pl.w - 60), w: 14 + rng() * 9, len: 18 + rng() * 14, ph: rng() * TWO_PI } : null;
    n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) d.face.push({ x: pl.x + 8 + rng() * Math.max(8, pl.w - 16), fall: 16 + rng() * 18, ph: rng(), spd: 0.00035 + rng() * 0.0003 });
  } else if (biomeId === "volcan") {
    n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) d.face.push({ x: pl.x + pl.w * (0.2 + rng() * 0.6), ph: rng() * TWO_PI });
    n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) d.top.push({ x: pl.x + 12 + rng() * Math.max(10, pl.w - 24), rise: 16 + rng() * 16, ph: rng(), spd: 0.0004 + rng() * 0.0003, r: 1.2 + rng() * 1.2 });
    d.drip = { x: pl.x + 20 + rng() * Math.max(1, pl.w - 40), len: 12 + rng() * 10, ph: rng(), spd: 0.00042 };
  } else if (biomeId === "neon") {
    d.sign = { x: pl.x + pl.w - 10, ph: rng() * TWO_PI };
    n = Math.max(3, Math.min(9, Math.round(pl.w / 46)));
    d.marquee = { n, from: pl.x + 8, step: (pl.w - 16) / Math.max(1, n - 1), ph: rng() * n };
    d.scan = { ph: rng() };
  } else {
    n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) d.hang.push({ x: pl.x + 12 + rng() * span, len: 7 + rng() * 11, ph: rng() * TWO_PI });
    d.puff = { x: rng() < 0.5 ? pl.x + 8 : pl.x + pl.w - 8, ph: rng(), spd: 0.00028 + rng() * 0.0002 };
  }
  return d;
}

const decoCache = new WeakMap<Platform, { key: string; deco: Deco }>();

function drawDecoration(ctx: Ctx, pl: Platform, biomeId: BiomeId, seed: number, t: number) {
  const key = biomeId + ":" + seed;
  let entry = decoCache.get(pl);
  if (!entry || entry.key !== key) { entry = { key, deco: buildDeco(pl, biomeId, seed) }; decoCache.set(pl, entry); }
  const d = entry.deco;
  const top = pl.y, bot = pl.y + pl.h;
  let u: number;

  if (biomeId === "bosque") {
    ctx.lineWidth = 2;
    for (const v of d.hang) {
      const sway = Math.sin(t * 0.0015 + v.ph) * (v.sway || 3);
      ctx.strokeStyle = "rgba(123,226,106,.55)";
      ctx.beginPath();
      ctx.moveTo(v.x, bot);
      ctx.quadraticCurveTo(v.x + sway * 0.5, bot + v.len * 0.6, v.x + sway, bot + v.len);
      ctx.stroke();
      if (v.leaf) {
        ctx.fillStyle = "rgba(143,212,90,.7)";
        ctx.beginPath(); ctx.ellipse(v.x + sway, bot + v.len + 2, 2.6, 1.5, sway * 0.06, 0, TWO_PI); ctx.fill();
      }
    }
    ctx.strokeStyle = "rgba(123,226,106,.45)";
    ctx.lineWidth = 1.6;
    for (const g of d.top) {
      const bend = Math.sin(t * 0.0021 + g.ph) * 2.2 * (g.dir || 1);
      ctx.beginPath();
      ctx.moveTo(g.x, top);
      ctx.quadraticCurveTo(g.x + bend * 0.4, top - (g.h || 5) * 0.6, g.x + bend, top - (g.h || 5));
      ctx.stroke();
    }
  } else if (biomeId === "ruinas") {
    if (d.chip) {
      ctx.fillStyle = "rgba(0,0,0,.3)";
      ctx.beginPath(); ctx.moveTo(pl.x + pl.w - 10, top); ctx.lineTo(pl.x + pl.w, top); ctx.lineTo(pl.x + pl.w, top + 8); ctx.closePath(); ctx.fill();
    }
    const b = d.banner;
    if (b) {
      const seg = 4;
      ctx.beginPath();
      ctx.moveTo(b.x, bot);
      ctx.lineTo(b.x + b.w, bot);
      for (let k = 1; k <= seg; k++) { const uu = k / seg; ctx.lineTo(b.x + b.w + Math.sin(t * 0.0026 + b.ph + uu * 2.4) * 3 * uu, bot + b.len * uu); }
      for (let k = seg; k >= 1; k--) { const uu = k / seg; ctx.lineTo(b.x + Math.sin(t * 0.0026 + b.ph + uu * 2.4) * 3 * uu, bot + b.len * uu); }
      ctx.closePath();
      ctx.fillStyle = "rgba(159,178,255,.16)";
      ctx.fill();
      ctx.strokeStyle = "rgba(159,178,255,.38)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(205,214,255,.5)";
    for (const m of d.face) {
      u = loop(t, m.ph, m.spd || 0.0004);
      ctx.globalAlpha = Math.sin(u * Math.PI) * 0.55;
      ctx.beginPath(); ctx.arc(m.x, bot + u * (m.fall || 20), 1.1, 0, TWO_PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (biomeId === "volcan") {
    ctx.lineWidth = 1.2;
    for (const cr of d.face) {
      const glow = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.0032 + cr.ph));
      ctx.strokeStyle = "rgba(255,122,60," + glow.toFixed(3) + ")";
      ctx.beginPath(); ctx.moveTo(cr.x, top); ctx.lineTo(cr.x - 6, top + pl.h * 0.6); ctx.lineTo(cr.x + 4, bot); ctx.stroke();
    }
    for (const em of d.top) {
      u = loop(t, em.ph, em.spd || 0.0004);
      ctx.globalAlpha = (1 - u) * 0.7;
      ctx.fillStyle = u < 0.5 ? "#ffb37a" : "#ff7a3c";
      ctx.beginPath();
      ctx.arc(em.x + Math.sin(u * 6 + em.ph * 6) * 3, top - u * (em.rise || 20), (em.r || 1.5) * (1 - u * 0.5), 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const dr = d.drip!;
    u = loop(t, dr.ph, dr.spd);
    if (u < 0.55) {
      const grow = u / 0.55;
      ctx.fillStyle = "rgba(255,122,60,.85)";
      ctx.beginPath(); ctx.ellipse(dr.x, bot + 1.5 + grow * 1.5, 1.4 + grow * 1.2, 1.8 + grow * 2.2, 0, 0, TWO_PI); ctx.fill();
    } else {
      const fall = (u - 0.55) / 0.45;
      ctx.globalAlpha = 1 - fall;
      ctx.fillStyle = "#ff7a3c";
      ctx.beginPath(); ctx.ellipse(dr.x, bot + 4 + fall * dr.len, 1.3, 2.4, 0, 0, TWO_PI); ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else if (biomeId === "neon") {
    const sign = d.sign!;
    const blink = 0.5 + Math.sin(t * 0.004 + sign.ph) * 0.5;
    ctx.fillStyle = "rgba(255,46,214," + (0.5 + blink * 0.5) + ")";
    ctx.beginPath(); ctx.arc(sign.x, top - 4, 2.4, 0, TWO_PI); ctx.fill();
    const mq = d.marquee!;
    const head = (t * 0.006 + mq.ph) % mq.n;
    for (let i = 0; i < mq.n; i++) {
      const rel = (i - head + mq.n) % mq.n;
      const lit = rel < 2 ? 1 - rel / 2 : 0;
      if (lit <= 0.02) continue;
      ctx.fillStyle = "rgba(53,240,224," + (0.2 + lit * 0.65).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(mq.from + i * mq.step, top + 1.5, 1.3, 0, TWO_PI); ctx.fill();
    }
    u = loop(t, d.scan!.ph, 0.00022);
    ctx.globalAlpha = Math.sin(u * Math.PI) * 0.35;
    ctx.fillStyle = "#35f0e0";
    ctx.fillRect(pl.x + 3, top + u * pl.h, pl.w - 6, 1);
    ctx.globalAlpha = 1;
  } else if (biomeId === "nieve") {
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.fillRect(pl.x + 2, top - 2, pl.w - 4, 2);
    for (const ic of d.hang) {
      const shine = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(t * 0.0012 + ic.ph));
      ctx.fillStyle = "rgba(216,236,255," + shine.toFixed(3) + ")";
      ctx.beginPath(); ctx.moveTo(ic.x - 2.2, bot); ctx.lineTo(ic.x + 2.2, bot); ctx.lineTo(ic.x, bot + ic.len); ctx.closePath(); ctx.fill();
    }
    const pf = d.puff!;
    u = loop(t, pf.ph, pf.spd);
    const away = pf.x < pl.x + pl.w / 2 ? -1 : 1;
    ctx.globalAlpha = Math.sin(u * Math.PI) * 0.5;
    ctx.fillStyle = "#eaf4ff";
    for (let i = 0; i < 3; i++) {
      const pu = u + i * 0.06;
      ctx.beginPath(); ctx.arc(pf.x + away * pu * 22, top - 2 - pu * 10 - i * 1.5, 1.6 - i * 0.35, 0, TWO_PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/** Decoración animada de UNA plataforma (el renderer tiene un sprite chico por plataforma). */
export function drawDecorations(ctx: Ctx, map: MapDef, tMs: number, index: number) {
  if (artCfg.low) return;
  const pl = map.platforms[index];
  if (pl) drawDecoration(ctx, pl, map.biome, (map.seed || 1) + index * 101, tMs);
}
