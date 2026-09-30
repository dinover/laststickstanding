import type { BiomeId } from "../constants";

export interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Hazard {
  type: "spikes";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapDef {
  name: string;
  biome: BiomeId;
  archetype: string;
  seed: number;
  platforms: Platform[];
  hazards: Hazard[];
}

export interface PhysicsLike {
  SPEED: number;
  JUMP_V: number;
  GRAVITY_UP: number;
  GRAVITY_DOWN: number;
  W: number;
  H: number;
}
