/* Estado de UI compartido entre el motor del juego (sesiones) y los componentes Svelte. Las
   sesiones escriben acá; los componentes solo leen y llaman acciones. */

import { writable } from "svelte/store";

export type MenuScreen =
  | "home" | "solo" | "practiceDiff" | "practiceTheme" | "storyDiff" | "customize"
  | "join" | "origin" | "localSetup" | "pad" | "room";

export const menuScreen = writable<MenuScreen>("home");
/** true mientras hay una partida en pantalla (oculta el menú y activa el HUD). */
export const playing = writable(false);

export interface HudPlayer {
  id: number;
  color: string;
  name: string;
  alive: boolean;
  score: number;
  isMe: boolean;
}

export interface HudState {
  label: string;
  code: string | null;
  endLabel: string | null;
  players: HudPlayer[];
  showScores: boolean;
  clock: string | null;
  ping: number | null;
  timer: string | null;
}

export const hud = writable<HudState>({
  label: "", code: null, endLabel: null, players: [], showScores: false, clock: null, ping: null, timer: null,
});

/** Cartel de ronda (texto) — null lo oculta. */
export const banner = writable<string | null>(null);
/** Cada incremento dispara la animación de "¡A PELEAR!". */
export const fightPulse = writable(0);

export interface FinalRow { id: number; name: string; color: string; score: number }
export interface FinalState {
  title: string;
  winnerId: number | null;
  winnerColor: string;
  winnerHat: string;
  rows: FinalRow[];
  canRematch: boolean;
  showChangeMode: boolean;
  showBackMenu: boolean;
  unit: string;
}
export const finalScreen = writable<FinalState | null>(null);

export interface StoryMsg { title: string; body: string; button: string; onContinue: () => void; accent?: string }
export const storyMsg = writable<StoryMsg | null>(null);

export const crawl = writable<{ onEnd: () => void } | null>(null);

export interface ReconnectState { msg: string; gaveUp: boolean }
export const reconnect = writable<ReconnectState | null>(null);

export interface RevealSeg { text: string; color: string | null }
export interface RevealState { line1: RevealSeg[]; stats: RevealSeg[] }
export const scoreReveal = writable<RevealState | null>(null);

export const toast = writable<{ text: string; id: number } | null>(null);
let toastN = 0;
export function showToast(text: string) {
  toast.set({ text, id: ++toastN });
}

export const errors = writable<{ main: string; join: string; origin: string; room: string; local: string; pad: string }>({
  main: "", join: "", origin: "", room: "", local: "", pad: "",
});

export function setError(k: keyof ReturnType<typeof emptyErrors>, msg: string) {
  errors.update((e) => ({ ...e, [k]: msg }));
}
function emptyErrors() { return { main: "", join: "", origin: "", room: "", local: "", pad: "" }; }
export function clearErrors() { errors.set(emptyErrors()); }

export const fps = writable(0);

let fightPulseAt = -1e9;
/** Dispara la animación de "¡A PELEAR!" (y recuerda cuándo, por si el HUD se monta un instante después). */
export function pulseFight() {
  fightPulseAt = performance.now();
  fightPulse.update((n) => n + 1);
}
export function msSinceFightPulse() {
  return performance.now() - fightPulseAt;
}
