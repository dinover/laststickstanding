import { PHYS } from "../balance";
import { clamp } from "../rng";
import type { Platform } from "../world/types";

/* Integrador del cuerpo, separado de la Sim para que lo compartan TRES consumidores con el
   mismo orden de operaciones: la simulación autoritativa, la predicción del jugador propio en el
   cliente (netcode) y la IA de bots. En V1 cada uno tenía su copia y ya se habían desincronizado. */

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kbx: number;
  grounded: boolean;
  facing: 1 | -1;
  jumpsLeft: number;
  jumpBufT: number;
  hitStunT: number;
  slowT: number;
  power: { t: number; aire?: boolean } | null;
  input: { left: boolean; right: boolean };
  jumpEdge: boolean;
}

export function speedOf(b: Pick<Body, "power" | "slowT">): number {
  let m = 1;
  if (b.power && b.power.aire) m *= PHYS.AIR_SPEED_MULT;
  if (b.slowT > 0) m *= PHYS.SLOW_MULT;
  return PHYS.SPEED * m;
}

/** Input horizontal y salto. Devuelve si saltó (y si fue el segundo). */
export function applyMoveInput(b: Body): { jumped: boolean; dbl: boolean } {
  const spd = speedOf(b);
  if (b.hitStunT > 0) {
    // En hitstun no se camina: el único movimiento horizontal es el empuje del golpe.
    b.vx = 0;
  } else if (b.input.left && !b.input.right) {
    b.vx = -spd;
    b.facing = -1;
  } else if (b.input.right && !b.input.left) {
    b.vx = spd;
    b.facing = 1;
  } else b.vx = 0;

  let jumped = false, dbl = false;
  if (b.jumpEdge) {
    if (b.jumpsLeft > 0) {
      // Los saltos son un contador: caerse de un borde no consume nada.
      dbl = b.jumpsLeft !== PHYS.MAX_JUMPS;
      b.vy = dbl ? PHYS.JUMP_V2 : PHYS.JUMP_V;
      b.jumpsLeft--;
      b.grounded = false;
      b.jumpBufT = 0;
      jumped = true;
    } else {
      b.jumpBufT = PHYS.JUMP_BUFFER_MS;
    }
  }
  b.jumpEdge = false;
  return { jumped, dbl };
}

/** Gravedad, posición, decaimiento del knockback y límites laterales. */
export function integrateBody(b: Body, dtScale: number): void {
  b.vy += (b.vy < 0 ? PHYS.GRAVITY_UP : PHYS.GRAVITY_DOWN) * dtScale;
  b.y += b.vy * dtScale;
  b.kbx = (b.kbx || 0) * Math.pow(PHYS.KB_DECAY, dtScale);
  if (Math.abs(b.kbx) < 0.05) b.kbx = 0;
  b.x += (b.vx + b.kbx) * dtScale;
  b.x = clamp(b.x, 14, PHYS.W - 14);
}

/** Temporizadores que afectan el movimiento (los que la predicción necesita replicar). */
export function tickMoveTimers(b: Body, dt: number): void {
  if (b.hitStunT > 0) b.hitStunT = Math.max(0, b.hitStunT - dt);
  if (b.slowT > 0) b.slowT = Math.max(0, b.slowT - dt);
  if (b.jumpBufT > 0) b.jumpBufT = Math.max(0, b.jumpBufT - dt);
  if (b.power) {
    b.power.t -= dt;
    if (b.power.t <= 0) b.power = null;
  }
}

/**
 * Aterrizaje sobre plataformas (one-way: solo desde arriba). Devuelve la velocidad de caída
 * con que aterrizó (>0) si recién tocó el piso, 0 si no hubo aterrizaje nuevo.
 */
export function collidePlatforms(b: Body, prevFeet: number, wasGrounded: boolean, platforms: Platform[]): number {
  b.grounded = false;
  let landedV = 0;
  const PW = PHYS.PW;
  for (let i = 0; i < platforms.length; i++) {
    const pl = platforms[i];
    if (b.vy >= 0 && prevFeet <= pl.y + 1 && b.y >= pl.y && b.x + PW > pl.x && b.x - PW < pl.x + pl.w) {
      b.y = pl.y;
      if (!wasGrounded) landedV = Math.max(landedV, b.vy);
      b.vy = 0;
      b.grounded = true;
      b.jumpsLeft = PHYS.MAX_JUMPS;
    }
  }
  // Salto pedido en el aire sin saltos disponibles: sale apenas toca el piso.
  if (b.grounded && b.jumpBufT > 0) {
    b.jumpEdge = true;
    b.jumpBufT = 0;
  }
  return landedV;
}

/* Empuje entre jugadores. Vive acá (y no adentro de la Sim) porque la predicción del cliente
   online lo tiene que repetir igual: si no, el muñeco propio atraviesa al otro en tu pantalla, el
   servidor lo empuja para atrás y cada snapshot trae una corrección (se ven encimados y temblando). */
const COLLIDE_HW = PHYS.PW + 4;
/* Solo se corrige una fracción del solapamiento por frame: caminar contra alguien lo empuja
   suave en vez de arrastrarlo como si fuera parte de tu cuerpo. */
const COLLIDE_PUSH = 0.18;
/** Distancia horizontal a la que dos cuerpos (a la misma altura) empiezan a empujarse. */
export const BODY_CONTACT_DX = COLLIDE_HW * 2;

export interface PushBody { id: number; x: number; y: number }

/** Separa los cuerpos que se solapan (dos pasadas). `bodies`: solo los vivos, en orden de roster. */
export function resolveBodyCollisions(bodies: PushBody[]): void {
  const W = PHYS.W;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        let dx = b.x - a.x;
        const dy = b.y - a.y;
        const xOverlap = BODY_CONTACT_DX - Math.abs(dx);
        const yOverlap = PHYS.PH - Math.abs(dy);
        if (xOverlap <= 0 || yOverlap <= 0) continue;
        if (dx === 0) dx = a.id < b.id ? -0.01 : 0.01;
        const dir = dx > 0 ? 1 : -1;
        const half = (xOverlap / 2) * COLLIDE_PUSH;
        a.x = clamp(a.x - dir * half, 14, W - 14);
        b.x = clamp(b.x + dir * half, 14, W - 14);
      }
    }
  }
}

/**
 * Un paso completo de movimiento, en el mismo orden que Sim.stepPlayer. Lo usa la predicción del
 * cliente; no resuelve ataques, daño, púas ni caídas al vacío (eso es autoridad del servidor).
 */
export function predictStep(b: Body, dt: number, platforms: Platform[]): void {
  const dtScale = dt / (1000 / 60);
  applyMoveInput(b);
  const prevFeet = b.y;
  const wasGrounded = b.grounded;
  integrateBody(b, dtScale);
  tickMoveTimers(b, dt);
  collidePlatforms(b, prevFeet, wasGrounded, platforms);
}
