/* Balance de combate. En V1 había valores "de escritorio" en sim.js y un override web en
   balance.js; V2 es solo web, así que el balance web es directamente el default.

   Diseño (2026-08-18): la piña es el ataque de ritmo (doble de rápida, poco empuje) y la patada
   la herramienta de espacio (empuje fuerte en parábola baja para sacar gente del borde).
     piña   11 daño / 0.19 s = 57.9 daño/s
     patada  8 daño / 0.38 s = 21.1 daño/s */

export type AttackKind = "punch" | "kick";

export interface AttackDef {
  dur: number;
  cooldown: number;
  damage: number;
  reach: number;
  kbX: number;
  kbY: number;
  hitStun: number;
  hitStop: number;
  trauma: number;
  squash: number;
}

export const ATTACKS: Record<AttackKind, AttackDef> = {
  punch: { dur: 140, cooldown: 190, damage: 11, reach: 34, kbX: 0.8, kbY: 0, hitStun: 110, hitStop: 25, trauma: 0.22, squash: 0.3 },
  kick: { dur: 280, cooldown: 380, damage: 8, reach: 44, kbX: 15, kbY: -2.8, hitStun: 220, hitStop: 60, trauma: 0.55, squash: 0.6 },
};

/* Física del muñeco. El mundo creció 1.2x pero el muñeco no: mismo salto, misma velocidad. */
export const PHYS = {
  W: 1152,
  H: 648,
  GRAVITY_UP: 0.95,
  GRAVITY_DOWN: 0.7,
  SPEED: 4.3,
  JUMP_V: -20.5,
  /** Segundo salto a la mitad de altura del primero: JUMP_V / √2. */
  JUMP_V2: -20.5 / Math.SQRT2,
  MAX_JUMPS: 2,
  PW: 13,
  PH: 52,
  AIR_SPEED_MULT: 1.35,
  AIR_COOLDOWN_MULT: 0.55,
  SLOW_MULT: 0.5,
  KB_DECAY: 0.88,
  /** V2: salto pedido hasta estos ms antes de tocar el piso (sin saltos disponibles) se ejecuta al aterrizar. */
  JUMP_BUFFER_MS: 110,
} as const;

/* Modo Historia: NPCs pegan más suave y menos seguido; el héroe pega más y aguanta más. */
export const STORY_BALANCE = {
  NPC_DAMAGE_MULT: 0.8,
  HERO_DAMAGE_MULT: 1.25,
  HERO_MAX_HP: 125,
  NPC_ATTACK_COOLDOWN_MULT: 1.35,
} as const;

export const POWERS = {
  ORB_SPAWN_MS: 5000,
  ORB_POWER_MS: 8000,
  ORB_PICKUP_R: 28,
  BURN_MS: 3000,
  BURN_TICK_MS: 500,
  BURN_DMG: 2,
  SLOW_MS: 2500,
  ARMOR_MULT: 0.5,
} as const;

export const MODES_TUNING = {
  HILL_APPEAR_DELAY_MS: 5000,
  HILL_ACTIVE_MS: 15000,
  HILL_RADIUS: 114,
  HILL_TARGET_MS: 30000,
  HILL_TARGET_SCORE: 100,
  ORBKING_MATCH_MS: 120000,
} as const;
