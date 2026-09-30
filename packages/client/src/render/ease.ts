/* Curvas de easing de GSAP como funciones puras (t 0..1 → 0..1), para muestrear animaciones por
   tiempo o por progreso sin crear tweens. Se cachean por nombre ("expo.out", "back.out(1.6)"...). */

import { gsap } from "gsap";

const cache = new Map<string, (t: number) => number>();

export function ease(name = "sine.inOut"): (t: number) => number {
  let e = cache.get(name);
  if (!e) { e = gsap.parseEase(name) as (t: number) => number; cache.set(name, e); }
  return e;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
