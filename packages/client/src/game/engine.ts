/* Motor del cliente: el loop (requestAnimationFrame), el renderer, la entrada y la sesión activa.
   Sin sesión interactiva corre de fondo una pelea entre bots detrás del menú ("attract mode"). */

import type { InputKey } from "@lss/shared";
import { get } from "svelte/store";
import { Renderer } from "../render/renderer";
import { input, type InputSink, type Slot } from "./input";
import type { Session } from "./session";
import { AttractSession } from "./sessions/attract";
import { fps, playing } from "../app/ui";
import { settings } from "../app/persist";

export class Engine implements InputSink {
  readonly renderer = new Renderer();
  session: Session | null = null;
  private attract: AttractSession | null = null;
  private last = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;

  async init(parent: HTMLElement) {
    await this.renderer.init(parent);
    settings.subscribe((s) => this.renderer.applySettings({ quality: s.quality, reduceMotion: s.reduceMotion, dynamicCamera: s.dynamicCamera }));
    input.sink = this;
    this.attract = new AttractSession(this);
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    document.addEventListener("visibilitychange", () => { this.last = performance.now(); });
  }

  /** Arranca una sesión (la anterior se descarta). */
  start(session: Session) {
    if (this.session && this.session !== session) this.session.dispose();
    input.releaseAll();
    this.session = session;
    this.renderer.camera.reset();
    this.renderer.clearTransient();
    const interactive = session.interactive;
    input.active = interactive;
    playing.set(interactive);
  }

  /** Vuelve al menú. */
  stop() {
    if (this.session) this.session.dispose();
    input.releaseAll();
    this.session = null;
    input.active = false;
    playing.set(false);
    this.renderer.camera.reset();
    this.renderer.clearTransient();
    this.renderer.resetPlayers();
    this.attract?.restart();
  }

  /** Captura de input de juego sin cambiar de sesión (p.ej. la sala online pasa de lobby a partida). */
  setInteractive(on: boolean) {
    input.active = on;
    if (!on) input.releaseAll();
    playing.set(on);
  }

  onInput(slot: Slot, key: InputKey, down: boolean) {
    this.session?.onInput(slot, key, down);
  }

  private frame(now: number) {
    const dt = Math.min(100, Math.max(0, now - this.last));
    this.last = now;
    input.pollGamepads();
    let view = null;
    if (this.session) {
      this.session.update(dt);
      view = this.session.view();
    }
    // sin nada que mostrar (menú, lobby de una sala online): la pelea de fondo
    if (!view && this.attract) {
      this.attract.suspended = false;
      this.attract.update(dt);
      view = this.attract.view();
    } else if (this.attract) this.attract.suspended = true;
    this.renderer.render(view, dt);
    if (get(settings).showFps) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc >= 500) { fps.set(Math.round((this.fpsFrames * 1000) / this.fpsAcc)); this.fpsAcc = 0; this.fpsFrames = 0; }
    }
    requestAnimationFrame((t) => this.frame(t));
  }
}

export const engine = new Engine();
