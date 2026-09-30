/* Entrada: dos esquemas de teclado, mouse y mandos (Gamepad API). Todo se normaliza a eventos
   (slot, acción, apretado) y la sesión activa decide a qué jugador corresponde cada slot. En los
   modos de un solo jugador todos los slots manejan al mismo muñeco. */

import type { InputKey } from "@lss/shared";

export type Slot = "kb1" | "kb2" | "mouse" | `gp${number}`;

export interface InputSink {
  onInput(slot: Slot, key: InputKey, down: boolean): void;
}

const KEYS1: Record<string, InputKey> = { a: "left", d: "right", " ": "jump", w: "jump", j: "punch", k: "kick" };
const KEYS2: Record<string, InputKey> = { arrowleft: "left", arrowright: "right", arrowup: "jump", control: "jump", ".": "punch", "/": "kick" };
const ACTIONS: InputKey[] = ["left", "right", "jump", "punch", "kick"];

const GP_DEADZONE = 0.35;
const GP_TRIGGER_MIN = 0.3;

type PadState = Record<InputKey, boolean>;
const NEUTRAL: PadState = { left: false, right: false, jump: false, punch: false, kick: false };

function btn(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i];
  return !!b && (b.pressed || (typeof b.value === "number" && b.value > GP_TRIGGER_MIN));
}

/* Mapeo "standard": stick izquierdo o cruceta mueven; A/X (0) o cruceta arriba saltan; gatillos
   L2/R2 pegan (como en V1) y además X/Cuadrado (2) piña y B/Círculo (1) patada. */
function readPad(gp: Gamepad): PadState {
  const axis = gp.axes[0] || 0;
  return {
    left: axis < -GP_DEADZONE || btn(gp, 14),
    right: axis > GP_DEADZONE || btn(gp, 15),
    jump: btn(gp, 0) || btn(gp, 12),
    punch: btn(gp, 6) || btn(gp, 2),
    kick: btn(gp, 7) || btn(gp, 1),
  };
}

export class InputManager {
  sink: InputSink | null = null;
  /** Solo se capturan teclas/clicks de juego mientras hay una partida en pantalla. */
  active = false;
  private padPrev: Record<number, PadState> = {};
  private held = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.releaseAll());
    window.addEventListener("contextmenu", (e) => { if (this.active) e.preventDefault(); });
    window.addEventListener("mousedown", (e) => {
      if (!this.active || isTyping() || (e.target as HTMLElement)?.closest?.("button, input, a, .ui-block")) return;
      if (e.button !== 0 && e.button !== 2) return;
      this.emit("mouse", e.button === 0 ? "punch" : "kick", true);
    });
  }

  private emit(slot: Slot, key: InputKey, down: boolean) {
    this.sink?.onInput(slot, key, down);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!this.active || isTyping()) return;
    const key = e.key.toLowerCase();
    const a1 = KEYS1[key], a2 = KEYS2[key];
    if (!a1 && !a2) return;
    e.preventDefault();
    const id = key + (a1 ? "1" : "2");
    if (down) {
      // la repetición del teclado solo importa para izquierda/derecha (que igual son estado)
      if (e.repeat || this.held.has(id)) return;
      this.held.add(id);
    } else this.held.delete(id);
    if (a1) this.emit("kb1", a1, down);
    if (a2) this.emit("kb2", a2, down);
  }

  /** Suelta todo (la ventana perdió foco, terminó la partida). */
  releaseAll() {
    for (const id of this.held) {
      const key = id.slice(0, -1), scheme = id.slice(-1);
      const a = scheme === "1" ? KEYS1[key] : KEYS2[key];
      if (a) this.emit(scheme === "1" ? "kb1" : "kb2", a, false);
    }
    this.held.clear();
    for (const key of Object.keys(this.padPrev)) {
      const idx = Number(key);
      for (const a of ACTIONS) if (this.padPrev[idx][a]) this.emit(`gp${idx}`, a, false);
      this.padPrev[idx] = { ...NEUTRAL };
    }
  }

  /** Llamado una vez por cuadro: la Gamepad API no tiene eventos por botón. */
  pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i];
      const prev = this.padPrev[i] || NEUTRAL;
      const cur = gp && this.active && !isTyping() ? readPad(gp) : NEUTRAL;
      for (const a of ACTIONS) if (cur[a] !== prev[a]) this.emit(`gp${i}`, a, cur[a]);
      this.padPrev[i] = cur;
    }
  }

  connectedPads(): number[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out: number[] = [];
    for (let i = 0; i < pads.length; i++) if (pads[i]) out.push(i);
    return out;
  }

  /** Vibración del mando (Chrome/Edge). */
  rumble(padIndex: number, strength: number, ms: number) {
    const gp = navigator.getGamepads ? navigator.getGamepads()[padIndex] : null;
    const act = (gp as unknown as { vibrationActuator?: { playEffect(t: string, p: object): Promise<unknown> } })?.vibrationActuator;
    if (!act) return;
    act.playEffect("dual-rumble", { duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.7) }).catch(() => {});
  }
}

export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
}

export const input = new InputManager();
