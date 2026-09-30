/* Escenarios de fondo por bioma (V2). Se hornean una sola vez por mapa, así que pueden tener
   todo el detalle que haga falta sin costar nada por cuadro: sol synthwave con grilla en Neón,
   volcán con cráter incandescente, pinos con niebla en Bosque, montañas nevadas con aurora en
   Nieve y arcos caídos en Ruinas. */

type Ctx = CanvasRenderingContext2D;
const TWO_PI = Math.PI * 2;

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function paintSynthSun(ctx: Ctx, cx: number, cy: number, r: number) {
  const halo = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.4);
  halo.addColorStop(0, "rgba(255,94,196,.25)");
  halo.addColorStop(1, "rgba(255,94,196,0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, TWO_PI); ctx.fill();
  const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  g.addColorStop(0, "#ffe27a");
  g.addColorStop(0.5, "#ff5ec4");
  g.addColorStop(1, "#7b2cff");
  // el sol se dibuja en un canvas aparte para poder "recortarle" las franjas sin borrar el cielo
  const c = document.createElement("canvas");
  const S = Math.ceil(r * 2) + 2;
  c.width = S; c.height = S;
  const x = c.getContext("2d")!;
  x.translate(S / 2 - cx, S / 2 - cy);
  x.fillStyle = g;
  x.beginPath(); x.arc(cx, cy, r, 0, TWO_PI); x.fill();
  x.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 7; i++) {
    const y = cy + r * 0.05 + i * i * r * 0.018 + i * r * 0.06;
    x.fillRect(cx - r, y, r * 2, 2 + i * 1.3);
  }
  ctx.drawImage(c, cx - S / 2, cy - S / 2);
}

export function paintSynthGrid(ctx: Ctx, W: number, H: number, horizon: number) {
  const g = ctx.createLinearGradient(0, horizon, 0, H);
  g.addColorStop(0, "rgba(255,46,214,0)");
  g.addColorStop(1, "rgba(255,46,214,.10)");
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.strokeStyle = "rgba(255,46,214,.22)";
  ctx.lineWidth = 1;
  const vx = W / 2;
  for (let i = -14; i <= 14; i++) {
    ctx.beginPath(); ctx.moveTo(vx + i * 14, horizon); ctx.lineTo(vx + i * 120, H); ctx.stroke();
  }
  for (let k = 0; k < 9; k++) {
    const u = k / 8;
    const y = horizon + (H - horizon) * u * u;
    ctx.globalAlpha = 0.25 + u * 0.6;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(53,240,224,.55)";
  ctx.fillRect(0, horizon - 1, W, 1.5);
}

export function paintNeonSkyline(ctx: Ctx, W: number, rng: () => number, baseY: number, color: string, n: number, lit: number, hMax = 230) {
  for (let i = 0; i < n; i++) {
    const w = 34 + rng() * 56;
    const x = (W / n) * i + (rng() - 0.5) * 40;
    const h = 40 + rng() * (hMax - 40);
    ctx.fillStyle = color;
    ctx.fillRect(x, baseY - h, w, h);
    if (rng() < 0.4) ctx.fillRect(x + w * 0.4, baseY - h - 18, 2, 18); // antena
    for (let wy = baseY - h + 8; wy < baseY - 6; wy += 11) {
      for (let wx = x + 5; wx < x + w - 5; wx += 9) {
        if (rng() > lit) continue;
        ctx.fillStyle = rng() < 0.5 ? "rgba(255,46,214,.55)" : "rgba(53,240,224,.5)";
        ctx.fillRect(wx, wy, 4, 3);
      }
    }
    if (rng() < 0.3) { // cartel de neón vertical
      ctx.fillStyle = rng() < 0.5 ? "rgba(255,46,214,.8)" : "rgba(53,240,224,.8)";
      ctx.fillRect(x + w - 6, baseY - h + 10, 3, Math.min(60, h * 0.4));
    }
  }
}

export function paintVolcano(ctx: Ctx, W: number, rng: () => number) {
  const cx = W * (0.55 + rng() * 0.25), base = 360, top = 150, halfTop = 38, halfBase = 330;
  for (let i = 0; i < 6; i++) { // humo
    ctx.fillStyle = "rgba(60,40,40," + (0.08 + rng() * 0.08) + ")";
    ctx.beginPath(); ctx.arc(cx + (rng() - 0.5) * 80 + i * 14, top - 30 - i * 26, 30 + i * 10, 0, TWO_PI); ctx.fill();
  }
  ctx.fillStyle = "rgba(38,10,8,.95)";
  ctx.beginPath();
  ctx.moveTo(cx - halfBase, base + 80);
  ctx.lineTo(cx - halfTop, top);
  ctx.lineTo(cx + halfTop, top);
  ctx.lineTo(cx + halfBase, base + 80);
  ctx.closePath(); ctx.fill();
  const glow = ctx.createRadialGradient(cx, top, 4, cx, top, 140);
  glow.addColorStop(0, "rgba(255,190,90,.9)");
  glow.addColorStop(0.25, "rgba(255,90,40,.45)");
  glow.addColorStop(1, "rgba(255,60,20,0)");
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx, top, 140, 0, TWO_PI); ctx.fill();
  ctx.strokeStyle = "rgba(255,110,50,.55)";
  ctx.lineWidth = 2;
  for (let k = 0; k < 3; k++) { // ríos de lava por la ladera
    ctx.beginPath();
    let x = cx + (rng() - 0.5) * halfTop, y = top + 4;
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) { x += (rng() - 0.5) * 30 + (k - 1) * 12; y += 30; ctx.lineTo(x, y); }
    ctx.stroke();
  }
}

