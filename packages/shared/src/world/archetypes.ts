import { clamp, type Rng } from "../rng";
import type { Platform } from "./types";

/* Layouts escritos en el espacio de diseño 960x540 (los números de siempre). generateMap los
   estira al mundo real. Cada builder devuelve también en qué plataformas es seguro poner púas
   (nunca en la única ruta). */

export interface BuiltLayout {
  platforms: Platform[];
  hazardCandidates: number[];
}

type Builder = (rng: Rng, W: number, H: number) => BuiltLayout;

const archetypes: Record<string, Builder> = {
  arena(rng, W) {
    const floorW = 480 + rng() * 220;
    const floorX = (W - floorW) / 2 + (rng() - 0.5) * 60;
    const plats: Platform[] = [{ x: floorX, y: 460 + (rng() - 0.5) * 14, w: floorW, h: 26 }];
    const sideW = 130 + rng() * 50;
    const sideY = 320 + (rng() - 0.5) * 30;
    plats.push({ x: 70 + rng() * 40, y: sideY, w: sideW, h: 18 });
    plats.push({ x: W - 70 - sideW - rng() * 40, y: sideY, w: sideW, h: 18 });
    const midW = 150 + rng() * 60;
    plats.push({ x: (W - midW) / 2, y: 210 + (rng() - 0.5) * 24, w: midW, h: 18 });
    return { platforms: plats, hazardCandidates: [1, 2] };
  },

  puente(rng, W) {
    const islandW = 190 + rng() * 60;
    const y0 = 380 + (rng() - 0.5) * 30;
    const plats: Platform[] = [
      { x: 50 + rng() * 20, y: y0, w: islandW, h: 24 },
      { x: W - 50 - islandW - rng() * 20, y: y0, w: islandW, h: 24 },
    ];
    const bridgeW = 140 + rng() * 60;
    plats.push({ x: (W - bridgeW) / 2, y: y0 - (70 + rng() * 40), w: bridgeW, h: 14 });
    plats.push({ x: 90 + rng() * 30, y: y0 - 150 - rng() * 20, w: 110, h: 16 });
    plats.push({ x: W - 90 - 110 - rng() * 30, y: y0 - 150 - rng() * 20, w: 110, h: 16 });
    return { platforms: plats, hazardCandidates: [] };
  },

  torre(rng, W) {
    const n = 5 + Math.floor(rng() * 2);
    const plats: Platform[] = [];
    let y = 480;
    let side = rng() < 0.5 ? 1 : -1;
    let x = W / 2 - 90;
    for (let i = 0; i < n; i++) {
      const w = 150 - i * 8 + rng() * 30;
      x = clamp(x + side * (60 + rng() * 60), 60, W - 60 - w);
      plats.push({ x, y, w, h: 18 });
      y -= 70 + rng() * 20;
      side *= rng() < 0.7 ? -1 : 1;
    }
    return { platforms: plats, hazardCandidates: plats.map((_, i) => i).slice(0, -1) };
  },

  escalera(rng, W) {
    const n = 5 + Math.floor(rng() * 2);
    const plats: Platform[] = [];
    const stepW = 150 + rng() * 30;
    const x0 = 50, x1 = W - 50 - stepW;
    const y0 = 470, y1 = 190;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = x0 + (x1 - x0) * t + (rng() - 0.5) * 20;
      const y = y0 + (y1 - y0) * t + (rng() - 0.5) * 14;
      plats.push({ x, y, w: stepW - t * 30, h: 17 });
    }
    return { platforms: plats, hazardCandidates: [] };
  },

  islas(rng, W) {
    const w = 230 + rng() * 50;
    const y = 370 + (rng() - 0.5) * 30;
    const plats: Platform[] = [
      { x: 50 + rng() * 15, y, w, h: 24 },
      { x: W - 50 - w - rng() * 15, y, w, h: 24 },
    ];
    const midW = 190 + rng() * 40;
    plats.push({ x: (W - midW) / 2 + (rng() - 0.5) * 20, y: y - 115 - rng() * 20, w: midW, h: 18 });
    return { platforms: plats, hazardCandidates: [2] };
  },

  anillo(rng, W) {
    const cx = W / 2, cy = 300 + (rng() - 0.5) * 20;
    const rx = 260 + rng() * 40, ry = 140 + rng() * 20;
    const n = 5 + Math.floor(rng() * 2);
    const plats: Platform[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const w = 120 + rng() * 40;
      const x = cx + Math.cos(ang) * rx - w / 2;
      const y = cy + Math.sin(ang) * ry;
      plats.push({ x: clamp(x, 40, W - 40 - w), y: clamp(y, 160, 470), w, h: 16 });
    }
    return { platforms: plats, hazardCandidates: plats.map((_, i) => i) };
  },

  crater(rng, W) {
    const halfW = 300 + rng() * 60;
    const y = 440 + (rng() - 0.5) * 20;
    const plats: Platform[] = [
      { x: 50, y, w: halfW, h: 26 },
      { x: W - 50 - halfW, y, w: halfW, h: 26 },
    ];
    const midW = 130 + rng() * 40;
    plats.push({ x: (W - midW) / 2, y: y - 130 - rng() * 30, w: midW, h: 16 });
    const sideW = 100 + rng() * 20;
    plats.push({ x: 130 + rng() * 30, y: y - 90 - rng() * 20, w: sideW, h: 14 });
    plats.push({ x: W - 130 - sideW - rng() * 30, y: y - 90 - rng() * 20, w: sideW, h: 14 });
    return { platforms: plats, hazardCandidates: [2] };
  },

  /* Rey de la Colina: mucho más terreno (10 plataformas) y sin púas. */
  colina(rng, W) {
    const plats: Platform[] = [];
    const floorW = 420 + rng() * 160;
    const floorX = (W - floorW) / 2 + (rng() - 0.5) * 40;
    plats.push({ x: floorX, y: 470 + (rng() - 0.5) * 10, w: floorW, h: 24 });
    const lowW = 130 + rng() * 30;
    plats.push({ x: 40 + rng() * 20, y: 400 + (rng() - 0.5) * 20, w: lowW, h: 16 });
    plats.push({ x: W - 40 - lowW - rng() * 20, y: 400 + (rng() - 0.5) * 20, w: lowW, h: 16 });
    const cx = W / 2, cy = 300, rx = 300 + rng() * 30, ry = 110 + rng() * 20, n = 6;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const w = 90 + rng() * 40;
      const x = clamp(cx + Math.cos(ang) * rx - w / 2, 40, W - 40 - w);
      const y = clamp(cy + Math.sin(ang) * ry, 150, 420);
      plats.push({ x, y, w, h: 15 });
    }
    const apexW = 130 + rng() * 30;
    plats.push({ x: (W - apexW) / 2 + (rng() - 0.5) * 20, y: 165 + (rng() - 0.5) * 16, w: apexW, h: 16 });
    return { platforms: plats, hazardCandidates: [] };
  },

  piramide(rng, W) {
    const layers = 3 + Math.floor(rng() * 2);
    const plats: Platform[] = [];
    const baseW = 620 + rng() * 100;
    let y = 470;
    for (let i = 0; i < layers; i++) {
      const layerW = baseW - i * (baseW / (layers + 0.6));
      const count = layers - i;
      const totalGap = 40 * (count - 1);
      const segW = (layerW - totalGap) / count;
      const startX = (W - layerW) / 2 + (rng() - 0.5) * 20;
      for (let s = 0; s < count; s++) plats.push({ x: startX + s * (segW + 40), y, w: segW, h: 16 });
      y -= 78 + rng() * 12;
    }
    return { platforms: plats, hazardCandidates: [] };
  },

  /* Arena de jefe (Modo Historia): piso de punta a punta, no hay forma de caer al vacío. Fuera del sorteo. */
  santuario(rng, W) {
    const plats: Platform[] = [{ x: 0, y: 490 + (rng() - 0.5) * 10, w: W, h: 30 }];
    const sideW = 160 + rng() * 30;
    const sideY = 330 + (rng() - 0.5) * 20;
    plats.push({ x: 60 + rng() * 20, y: sideY, w: sideW, h: 18 });
    plats.push({ x: W - 60 - sideW - rng() * 20, y: sideY, w: sideW, h: 18 });
    const midW = 170 + rng() * 40;
    plats.push({ x: (W - midW) / 2, y: 190 + (rng() - 0.5) * 20, w: midW, h: 18 });
    return { platforms: plats, hazardCandidates: [] };
  },
};

