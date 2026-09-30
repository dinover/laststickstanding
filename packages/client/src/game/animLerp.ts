/* Interpolación de la animación entre ticks de simulación (60 Hz). Antes solo se interpolaba la
   posición: el ciclo de carrera, el golpe, el reloj del rig, etc. avanzaban a saltos de tick, y con
   pantallas de más de 60 Hz (o cuando el cuadro de pantalla y el tick no coinciden: 0 ticks en un
   cuadro, 2 en el siguiente) la pose tartamudeaba aunque el muñeco se moviera suave. */

import { TICK_MS } from "@lss/shared";
import type { RenderPlayer } from "../render/art/stickman";

type Attack = RenderPlayer["attack"];

export interface AnimSnap {
  x: number; y: number; vx: number; vy: number; kbx: number;
  walkCycle: number; idleT: number; squash: number; jumpAnticT: number; hitStunT: number;
  deathFadeT: number; burnFlashT: number; attack: Attack;
}

export function snapAnim(p: { x: number; y: number; vx: number; vy: number; kbx?: number; walkCycle: number; idleT: number; squash: number; jumpAnticT: number; hitStunT: number; deathFadeT?: number; burnFlashT?: number; attack: Attack }): AnimSnap {
  return {
    x: p.x, y: p.y, vx: p.vx, vy: p.vy, kbx: p.kbx || 0, walkCycle: p.walkCycle, idleT: p.idleT, squash: p.squash,
    jumpAnticT: p.jumpAnticT, hitStunT: p.hitStunT, deathFadeT: p.deathFadeT || 0, burnFlashT: p.burnFlashT || 0,
    attack: p.attack ? { ...p.attack } : null,
  };
}

const L = (a: number, b: number, f: number) => a + (b - a) * f;

function wrap01(a: number, b: number, f: number): number {
  let d = b - a;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  return (((a + d * f) % 1) + 1) % 1;
}

/** Estado de animación a una fracción `f` (0..1) entre el estado anterior `a` y el actual `b`,
    separados `span` ms (un tick en las partidas locales; dos entre snapshots online). */
export function lerpAnim(a: AnimSnap, b: AnimSnap, f: number, span = TICK_MS): AnimSnap {
  let attack: Attack = b.attack;
  if (a.attack && b.attack && a.attack.type === b.attack.type && b.attack.t <= a.attack.t && a.attack.t - b.attack.t <= span + 1) {
    attack = { ...b.attack, t: L(a.attack.t, b.attack.t, f) };
  } else if (!a.attack && b.attack) {
    // empezó en este tick: se reconstruye el tramo que ya pasó en vez de saltarlo
    attack = { ...b.attack, t: Math.min(b.attack.dur, b.attack.t + span * (1 - f)) };
  } else if (a.attack && !b.attack) {
    // terminó en este tick: se muestra el final que faltaba
    const t = a.attack.t - span * f;
    attack = t > 0 ? { ...a.attack, t } : null;
  }
  return {
    x: L(a.x, b.x, f), y: L(a.y, b.y, f), vx: L(a.vx, b.vx, f), vy: L(a.vy, b.vy, f), kbx: L(a.kbx, b.kbx, f),
    walkCycle: b.vx !== 0 || a.vx !== 0 ? wrap01(a.walkCycle, b.walkCycle, f) : b.walkCycle,
    idleT: L(a.idleT, b.idleT, f), squash: L(a.squash, b.squash, f), jumpAnticT: L(a.jumpAnticT, b.jumpAnticT, f),
    hitStunT: L(a.hitStunT, b.hitStunT, f), deathFadeT: L(a.deathFadeT, b.deathFadeT, f), burnFlashT: L(a.burnFlashT, b.burnFlashT, f),
    attack,
  };
}
