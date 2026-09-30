/* Estado persistente del jugador en localStorage (mismas claves que V1, así nadie pierde su
   progreso ni su personalización al pasar a V2): perfil, progreso de las dos campañas y ajustes.
   Si hay cuenta de Supabase, services/supabase.ts refleja perfil y progreso de Historia. */

import { writable, get } from "svelte/store";
import { isAccessoryId, cleanColor, type AccessoryId } from "@lss/shared";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* incógnito */ }
}

/* ---------------------------------------------------------------- perfil */
export interface Profile {
  name: string;
  color: string | null;
  hat: AccessoryId;
}

const rawProfile = load<Partial<Profile>>("lss-profile", {});
export const profile = writable<Profile>({
  name: typeof rawProfile.name === "string" ? rawProfile.name : "",
  color: cleanColor(rawProfile.color),
  hat: isAccessoryId(rawProfile.hat) ? rawProfile.hat : "none",
});
profile.subscribe((p) => save("lss-profile", p));

/* ---------------------------------------------------------------- Last Stick Standing (campaña clásica) */
export type StoryDifficulty = "easy" | "medium" | "hard" | "hardcore";
export interface StoryRun {
  difficulty: StoryDifficulty;
  biomeIdx: number;
  level: number;
  skipStreak: number;
  skippedSecretBiomes: number[];
  secretTakenBiomes: number[];
  elapsedMs: number;
}
export interface StoryUnlocks {
  clearedEasy: boolean;
  clearedMedium: boolean;
  clearedHard: boolean;
  clearedHardcore: boolean;
}
export interface StoryState {
  run: StoryRun | null;
  unlocks: StoryUnlocks;
}

const rawStory = load<Partial<StoryState>>("lss-story", {});
export const storyState = writable<StoryState>({
  run: rawStory.run || null,
  unlocks: { clearedEasy: false, clearedMedium: false, clearedHard: false, clearedHardcore: false, ...(rawStory.unlocks || {}) },
});
storyState.subscribe((s) => save("lss-story", s));

/* ---------------------------------------------------------------- Modo Historia (saga de 5 zonas) */
export interface SagaRun {
  zoneIdx: number;
  level: number;
  earnedPowers: string[];
  elapsedMs: number;
}
const rawSaga = load<{ run?: SagaRun | null }>("lss-saga", {});
export const sagaState = writable<{ run: SagaRun | null }>({ run: rawSaga.run || null });
sagaState.subscribe((s) => save("lss-saga", s));

/** Accesorios que se ganan completando Last Stick Standing. */
export function accessoryLock(id: string): { hintKey: string; mystery?: boolean } | null {
  const u = get(storyState).unlocks;
  if (id === "propeller" && !u.clearedEasy) return { hintKey: "hat.lockedEasy" };
  if (id === "flame" && !u.clearedMedium) return { hintKey: "hat.lockedMedium" };
  if (id === "crown" && !u.clearedHard) return { hintKey: "hat.lockedHard" };
  if (id === "orbit" && !u.clearedHardcore) return { hintKey: "hat.lockedMystery", mystery: true };
  return null;
}

/* ---------------------------------------------------------------- ajustes */
export interface Settings {
  quality: "high" | "low";
  dynamicCamera: boolean;
  reduceMotion: boolean;
  damageNumbers: boolean;
  showFps: boolean;
}
const prefersReduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const settings = writable<Settings>({
  quality: "high",
  dynamicCamera: true,
  reduceMotion: prefersReduced,
  damageNumbers: true,
  showFps: false,
  ...load<Partial<Settings>>("lss-settings", {}),
});
settings.subscribe((s) => save("lss-settings", s));
