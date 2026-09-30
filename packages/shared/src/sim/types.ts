import type { AttackKind } from "../balance";
import type { BiomeId, PowerType } from "../constants";

export type Power = { t: number } & Partial<Record<PowerType, boolean>>;

export interface Attack {
  type: AttackKind;
  t: number;
  dur: number;
  hitSet: Record<number, true>;
}

export interface Player {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kbx: number;
  grounded: boolean;
  facing: 1 | -1;
  hp: number;
  alive: boolean;
  attack: Attack | null;
  attackCooldown: number;
  input: { left: boolean; right: boolean };
  jumpEdge: boolean;
  punchEdge: boolean;
  kickEdge: boolean;
  walkCycle: number;
  idleT: number;
  squash: number;
  hitStunT: number;
  hitDir: number;
  jumpAnticT: number;
  deathFadeT: number;
  power: Power | null;
  burnT: number;
  burnTickT: number;
  burnFlashT: number;
  slowT: number;
  jumpsLeft: number;
  jumpBufT: number;
  hillMs: number;
  orbMs: number;
  /** Modo Historia: los NPCs de un nivel son equipo entre sí. */
  isBot: boolean;
  isHero: boolean;
}

export type Phase = "lobby" | "fightIntro" | "fight" | "roundEnd" | "final";
export type GameMode = "normal" | "koth" | "orbking";
export type RoundsMode = "fixed" | "infinite" | "wins";

export interface Orb {
  type: PowerType;
  x: number;
  y: number;
  bornT: number;
}

export interface Hill {
  x: number;
  y: number;
  r: number;
}

export interface WorldObject {
  x: number;
  y: number;
  bornT: number;
  color?: string;
  boss?: boolean;
}

export interface MatchStats {
  kicks: number;
  punches: number;
  falls: number;
  hitsLanded: number;
  hitsTaken: number;
}

/* Eventos que emite la simulación. Son la única forma en que el mundo exterior (efectos, audio,
   UI, red) se entera de lo que pasó: la sim no sabe que existen cámaras ni parlantes. En V1 esas
   llamadas eran globales y en el build online se perdían dentro del servidor. */
export type SimEvent =
  | { k: "jump"; id: number; x: number; y: number; dbl: boolean }
  | { k: "swing"; id: number; a: AttackKind }
  | { k: "hit"; id: number; t: number; a: AttackKind; x: number; y: number; dir: number; dmg: number; ko: boolean }
  | { k: "land"; id: number; x: number; y: number; s: number }
  | { k: "ko"; id: number; x: number; y: number }
  | { k: "burn"; id: number; x: number; y: number }
  | { k: "respawn"; id: number }
  | { k: "clutch" }
  | { k: "pickup"; id: number; p: PowerType; x: number; y: number }
  | { k: "round"; round: number; total: number | null; map: string; biome: BiomeId; inf: boolean }
  | { k: "fight" }
  | { k: "final"; ranked: number[]; winner: number | null }
  | { k: "lobby" };

export type PhaseInfo =
  | { t: "roundStart"; round: number; totalRounds: number; mapName: string; infinite: boolean }
  | { t: "fight" }
  | { t: "final"; ranked: number[]; winner: number | undefined };

export interface StartOptions {
  mode?: "rounds" | "wins" | "infinite" | "koth" | "orbking";
  biome?: BiomeId | null;
  mapArchetype?: string | null;
  noOrbs?: boolean;
}
