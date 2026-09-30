/* Galería de arte (solo desarrollo, `?lab`): muñecos en cada estado de animación y todos los
   objetos del mundo, lado a lado, con el renderer real. Sirve para evaluar y comparar el arte sin
   tener que provocar cada situación jugando. Los estados son guionados, no simulados. */

import { BIOME_IDS, POWER_TYPES, type BiomeId, type InputKey, type MapDef } from "@lss/shared";
import type { Session } from "../session";
import type { Engine } from "../engine";
import type { Slot } from "../input";
import type { RenderView } from "../../render/renderer";
import type { RenderPlayer } from "../../render/art/stickman";

const COLORS = ["#35f0e0", "#ff2e88", "#9dff4f", "#ffc247", "#7b6cff", "#4fd2ff", "#ff7a3d", "#eef2ff"];
const HATS = ["none", "crown", "tophat", "cowboy", "halo", "horns", "propeller", "orbit"];
const ROW_Y = [250, 440, 610];

const id17 = (id: number) => id * 1.7;

function base(id: number, x: number, y: number): RenderPlayer {
  return {
    id, x, y, vx: 0, vy: 0, facing: 1, grounded: true, alive: true, attack: null, walkCycle: 0, idleT: id * 1.7,
    squash: 0, jumpAnticT: 0, hitStunT: 0, hitDir: 1, power: null, burnT: 0, slowT: 0, burnFlashT: 0, hp: 100, deathFadeT: 0,
  };
}

export class LabSession implements Session {
  readonly kind = "lab";
  readonly interactive = false;
  private t = 0;
  /** Cámara lenta (S) y pausa (P) para mirar los golpes cuadro a cuadro. */
  speed = 1;
  /** Reloj real (no se pausa): los resortes y blends del rig terminan aunque la escena esté quieta. */
  private real = 0;
  private biomeIdx = 0;
  private map: MapDef;
  labels: { x: number; y: number; text: string }[] = [];

  constructor(private engine: Engine) {
    this.map = this.buildMap(BIOME_IDS[0]);
    engine.renderer.applySettings({ dynamicCamera: false });
    window.addEventListener("keydown", this.onKey);
  }

