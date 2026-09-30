import { mulberry32, type Rng } from "../rng";
import type { BiomeId } from "../constants";
import { ARCHETYPE_IDS, ARCHETYPE_NAMES, buildArchetype, type BuiltLayout } from "./archetypes";
import { getBiome, isBiomeId, randomBiome } from "./biomes";
import type { Hazard, MapDef, PhysicsLike, Platform } from "./types";

export const DESIGN_W = 960;
export const DESIGN_H = 540;

/* ---------------------------------------------------------------- alcanzabilidad */
/* Con las constantes reales de movimiento, ¿un salto recto lleva de una plataforma a otra? El
   generador lo usa para garantizar que todo el mapa esté conectado. */
export function makeReachability(c: PhysicsLike) {
  const { SPEED, JUMP_V } = c;
  const GU = c.GRAVITY_UP, GD = c.GRAVITY_DOWN;

  function airTime(dy: number): number | null {
    const tUp = -JUMP_V / GU;
    const apexDrop = (JUMP_V * JUMP_V) / (2 * GU);
    const remaining = apexDrop + dy;
    if (remaining < 0) {
      const a = 0.5 * GU, b = JUMP_V, cc = dy;
      const disc = b * b - 4 * a * cc;
      if (disc < 0) return null;
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      return t > 0 ? t : null;
    }
    return tUp + Math.sqrt((2 * remaining) / GD);
  }

  function maxHorizontal(dy: number): number {
    const t = airTime(dy);
    return t == null ? 0 : SPEED * t;
  }

  function rectGapX(a: Platform, b: Platform): number {
    if (a.x + a.w < b.x) return b.x - (a.x + a.w);
    if (b.x + b.w < a.x) return a.x - (b.x + b.w);
    return 0;
  }

  function reachable(a: Platform, b: Platform): boolean {
    const dy = b.y - a.y;
    const maxRise = (JUMP_V * JUMP_V) / (2 * GU);
    if (dy < -maxRise - 4) return false;
    return rectGapX(a, b) <= maxHorizontal(dy) * 0.86;
  }

  function components(platforms: Platform[]): number[][] {
    const n = platforms.length;
    if (!n) return [];
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (reachable(platforms[i], platforms[j]) || reachable(platforms[j], platforms[i])) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }
    const seen = new Array(n).fill(false);
    const comps: number[][] = [];
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const comp: number[] = [];
      const stack = [s];
      seen[s] = true;
      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const nb of adj[cur]) if (!seen[nb]) { seen[nb] = true; stack.push(nb); }
      }
      comps.push(comp);
    }
    return comps;
  }

  const allConnected = (platforms: Platform[]) => components(platforms).length <= 1;
  return { reachable, allConnected, components, maxHorizontal };
}

export function scaleLayout(platforms: Platform[], sx: number, sy: number): Platform[] {
  if (sx === 1 && sy === 1) return platforms;
  for (const p of platforms) {
    p.x *= sx; p.w *= sx;
    p.y *= sy; p.h *= sy;
  }
  return platforms;
}

export function scaleFromDesign(platforms: Platform[], W: number, H: number): Platform[] {
  return scaleLayout(platforms, W / DESIGN_W, H / DESIGN_H);
}

/* Última red de seguridad: arrastra el componente desconectado más chico hacia el grupo
   principal, de a poco y re-chequeando conectividad en cada paso. */
function connectAllPlatforms(platforms: Platform[], reach: ReturnType<typeof makeReachability>, W: number, H: number): boolean {
  for (let iter = 0; iter < 60; iter++) {
    const comps = reach.components(platforms);
    if (comps.length <= 1) return true;
    comps.sort((a, b) => a.length - b.length);
    const isolated = comps[0];
    const main: number[] = [];
    for (let c = 1; c < comps.length; c++) main.push(...comps[c]);
    let best: { a: Platform; b: Platform } | null = null;
    let bestDist = Infinity;
    for (const i of isolated) {
      for (const j of main) {
        const a = platforms[i], b = platforms[j];
        const d = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) + Math.abs(a.y - b.y);
        if (d < bestDist) { bestDist = d; best = { a, b }; }
      }
    }
    if (!best) return reach.allConnected(platforms);
    const stepX = (best.b.x + best.b.w / 2 - (best.a.x + best.a.w / 2)) * 0.25;
    const stepY = (best.b.y - best.a.y) * 0.25;
    for (const idx of isolated) {
      const pl = platforms[idx];
      pl.x = Math.max(20, Math.min(W - 20 - pl.w, pl.x + stepX));
      pl.y = Math.max(H * (120 / DESIGN_H), Math.min(H * (500 / DESIGN_H), pl.y + stepY));
    }
  }
  return reach.allConnected(platforms);
}

