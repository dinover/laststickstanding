/* Cuentas (opcionales) y tableros globales de mejores tiempos, sobre Supabase. Mismo proyecto,
   tablas y convenciones que V1: el usuario se mapea a un email sintético que nunca se muestra, la
   fila de `profiles` la crea un trigger al registrarse, y `run_times` es pública (insert sin login).
   Ahora como paquete npm empaquetado por Vite en vez de un <script> a un CDN. */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { get, writable } from "svelte/store";
import { isAccessoryId } from "@lss/shared";
import { profile, storyState, type StoryState } from "../app/persist";

const SUPABASE_URL = "https://kglguvgprvrmgwnanwah.supabase.co";
const SUPABASE_KEY = "sb_publishable_zs1YSW3c-v7WHIT4CbR-yQ_EtEE7DKd";
const AUTH_EMAIL_DOMAIN = "@laststickstanding.local";

let sb: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!sb) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

export interface AuthUser { id: string; username: string }
export const authUser = writable<AuthUser | null>(null);

export const LB_BOARDS = ["lss_easy", "lss_medium", "lss_hard", "lss_hardcore", "saga"] as const;
export type Board = (typeof LB_BOARDS)[number];
export interface LbRow { name: string; time_ms: number }
/** board -> top 3 (undefined = todavía no llegó o falló). */
export const leaderboards = writable<Partial<Record<Board, LbRow[] | null>>>({});

export function formatRunTime(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(totalSec / 60), ss = totalSec % 60;
  return mm + ":" + (ss < 10 ? "0" : "") + ss;
}

async function lbTop(board: Board, limit = 3): Promise<LbRow[]> {
  const res = await client().from("run_times").select("name,time_ms").eq("board", board).order("time_ms", { ascending: true }).limit(limit);
  if (res.error) throw res.error;
  return (res.data as LbRow[]) || [];
}

export async function refreshBoard(board: Board) {
  try {
    const rows = await lbTop(board, 3);
    leaderboards.update((l) => ({ ...l, [board]: rows }));
  } catch {
    leaderboards.update((l) => ({ ...l, [board]: null }));
  }
}

export function refreshAllBoards() {
  LB_BOARDS.forEach((b) => void refreshBoard(b));
}

/** Manda el tiempo y devuelve el mejor actual del tablero (o null si falló la red). */
export async function submitRun(board: Board, name: string, timeMs: number): Promise<LbRow | null> {
  try {
    const ins = await client().from("run_times").insert({ board, name: name.slice(0, 20), time_ms: Math.round(timeMs) });
    if (ins.error) throw ins.error;
    void refreshBoard(board);
    const best = await lbTop(board, 1);
    return best[0] || null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- cuentas */
const usernameValid = (u: string) => /^[a-z0-9_]{3,20}$/.test(u);
const emailFor = (u: string) => u.toLowerCase() + AUTH_EMAIL_DOMAIN;

export type AuthError = "format" | "short" | "mismatch" | "taken" | "badLogin" | "generic";

function friendly(err: { message?: string } | null): AuthError {
  const msg = (err && err.message) || "";
  if (/already registered|already exists/i.test(msg)) return "taken";
  if (/invalid login credentials/i.test(msg)) return "badLogin";
  return "generic";
}

export async function authSubmit(mode: "login" | "signup", usernameRaw: string, password: string, confirm?: string): Promise<AuthError | null> {
  const username = usernameRaw.trim().toLowerCase();
  if (!usernameValid(username)) return "format";
  if (!password || password.length < 6) return "short";
  if (mode === "signup" && password !== confirm) return "mismatch";
  try {
    const email = emailFor(username);
    const res = mode === "signup"
      ? await client().auth.signUp({ email, password })
      : await client().auth.signInWithPassword({ email, password });
    if (res.error) return friendly(res.error);
    const user = res.data.user;
    if (!user) return "generic";
    await onLoggedIn(user.id, username);
    return null;
  } catch (e) {
    return friendly(e as { message?: string });
  }
}

export async function authLogout() {
  try { await client().auth.signOut(); } catch { /* */ }
  authUser.set(null);
}

function storyEmpty(unlocks: Partial<StoryState["unlocks"]> | null | undefined, run: unknown) {
  const u = unlocks || {};
  return !run && !u.clearedEasy && !u.clearedMedium && !u.clearedHard && !u.clearedHardcore;
}

export function upsertProfile(fields: Record<string, unknown>) {
  const u = get(authUser);
  if (!u) return;
  void client().from("profiles").update({ updated_at: new Date().toISOString(), ...fields }).eq("id", u.id).then((res) => {
    if (res.error) console.error("[auth] no se pudo guardar el perfil:", res.error.message);
  });
}

async function onLoggedIn(userId: string, username: string) {
  authUser.set({ id: userId, username });
  const res = await client().from("profiles").select("*").eq("id", userId).single();
  if (res.error || !res.data) return;
  const row = res.data as Record<string, unknown>;
  const local = get(storyState);
  const remoteEmpty = storyEmpty(row.story_unlocks as StoryState["unlocks"], row.story_run);
  if (remoteEmpty && !storyEmpty(local.unlocks, local.run)) {
    const p = get(profile);
    upsertProfile({ username, display_name: p.name || null, color: p.color, hat: p.hat, story_unlocks: local.unlocks, story_run: local.run });
  } else {
    storyState.set({
      unlocks: { clearedEasy: false, clearedMedium: false, clearedHard: false, clearedHardcore: false, ...((row.story_unlocks as object) || {}) },
      run: (row.story_run as StoryState["run"]) || null,
    });
    profile.update((p) => ({
      name: (row.display_name as string) || username,
      color: (row.color as string) || p.color,
      hat: isAccessoryId(row.hat) ? row.hat : p.hat,
    }));
  }
}

let syncing = false;
/** Espeja cambios de perfil/progreso a la cuenta, si hay sesión. */
export function startProfileSync() {
  if (syncing) return;
  syncing = true;
  let first = true;
  profile.subscribe((p) => { if (!first) upsertProfile({ display_name: p.name || null, color: p.color, hat: p.hat }); });
  storyState.subscribe((s) => { if (!first) upsertProfile({ story_unlocks: s.unlocks, story_run: s.run }); });
  first = false;
}

export async function restoreSession() {
  try {
    const res = await client().auth.getSession();
    const session = res.data && res.data.session;
    if (!session) return;
    const username = (session.user.email || "").split("@")[0];
    await onLoggedIn(session.user.id, username);
  } catch (e) {
    console.error("[auth] no se pudo restaurar la sesión:", e);
  }
}