  private focus: { row: number; col: number } | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "b") { this.biomeIdx = (this.biomeIdx + 1) % BIOME_IDS.length; this.map = this.buildMap(BIOME_IDS[this.biomeIdx]); }
    if (e.key === "1" || e.key === "2" || e.key === "3") this.focus = { row: Number(e.key) - 1, col: this.focus ? this.focus.col : 0 };
    if (e.key === "ArrowRight" && this.focus) this.focus.col = Math.min(7, this.focus.col + 1);
    if (e.key === "ArrowLeft" && this.focus) this.focus.col = Math.max(0, this.focus.col - 1);
    if (e.key === "0") this.focus = null;
    if (e.key === "s") this.speed = this.speed === 1 ? 0.12 : 1;
    if (e.key === "p") this.speed = this.speed === 0 ? 1 : 0;
    const rs = this.engine.renderer.settings;
    if (e.key === "n") this.engine.renderer.applySettings({ stickStyle: rs.stickStyle === "v2" ? "v1" : "v2" });
    if (e.key === "h") this.engine.renderer.applySettings({ headStyle: rs.headStyle === "face" ? "ring" : "face" });
    this.engine.renderer.camera.override = this.focus ? { cx: 90 + this.focus.col * 140, cy: ROW_Y[this.focus.row] - 40, zoom: 3 } : null;
  };
  /** Para inspección desde la consola/automatización. */
  setFocus(row: number | null, col = 0) {
    this.focus = row === null ? null : { row, col };
    this.engine.renderer.camera.override = this.focus ? { cx: 90 + col * 140, cy: ROW_Y[row!] - 40, zoom: 3 } : null;
  }

  private buildMap(biome: BiomeId): MapDef {
    return {
      name: "Lab", biome, archetype: "lab", seed: 3,
      platforms: ROW_Y.map((y) => ({ x: 20, y, w: 1112, h: 22 })),
      hazards: [{ type: "spikes", x: 1060, y: ROW_Y[2], w: 55, h: 10 }],
    };
  }

  onInput(_s: Slot, _k: InputKey, _d: boolean) {}

  update(dt: number) {
    this.t += dt * this.speed;
    this.real += dt;
  }

  private cycle(period: number, offset = 0) {
    return ((this.t + offset) % period) / period;
  }

  view(): RenderView {
    const t = this.t;
    const tick = (p: RenderPlayer) => { p.idleT = id17(p.id) + this.real / 1000; return p; };
    const players: RenderPlayer[] = [];
    const L: typeof this.labels = [];
    const col = (i: number) => 90 + i * 140;
    const r0 = ROW_Y[0], r1 = ROW_Y[1], r2 = ROW_Y[2];

    // fila 1: movimiento
    const idle = base(0, col(0), r0); players.push(idle); L.push({ x: col(0), y: r0, text: "quieto" });
    const run = base(1, col(1), r0); run.vx = 4.3; run.walkCycle = this.cycle(294); players.push(run); L.push({ x: col(1), y: r0, text: "correr" });
    const punch = base(2, col(2), r0); const pp = t % 520; punch.attack = pp < 140 ? { type: "punch", t: 140 - pp, dur: 140 } : null; players.push(punch); L.push({ x: col(2), y: r0, text: "piña" });
    const kick = base(3, col(3), r0); const kp = t % 700; kick.attack = kp < 280 ? { type: "kick", t: 280 - kp, dur: 280 } : null; players.push(kick); L.push({ x: col(3), y: r0, text: "patada" });
    // salto: parábola real (vy de -20.5 con gravedad asimétrica, aproximada)
    const jp = (t % 1500) / 1500;
    const jump = base(4, col(4), r0);
    if (jp < 0.8) {
      const u = jp / 0.8;
      jump.grounded = false;
      jump.vy = -20.5 + u * 34;
      jump.y = r0 - Math.sin(u * Math.PI) * 150;
      jump.jumpAnticT = u < 0.06 ? 90 : 0;
    } else jump.squash = Math.max(0, 1 - (jp - 0.8) * 8);
    players.push(jump); L.push({ x: col(4), y: r0, text: "salto" });
    const dbl = base(5, col(5), r0);
    const dp = (t % 1800) / 1800;
    if (dp < 0.85) {
      const u = dp / 0.85;
      dbl.grounded = false;
      dbl.vy = u < 0.45 ? -20.5 + (u / 0.45) * 20 : -14.5 + ((u - 0.45) / 0.55) * 28;
      dbl.y = r0 - (u < 0.45 ? Math.sin((u / 0.45) * Math.PI * 0.5) * 120 : 120 + Math.sin(((u - 0.45) / 0.55) * Math.PI) * 60 - ((u - 0.45) / 0.55) * 120);
      (dbl as RenderPlayer & { jumpsLeft?: number }).jumpsLeft = u < 0.45 ? 1 : 0;
    }
    players.push(dbl); L.push({ x: col(5), y: r0, text: "doble salto" });
    const land = base(6, col(6), r0); land.squash = Math.max(0, 1 - this.cycle(900) * 3); players.push(land); L.push({ x: col(6), y: r0, text: "aterrizaje" });
    const turn = base(7, col(7), r0); turn.facing = Math.floor(t / 800) % 2 ? 1 : -1; players.push(turn); L.push({ x: col(7), y: r0, text: "girar" });

    // fila 2: recibir daño y poderes
    const hit = base(8, col(0), r1); const hp = t % 900; hit.hitStunT = hp < 220 ? 220 - hp : 0; hit.hitDir = -1; players.push(hit); L.push({ x: col(0), y: r1, text: "golpeado" });
    const launched = base(9, col(1), r1); const lp = (t % 1400) / 1400;
    if (lp < 0.7) { launched.grounded = false; launched.hitStunT = 220 * (1 - lp / 0.7); launched.vy = -8 + lp * 20; launched.vx = 0; launched.y = r1 - Math.sin((lp / 0.7) * Math.PI) * 70; launched.hitDir = 1; (launched as RenderPlayer & { kbx?: number }).kbx = 12 * (1 - lp / 0.7); }
    players.push(launched); L.push({ x: col(1), y: r1, text: "lanzado" });
    POWER_TYPES.forEach((pw, i) => {
      const p = base(10 + i, col(2 + i), r1);
      p.power = { t: 5000, [pw]: true };
      if (i % 2) { p.vx = 4.3; p.walkCycle = this.cycle(294, i * 70); }
      players.push(p); L.push({ x: col(2 + i), y: r1, text: pw });
    });
    const burn = base(14, col(6), r1); burn.burnT = 2000; burn.burnFlashT = (t % 500) < 220 ? 220 - (t % 500) : 0; players.push(burn); L.push({ x: col(6), y: r1, text: "quemado" });
    const slow = base(15, col(7), r1); slow.slowT = 2000; players.push(slow); L.push({ x: col(7), y: r1, text: "congelado" });

    // fila 3: accesorios (todos quietos) + muerte
    for (let i = 0; i < 7; i++) {
      const p = base(16 + i, col(i), r2);
      if (i === 6) { p.alive = false; p.deathFadeT = 420 - (t % 1200) * 0.35; if (p.deathFadeT < 0) p.deathFadeT = 0; }
      players.push(p);
      L.push({ x: col(i), y: r2, text: i === 6 ? "muerte" : HATS[i + 1] || "" });
    }
    players.forEach(tick);
    this.labels = L;
    const orbType = POWER_TYPES[Math.floor(t / 1500) % 4];
    return {
      map: this.map,
      players,
      orb: { type: orbType, x: col(7) + 10, y: r2 - 40, bornT: t },
      hill: { x: col(4), y: r1 - 150, r: 60 },
      portal: { x: col(1), y: r0 - 150, bornT: t, color: "#35f0e0" },
      voidHole: { x: col(3), y: r0 - 150, bornT: t },
      phase: "fight",
      gameMode: "koth",
      scores: {},
      meId: 0,
      timeMs: performance.now(),
      nameFor: (id) => "P" + id,
      colorFor: (id) => COLORS[id % COLORS.length],
      hatFor: (id) => (id >= 16 ? HATS[(id - 16 + 1) % HATS.length] : "none"),
      maxHpFor: () => 100,
    };
  }

  dispose() {
    this.engine.renderer.camera.override = null;
    window.removeEventListener("keydown", this.onKey);
  }
}