/* ---------------------------------------------------------------- púas */
/* La mayoría de los mapas no tiene. Cuando hay, van pegadas a UN borde de una plataforma ancha,
   para dejar una franja segura contigua. El tamaño de la púa no escala: el jugador no creció. */
function placeHazards(rng: Rng, built: BuiltLayout, scale: number): Hazard[] {
  const hazards: Hazard[] = [];
  if (!built.hazardCandidates.length) return hazards;
  if (rng() > 0.35) return hazards;
  const idx = built.hazardCandidates[Math.floor(rng() * built.hazardCandidates.length)];
  const pl = built.platforms[idx];
  if (!pl || pl.w < 110 * scale) return hazards;
  const w = Math.min(pl.w * 0.35, 55);
  const onLeft = rng() < 0.5;
  hazards.push({ type: "spikes", x: onLeft ? pl.x : pl.x + pl.w - w, y: pl.y, w, h: 10 });
  return hazards;
}

export function hazardHits(hz: Hazard, x: number, y: number, PW: number): boolean {
  return x + PW > hz.x && x - PW < hz.x + hz.w && y >= hz.y - 4 && y <= hz.y + 6;
}

export function checkHazards(p: { x: number; y: number }, map: MapDef, PW: number): boolean {
  for (const hz of map.hazards) if (hazardHits(hz, p.x, p.y, PW)) return true;
  return false;
}

/* ---------------------------------------------------------------- generador */
export function generateMap(
  seed: number,
  consts: PhysicsLike,
  forcedArchId?: string | null,
  forcedBiomeId?: string | null,
): MapDef {
  const W = consts.W, H = consts.H;
  const rng = mulberry32(seed);
  const reach = makeReachability(consts);
  const archId = forcedArchId && ARCHETYPE_IDS.includes(forcedArchId)
    ? forcedArchId
    : ARCHETYPE_IDS[Math.floor(rng() * ARCHETYPE_IDS.length)];

  /* Se construye en diseño, se estira y RECIÉN AHÍ se valida la conectividad: los huecos crecen
     con la escala pero el salto no. */
  const sx = W / DESIGN_W, sy = H / DESIGN_H;
  let built: BuiltLayout = buildArchetype(archId, rng, DESIGN_W, DESIGN_H);
  scaleLayout(built.platforms, sx, sy);
  for (let attempts = 1; attempts < 5 && !reach.allConnected(built.platforms); attempts++) {
    built = buildArchetype(archId, rng, DESIGN_W, DESIGN_H);
    scaleLayout(built.platforms, sx, sy);
  }
  if (!reach.allConnected(built.platforms)) connectAllPlatforms(built.platforms, reach, W, H);

  const biomeId: BiomeId = isBiomeId(forcedBiomeId) ? forcedBiomeId : randomBiome(rng);
  const pool = ARCHETYPE_NAMES[archId] || ["Sector Desconocido"];
  const name = pool[Math.floor(rng() * pool.length)] + " · " + getBiome(biomeId).name;

  return {
    name,
    biome: biomeId,
    archetype: archId,
    seed,
    platforms: built.platforms,
    hazards: placeHazards(rng, built, sx),
  };
}

/* Mapa fijo de la ronda 1 de casi toda partida, escrito en coordenadas de diseño. */
export function makeStartMap(W: number, H: number, biome: BiomeId = "ruinas", nameSuffix?: string): MapDef {
  const platforms = scaleFromDesign(
    [
      { x: 60, y: 460, w: 840, h: 26 },
      { x: 120, y: 340, w: 160, h: 18 },
      { x: 680, y: 340, w: 160, h: 18 },
      { x: 400, y: 250, w: 160, h: 18 },
    ],
    W,
    H,
  );
  return {
    name: "Plataforma Inicial" + (nameSuffix ? " · " + nameSuffix : ""),
    biome,
    archetype: "inicio",
    seed: 1,
    platforms,
    hazards: [],
  };
}

export function cloneMap(map: MapDef): MapDef {
  return {
    name: map.name,
    biome: map.biome,
    archetype: map.archetype,
    seed: map.seed,
    platforms: map.platforms.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
    hazards: map.hazards.map((h) => ({ ...h })),
  };
}
