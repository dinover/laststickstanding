/* Constantes compartidas entre cliente y servidor. En V1 varias de estas vivían copiadas a mano
   en tres archivos ("espejo exacto de..."); acá hay una sola fuente de verdad. */

/** Mundo lógico: 1.2x el diseño original (960x540), ver world/generate.ts. */
export const WORLD_W = 1152;
export const WORLD_H = 648;

/** Paso fijo de simulación. Todo (servidor, predicción, modos locales) avanza en pasos de esto. */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

export const MAX_PLAYERS = 8;

/* Los primeros 8 van en ese orden a propósito: son el color por defecto de cada slot. Los 6
   siguientes llenan huecos de tono (rojo, amarillo, menta, azul, violeta, blanco). */
export const PLAYER_COLORS = [
  "#35f0e0", "#ff2e88", "#9dff4f", "#ffc247", "#7b6cff", "#4fd2ff", "#ff7a3d", "#ff5ec4",
  "#ff3d3d", "#f2ff3d", "#2eff9d", "#4f7dff", "#d24fff", "#eef2ff",
] as const;

export const ACCESSORY_IDS = [
  "none", "horns", "halo", "tophat", "cap", "crown", "poop", "cowboy",
  "party", "bunny", "antennae", "arrow", "mohawk", "flame", "propeller", "orbit",
] as const;
export type AccessoryId = (typeof ACCESSORY_IDS)[number];

export function isAccessoryId(v: unknown): v is AccessoryId {
  return typeof v === "string" && (ACCESSORY_IDS as readonly string[]).includes(v);
}

/** Sin 0/O/1/I: el código se dicta en voz alta. */
export const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LEN = 4;

export const ROOM_MODES = ["rounds", "wins", "infinite", "koth", "orbking"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

export function normalizeMode(raw: unknown): RoomMode {
  return (ROOM_MODES as readonly unknown[]).includes(raw) ? (raw as RoomMode) : "rounds";
}

export const INPUT_KEYS = ["left", "right", "jump", "punch", "kick"] as const;
export type InputKey = (typeof INPUT_KEYS)[number];

export const POWER_TYPES = ["fuego", "hielo", "tierra", "aire"] as const;
export type PowerType = (typeof POWER_TYPES)[number];

export const POWER_COLORS: Record<PowerType, string> = {
  fuego: "#ff5a2e",
  hielo: "#4fd7ff",
  tierra: "#8a6a3a",
  aire: "#c9ffb0",
};

export const POWER_GLYPHS: Record<PowerType, string> = { fuego: "🔥", hielo: "❄️", tierra: "🛡️", aire: "⚡" };

export const BIOME_IDS = ["bosque", "ruinas", "volcan", "neon", "nieve"] as const;
export type BiomeId = (typeof BIOME_IDS)[number];

export function cleanNick(raw: unknown, fallback = "Jugador"): string {
  const s = String(raw == null ? "" : raw).replace(/[\u0000-\u001f<>]/g, "").trim();
  return s.slice(0, 14) || fallback;
}

export function cleanColor(raw: unknown): string | null {
  const c = String(raw == null ? "" : raw).trim().toLowerCase();
  const i = (PLAYER_COLORS as readonly string[]).indexOf(c);
  return i === -1 ? null : PLAYER_COLORS[i];
}

export function cleanHat(raw: unknown): AccessoryId {
  const h = String(raw == null ? "" : raw).trim().toLowerCase();
  return isAccessoryId(h) ? h : "none";
}