export const ARCHETYPE_IDS = Object.keys(archetypes);

/** Archetypes de "pelea normal" (sin los de propósito específico). */
export const STANDARD_ARCHETYPES = ARCHETYPE_IDS.filter((id) => id !== "colina" && id !== "santuario");

export function buildArchetype(id: string, rng: Rng, W: number, H: number): BuiltLayout {
  return archetypes[id](rng, W, H);
}

export const ARCHETYPE_NAMES: Record<string, string[]> = {
  arena: ["Arena Central", "Círculo de Combate", "Coliseo"],
  puente: ["Puente Roto", "El Abismo", "Cruce Peligroso"],
  torre: ["Torre Ascendente", "Escalinata al Cielo", "Ascenso"],
  escalera: ["Zigzag", "Senda Quebrada", "Diagonal"],
  islas: ["Islas Gemelas", "Frente a Frente", "Doble Bastión"],
  anillo: ["El Anillo", "Círculo Exterior", "Corona"],
  crater: ["El Cráter", "La Fosa", "Filo del Vacío"],
  piramide: ["La Pirámide", "Templo Escalonado", "Zigurat"],
  colina: ["La Colina", "Cumbre Disputada", "El Trono"],
  santuario: ["El Santuario", "Cámara del Guardián", "Sala del Juicio"],
};
