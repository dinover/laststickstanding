/* Cartelito de cada jugador (nombre, vida, poderes, marcador de modo). Los objetos del mundo
   (orbe, colina, portal, vacío) pasaron a Pixi en render/objectsPixi.ts. */

import { MODES_TUNING, POWER_GLYPHS, POWER_TYPES } from "@lss/shared";
import type { RenderPlayer } from "./stickman";

type Ctx = CanvasRenderingContext2D;
const EMOJI_FONT = "'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif";

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