export function paintLavaGlow(ctx: Ctx, W: number, H: number) {
  const g = ctx.createLinearGradient(0, H * 0.7, 0, H);
  g.addColorStop(0, "rgba(255,80,30,0)");
  g.addColorStop(1, "rgba(255,80,30,.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.7, W, H * 0.3);
}

export function paintPines(ctx: Ctx, W: number, rng: () => number, baseY: number, color: string, n: number, hMin: number, hMax: number) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const x = rng() * W, h = hMin + rng() * (hMax - hMin), w = h * (0.32 + rng() * 0.1);
    ctx.beginPath();
    ctx.moveTo(x, baseY - h);
    for (let t = 1; t <= 4; t++) {
      const y = baseY - h + (h * t) / 4;
      ctx.lineTo(x + (w / 2) * (t / 4) + 4, y - 4);
      ctx.lineTo(x + (w / 2) * (t / 4) * 0.7, y - 2);
    }
    ctx.lineTo(x + 2, baseY); ctx.lineTo(x - 2, baseY);
    for (let t = 4; t >= 1; t--) {
      const y = baseY - h + (h * t) / 4;
      ctx.lineTo(x - (w / 2) * (t / 4) * 0.7, y - 2);
      ctx.lineTo(x - (w / 2) * (t / 4) - 4, y - 4);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.fillRect(0, baseY, W, 400);
}

export function paintFog(ctx: Ctx, W: number, y: number, h: number, color: string, a: number) {
  const g = ctx.createLinearGradient(0, y - h, 0, y + h);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(0.5, rgba(color, a));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, y - h, W, h * 2);
}

export function paintSnowMountains(ctx: Ctx, W: number, H: number, rng: () => number, baseY: number, amp: number, body: string, cap: string, n: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push([(W / n) * i + (rng() - 0.5) * 30, baseY - (i % 2 ? amp * (0.7 + rng() * 0.3) : amp * 0.25 * rng())]);
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.moveTo(0, H);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.fillStyle = cap;
  for (let i = 1; i < pts.length - 1; i += 2) {
    const [x, y] = pts[i], [lx, ly] = pts[i - 1], [rx, ry] = pts[i + 1];
    const k = 0.28;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rx - x) * k, y + (ry - y) * k);
    ctx.lineTo(x + (rx - x) * k * 0.5, y + (ry - y) * k * 0.8);
    ctx.lineTo(x, y + (ry - y) * k * 0.6);
    ctx.lineTo(x + (lx - x) * k * 0.5, y + (ly - y) * k * 0.8);
    ctx.lineTo(x + (lx - x) * k, y + (ly - y) * k);
    ctx.closePath(); ctx.fill();
  }
}

export function paintAurora(ctx: Ctx, W: number, rng: () => number) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let b = 0; b < 3; b++) {
    const y0 = 70 + b * 38 + rng() * 20;
    const col = b === 1 ? "120,140,255" : "80,255,190";
    const ph = rng() * 6;
    for (let x = 0; x < W; x += 4) {
      const y = y0 + Math.sin(x * 0.006 + b * 2 + ph) * 26 + Math.sin(x * 0.017 + b) * 8;
      const h = 50 + Math.sin(x * 0.01 + b * 3) * 20;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "rgba(" + col + ",0)");
      g.addColorStop(0.3, "rgba(" + col + ",.07)");
      g.addColorStop(1, "rgba(" + col + ",0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 4, h);
    }
  }
  ctx.restore();
}

export function paintArches(ctx: Ctx, W: number, rng: () => number, baseY: number, color: string, n: number) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const x = (W / n) * i + rng() * 40, w = 70 + rng() * 40, h = 90 + rng() * 70, t = 12;
    ctx.fillRect(x, baseY - h, t, h);
    ctx.fillRect(x + w - t, baseY - h, t, h);
    ctx.beginPath();
    ctx.moveTo(x, baseY - h);
    ctx.quadraticCurveTo(x + w / 2, baseY - h - w * 0.7, x + w, baseY - h);
    ctx.lineTo(x + w - t, baseY - h);
    ctx.quadraticCurveTo(x + w / 2, baseY - h - w * 0.45, x + t, baseY - h);
    ctx.closePath(); ctx.fill();
    if (rng() < 0.5) ctx.fillRect(x - 6, baseY - h - 4, 14 + rng() * 6, 6); // piedra caída
  }
}
