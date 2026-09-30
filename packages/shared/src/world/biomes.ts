import { BIOME_IDS, type BiomeId } from "../constants";
import type { Rng } from "../rng";

export type AmbientKind = "leaves" | "dust" | "ash" | "sparks" | "snow";

export interface BiomeDef {
  id: BiomeId;
  name: string;
  sky: [string, string];
  platform: { base: string; edge: string; glow: string };
  accentText: string;
  particle: AmbientKind;
  particleColor: string;
  /** Tinte de luz ambiente para el post-proceso del cliente (V2). */
  light: string;
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
  bosque: {
    id: "bosque",
    name: "Bosque",
    sky: ["#0c1a12", "#173424"],
    platform: { base: "#20361f", edge: "#7be26a", glow: "rgba(123,226,106,.55)" },
    accentText: "#7be26a",
    particle: "leaves",
    particleColor: "#8fd45a",
    light: "#9dff8a",
  },
  ruinas: {
    id: "ruinas",
    name: "Ruinas",
    sky: ["#0a0c18", "#1a1f30"],
    platform: { base: "#26293e", edge: "#9fb2ff", glow: "rgba(159,178,255,.5)" },
    accentText: "#9fb2ff",
    particle: "dust",
    particleColor: "#cdd6ff",
    light: "#b8c6ff",
  },
  volcan: {
    id: "volcan",
    name: "Volcán",
    sky: ["#1a0a08", "#3a140c"],
    platform: { base: "#2e1613", edge: "#ff7a3c", glow: "rgba(255,122,60,.6)" },
    accentText: "#ff7a3c",
    particle: "ash",
    particleColor: "#ffb37a",
    light: "#ff8a4a",
  },
  neon: {
    id: "neon",
    name: "Neón",
    sky: ["#08060f", "#150a26"],
    platform: { base: "#1c1330", edge: "#ff2ed6", glow: "rgba(255,46,214,.7)" },
    accentText: "#35f0e0",
    particle: "sparks",
    particleColor: "#35f0e0",
    light: "#ff5ee8",
  },
  nieve: {
    id: "nieve",
    name: "Nieve",
    sky: ["#0d1522", "#1e2c40"],
    platform: { base: "#233246", edge: "#d8ecff", glow: "rgba(216,236,255,.55)" },
    accentText: "#d8ecff",
    particle: "snow",
    particleColor: "#eaf4ff",
    light: "#dbeeff",
  },
};

export function getBiome(id: string | null | undefined): BiomeDef {
  return (id && BIOMES[id as BiomeId]) || BIOMES.bosque;
}

export function randomBiome(rng: Rng): BiomeId {
  return BIOME_IDS[Math.floor(rng() * BIOME_IDS.length)];
}

export function isBiomeId(v: unknown): v is BiomeId {
  return typeof v === "string" && (BIOME_IDS as readonly string[]).includes(v);
}
