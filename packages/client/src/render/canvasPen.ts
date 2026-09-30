/* Adaptador Canvas 2D del "Pen" de stickPaint.ts: permite dibujar el muñeco V2 en un canvas común
   (el muñeco del menú, la personalización y la pantalla de victoria) con el mismo código que el
   juego usa sobre Graphics de Pixi.

   Semántica igual a la de Pixi: las formas cerradas (poly, circle, ellipse) se acumulan hasta el
   próximo fill/stroke y cada una se rellena por separado (así dos formas que se pisan no se
   cancelan por la regla de relleno de Canvas); los trazos abiertos (moveTo/lineTo/arc/bezier) se
   rellenan o trazan como un solo camino. */

import type { Pen } from "./stickPaint";

type Op = (ctx: CanvasRenderingContext2D) => void;

function css(color: number, alpha = 1): string {
  return "rgba(" + ((color >> 16) & 255) + "," + ((color >> 8) & 255) + "," + (color & 255) + "," + alpha + ")";
}

export class CanvasPen implements Pen {
  private shapes: Op[] = [];
  private path: Op[] = [];

  constructor(public ctx: CanvasRenderingContext2D) {}

  poly(points: number[]) {
    this.shapes.push((c) => {
      c.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
      c.closePath();
    });
    return this;
  }

  circle(x: number, y: number, r: number) {
    this.shapes.push((c) => { c.moveTo(x + r, y); c.arc(x, y, r, 0, Math.PI * 2); });
    return this;
  }

  ellipse(x: number, y: number, rx: number, ry: number) {
    this.shapes.push((c) => { c.moveTo(x + rx, y); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); });
    return this;
  }

  moveTo(x: number, y: number) { this.path.push((c) => c.moveTo(x, y)); return this; }
  lineTo(x: number, y: number) { this.path.push((c) => c.lineTo(x, y)); return this; }
  arc(x: number, y: number, r: number, a0: number, a1: number) { this.path.push((c) => c.arc(x, y, r, a0, a1)); return this; }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    this.path.push((c) => c.bezierCurveTo(c1x, c1y, c2x, c2y, x, y));
    return this;
  }
  closePath() { this.path.push((c) => c.closePath()); return this; }

  fill(style: { color: number; alpha?: number }) {
    const c = this.ctx;
    c.fillStyle = css(style.color, style.alpha ?? 1);
    for (const s of this.shapes) { c.beginPath(); s(c); c.fill(); }
    if (this.path.length) { c.beginPath(); for (const s of this.path) s(c); c.fill(); }
    this.shapes = []; this.path = [];
    return this;
  }

  stroke(style: { width: number; color: number; alpha?: number; cap?: CanvasLineCap; join?: CanvasLineJoin }) {
    const c = this.ctx;
    c.strokeStyle = css(style.color, style.alpha ?? 1);
    c.lineWidth = style.width;
    c.lineCap = style.cap || "butt";
    c.lineJoin = style.join || "miter";
    c.beginPath();
    for (const s of this.shapes) s(c);
    for (const s of this.path) s(c);
    c.stroke();
    this.shapes = []; this.path = [];
    return this;
  }
}
