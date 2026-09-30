/* Cámara: trauma → shake suavizado (random walk, no ruido crudo por cuadro), impulsos de zoom
   con resorte y respiración sutil. Port de V1 (fx.js) + encuadre dinámico opcional (V2): acerca
   un poco la cámara cuando los que quedan vivos están juntos, al estilo de los juegos de pelea de
   plataformas. Nunca recorta el mapa más de lo que el zoom máximo permite. */

export interface CameraFrame {
  /** Zoom total (1 = mapa completo). */
  zoom: number;
  /** Centro de la vista en coordenadas de mundo. */
  cx: number;
  cy: number;
  shakeX: number;
  shakeY: number;
}

export class Camera {
  trauma = 0;
  zoom = 1;
  shakeX = 0;
  shakeY = 0;
  dynamicFraming = true;
  maxFramingZoom = 1.16;

  private zoomVel = 0;
  private noiseX = 0;
  private noiseY = 0;
  private noiseTX = 0;
  private noiseTY = 0;
  private noiseTimer = 0;
  private breathT = 0;
  private frameZoom = 1;
  private frameCx: number;
  private frameCy: number;

  constructor(private W: number, private H: number) {
    this.frameCx = W / 2;
    this.frameCy = H / 2;
  }

  addTrauma(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  zoomImpulse(amount: number) {
    this.zoomVel += amount;
  }

  reset() {
    this.trauma = 0;
    this.zoom = 1;
    this.zoomVel = 0;
    this.frameZoom = 1;
    this.frameCx = this.W / 2;
    this.frameCy = this.H / 2;
  }

  /** targets: posiciones (pies) de los jugadores vivos; vacío = mapa completo. */
  update(dt: number, targets: { x: number; y: number }[], reduceMotion: boolean) {
    this.trauma = Math.max(0, this.trauma - dt * 0.0022);
    const t2 = this.trauma * this.trauma;
    this.noiseTimer -= dt;
    if (this.noiseTimer <= 0) {
      this.noiseTimer = 40;
      this.noiseTX = Math.random() * 2 - 1;
      this.noiseTY = Math.random() * 2 - 1;
    }
    const k = Math.min(1, dt * 0.02);
    this.noiseX += (this.noiseTX - this.noiseX) * k;
    this.noiseY += (this.noiseTY - this.noiseY) * k;
    const maxShake = reduceMotion ? 4 : 14;
    this.shakeX = this.noiseX * maxShake * t2;
    this.shakeY = this.noiseY * maxShake * t2;

    this.zoom += this.zoomVel;
    this.zoomVel *= 0.001;
    this.zoom += (1 - this.zoom) * Math.min(1, dt * 0.02);
    this.breathT += dt * 0.0006;

    // encuadre dinámico
    let tz = 1, tcx = this.W / 2, tcy = this.H / 2;
    if (this.dynamicFraming && !reduceMotion && targets.length >= 1) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of targets) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y - 70); maxY = Math.max(maxY, p.y + 10);
      }
      const padX = 230, padY = 170;
      const bw = Math.max(1, maxX - minX + padX * 2);
      const bh = Math.max(1, maxY - minY + padY * 2);
      tz = Math.max(1, Math.min(this.maxFramingZoom, Math.min(this.W / bw, this.H / bh)));
      tcx = (minX + maxX) / 2;
      tcy = (minY + maxY) / 2;
      // que el centro nunca deje ver afuera del mundo
      const halfW = this.W / (2 * tz), halfH = this.H / (2 * tz);
      tcx = Math.max(halfW, Math.min(this.W - halfW, tcx));
      tcy = Math.max(halfH, Math.min(this.H - halfH, tcy));
    }
    const f = 1 - Math.exp(-dt * 0.0035);
    this.frameZoom += (tz - this.frameZoom) * f;
    this.frameCx += (tcx - this.frameCx) * f;
    this.frameCy += (tcy - this.frameCy) * f;
  }

  frame(): CameraFrame {
    const breathe = Math.sin(this.breathT) * 0.6;
    return {
      zoom: this.zoom * this.frameZoom,
      cx: this.frameCx,
      cy: this.frameCy,
      shakeX: this.shakeX + breathe,
      shakeY: this.shakeY,
    };
  }
}
