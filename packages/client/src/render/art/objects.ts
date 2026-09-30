/* Objetos del mundo (orbe de poder, círculo de Rey de la Colina, portal y agujero de vacío de
   Modo Historia) y el cartelito de cada jugador (nombre, vida, poderes, marcador de modo). */

import { MODES_TUNING, POWER_COLORS, POWER_GLYPHS, POWER_TYPES, type PowerType } from "@lss/shared";
import type { RenderPlayer } from "./stickman";

type Ctx = CanvasRenderingContext2D;
const WORLD_OBJECT_R = 34;
const EMOJI_FONT = "'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif";

export function drawOrb(ctx: Ctx, orb: { type: string; x: number; y: number; bornT: number } | null) {
  if (!orb) return;
  const color = POWER_COLORS[orb.type as PowerType] || "#fff";
  const y = orb.y + Math.sin(orb.bornT * 0.004) * 4;
  const pulse = 1 + Math.sin(orb.bornT * 0.008) * 0.08;
  // halo suave + núcleo; el bloom del renderer hace el resto
  const g = ctx.createRadialGradient(orb.x, y, 2, orb.x, y, 22 * pulse);
  g.addColorStop(0, color);
  g.addColorStop(0.45, color + "66");
  g.addColorStop(1, color + "00");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(orb.x, y, 22 * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(orb.x, y, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.7)";
  ctx.beginPath(); ctx.arc(orb.x - 3, y - 3, 3, 0, Math.PI * 2); ctx.fill();
  const glyph = POWER_GLYPHS[orb.type as PowerType];
  if (glyph) {
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.font = "13px " + EMOJI_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, orb.x, y + 1);
    ctx.restore();
  }
}

export function drawHill(ctx: Ctx, hill: { x: number; y: number; r: number } | null, tMs: number) {
  if (!hill) return;
  ctx.save();
  const g = ctx.createRadialGradient(hill.x, hill.y, hill.r * 0.2, hill.x, hill.y, hill.r);
  g.addColorStop(0, "rgba(255,194,71,.02)");
  g.addColorStop(1, "rgba(255,194,71,.16)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(hill.x, hill.y, hill.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(255,194,71,.9)";
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 8]);
  ctx.lineDashOffset = -tMs * 0.02;
  ctx.beginPath(); ctx.arc(hill.x, hill.y, hill.r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawWobbleRing(ctx: Ctx, obj: { x: number; y: number; bornT: number }, fill: string, stroke: string) {
  const t = obj.bornT * 0.003;
  ctx.save();
  ctx.translate(obj.x, obj.y);
  ctx.beginPath();
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = WORLD_OBJECT_R + Math.sin(a * 3 + t * 2) * 6;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.7;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.globalAlpha = 0.3; ctx.fill();
  ctx.strokeStyle = stroke; ctx.globalAlpha = 0.9; ctx.lineWidth = 3; ctx.stroke();
  // remolino interior
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.5;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.ellipse(0, 0, (WORLD_OBJECT_R - 8 - k * 8), (WORLD_OBJECT_R - 8 - k * 8) * 0.7, t * (1 + k * 0.5), 0.2, Math.PI * 1.3);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawWorldObjects(ctx: Ctx, portal: { x: number; y: number; bornT: number; color?: string; boss?: boolean } | null, voidHole: { x: number; y: number; bornT: number } | null) {
  if (portal) {
    const color = portal.color || "#35f0e0";
    drawWobbleRing(ctx, portal, color, color);
    if (!portal.boss) {
      const bob = Math.sin(portal.bornT * 0.0035) * 6;
      const y = portal.y - WORLD_OBJECT_R - 22 + bob;
      ctx.save();
      ctx.translate(portal.x, y);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(-9, -8); ctx.lineTo(9, -8); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  if (voidHole) drawWobbleRing(ctx, voidHole, "#05030a", "#a054ff");
}

export interface TagOptions {
  name: string;
  color: string;
  hudY: number;
  showHp: boolean;
  maxHp: number;
  modeScore: string | null;
  modeColor: string;
  isMe: boolean;
}

/** Nombre, barra de vida, glyphs de poder y marcador de modo arriba de la cabeza. */
export function drawNameTag(ctx: Ctx, p: RenderPlayer, o: TagOptions) {
  const x = p.x;
  if (o.showHp) {
    const bw = 40, frac = Math.max(0, Math.min(1, p.hp / o.maxHp));
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(x - bw / 2 - 1, o.hudY - 25, bw + 2, 7);
    ctx.fillStyle = frac > 0.3 ? o.color : "#ff3d3d";
    ctx.fillRect(x - bw / 2, o.hudY - 24, bw * frac, 5);
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillRect(x - bw / 2, o.hudY - 24, bw * frac, 1);
  }
  ctx.font = (o.isMe ? "700 " : "500 ") + "10px 'Chakra Petch', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,.6)";
  ctx.fillText(o.name, x + 0.8, o.hudY - 29.2);
  ctx.fillStyle = o.isMe ? "#ffffff" : "rgba(255,255,255,.78)";
  ctx.fillText(o.name, x, o.hudY - 30);
  if (o.isMe) {
    ctx.fillStyle = o.color;
    ctx.beginPath(); ctx.moveTo(x - 4, o.hudY - 44); ctx.lineTo(x + 4, o.hudY - 44); ctx.lineTo(x, o.hudY - 39); ctx.closePath(); ctx.fill();
  }
  let glyph = "";
  if (p.power) for (const k of POWER_TYPES) if (p.power[k]) glyph += POWER_GLYPHS[k];
  let lineY = o.hudY - (o.isMe ? 50 : 42);
  if (o.modeScore) {
    ctx.fillStyle = o.modeColor;
    ctx.font = "bold 11px 'Chakra Petch', sans-serif";
    ctx.fillText(o.modeScore, x, lineY);
    lineY -= 13;
  }
  if (glyph) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = "12px " + EMOJI_FONT;
    ctx.fillText(glyph, x, lineY);
    ctx.restore();
  }
}

export const HILL_TARGET = MODES_TUNING.HILL_TARGET_SCORE;
