/* El "sillón" del modo Local: quién está sentado (teclados, mandos, celulares), el modo elegido y
   la sala de mandos para los celulares. Port de V1 (la parte de modo local + celulares como
   control): el primer celular que entra "manda" (elige modo/rondas y arranca desde el teléfono);
   si se le apaga la pantalla, la posta pasa al siguiente conectado. */

import { get, writable } from "svelte/store";
import { MAX_PLAYERS, PLAYER_COLORS, ROOM_MODES, type RoomMode } from "@lss/shared";
import { engine } from "../game/engine";
import { LocalSession, type LocalPlayerDef, type LocalSource } from "../game/sessions/local";
import { PadHost } from "../net/padHost";
import { profile } from "./persist";
import { t } from "./i18n";
import { showFinal, hideFinal } from "./final";
import { menuScreen, setError } from "./ui";

export interface CouchPlayer extends LocalPlayerDef {
  auto: boolean;
  padOff?: boolean;
}

export interface PadPeer { pad: number; name: string; connected: boolean }

export const couch = writable<CouchPlayer[]>([]);
export const localMode = writable<RoomMode>("rounds");
export const localRounds = writable(3);
export const padState = writable<{ open: boolean; code: string | null; url: string; peers: PadPeer[]; status: string }>({
  open: false, code: null, url: "", peers: [], status: "",
});

let padHost: PadHost | null = null;
let padLeader: number | null = null;
let session: LocalSession | null = null;
const padSent: Record<number, string> = {};
const padHp: Record<number, number> = {};
const padBuzzT: Record<number, number> = {};
let syncTimer: number | null = null;

function players(): CouchPlayer[] { return get(couch); }

function nextFreeId(): number {
  const ps = players();
  for (let id = 0; id < MAX_PLAYERS; id++) if (!ps.some((p) => p.id === id)) return id;
  return -1;
}

export function autoName(i: number) { return t("player.n", { n: i + 1 }); }

export function relabelAutoNames() {
  couch.update((ps) => ps.map((p, i) => (p.auto ? { ...p, name: autoName(i) } : p)));
}

export function addLocalPlayer(source: LocalSource, name?: string): CouchPlayer | null {
  const id = nextFreeId();
  if (id === -1) return null;
  const ps = players();
  const p: CouchPlayer = {
    id, name: name || autoName(ps.length), auto: !name,
    color: PLAYER_COLORS[id % PLAYER_COLORS.length], source,
    // el accesorio guardado es de quien está frente a la máquina: se lo queda el primero
    hat: ps.length === 0 ? get(profile).hat : "none",
  };
  couch.set([...ps, p]);
  return p;
}

export function removeLocalPlayer(id: number) {
  const gone = players().find((p) => p.id === id);
  couch.update((ps) => ps.filter((p) => p.id !== id));
  if (gone && gone.source.type === "pad") {
    padHost?.kick(gone.source.pad, "removed");
    removePeer(gone.source.pad);
    updatePadLeader();
  }
}

export function renameLocalPlayer(id: number, name: string) {
  couch.update((ps) => ps.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name, auto: false } : p)));
  const p = players().find((x) => x.id === id);
  if (p) padIdentify(p);
}

export function hasKb(slot: 1 | 2) { return players().some((p) => p.source.type === "kb" && p.source.slot === slot); }
export function usedPads(): number[] { return players().flatMap((p) => (p.source.type === "gp" ? [p.source.index] : [])); }

/* ---------------------------------------------------------------- celulares */
function padPlayer(pad: number): CouchPlayer | undefined {
  return players().find((p) => p.source.type === "pad" && p.source.pad === pad);
}

function setPeers(fn: (peers: PadPeer[]) => PadPeer[]) {
  padState.update((s) => ({ ...s, peers: fn(s.peers) }));
}
function removePeer(pad: number) { setPeers((ps) => ps.filter((p) => p.pad !== pad)); delete padSent[pad]; delete padHp[pad]; }

function padIdentify(p: CouchPlayer) {
  if (p.source.type !== "pad") return;
  padHost?.sendTo(p.source.pad, { t: "you", name: p.name, color: p.color, leader: p.source.pad === padLeader });
}

function updatePadLeader() {
  const prev = padLeader;
  const cur = padLeader !== null ? padPlayer(padLeader) : undefined;
  if (!cur || cur.padOff) {
    padLeader = null;
    for (const p of players()) if (p.source.type === "pad" && !p.padOff) { padLeader = p.source.pad; break; }
  }
  if (padLeader === prev) return;
  for (const k in padSent) delete padSent[k];
  for (const p of players()) if (p.source.type === "pad") padIdentify(p);
}

function padStateFor(p: CouchPlayer): { phase: string; alive?: boolean } {
  if (!session) return { phase: "lobby" };
  if (!session.matchIds.has(p.id)) return { phase: "pending" };
  const sp = session.sim.players[p.id];
  return { phase: session.sim.phase, alive: !sp || sp.alive !== false };
}

export function syncPads() {
  if (!padHost || !get(padState).open) return;
  const now = performance.now();
  const ps = players();
  for (const p of ps) {
    if (p.source.type !== "pad") continue;
    const pad = p.source.pad;
    const st = padStateFor(p);
    const leader = pad === padLeader;
    const canStart = ps.length >= 2;
    const key = [st.phase, st.alive === false ? 0 : 1, leader ? 1 : 0, get(localMode), get(localRounds), canStart ? 1 : 0, ps.length].join("|");
    if (padSent[pad] !== key) {
      padSent[pad] = key;
      padHost.sendTo(pad, { t: "phase", phase: st.phase, alive: st.alive !== false, leader, mode: get(localMode), rounds: get(localRounds), canStart, players: ps.length });
    }
    if (!session || !session.matchIds.has(p.id)) { delete padHp[pad]; continue; }
    const sp = session.sim.players[p.id];
    if (!sp) continue;
    const prev = padHp[pad];
    if (prev != null && sp.hp < prev - 0.5 && now - (padBuzzT[pad] || 0) > 300) {
      padBuzzT[pad] = now;
      padHost.sendTo(pad, { t: "buzz", long: !sp.alive });
    }
    padHp[pad] = sp.hp;
  }
}

function wirePadHost(h: PadHost) {
  h.on("created", (info: { code: string; pads: PadPeer[] }) => {
    padState.update((s) => ({ ...s, open: true, code: info.code, url: h.joinUrl(), status: "" }));
    setError("pad", "");
    for (const peer of info.pads || []) {
      setPeers((ps) => [...ps.filter((x) => x.pad !== peer.pad), peer]);
      if (!padPlayer(peer.pad) && players().length < MAX_PLAYERS) addLocalPlayer({ type: "pad", pad: peer.pad }, peer.name);
      const p = padPlayer(peer.pad);
      if (p) { couch.update((ps) => ps.map((x) => (x.id === p.id ? { ...x, padOff: !peer.connected } : x))); padIdentify(p); }
    }
    updatePadLeader();
  });
  h.on("join", (msg: { pad: number; name: string }) => {
    setPeers((ps) => [...ps.filter((x) => x.pad !== msg.pad), { pad: msg.pad, name: msg.name, connected: true }]);
    let p = padPlayer(msg.pad);
    if (!p) {
      if (players().length >= MAX_PLAYERS) {
        h.kick(msg.pad, "full");
        removePeer(msg.pad);
        setError("pad", t("pad.full"));
        return;
      }
      p = addLocalPlayer({ type: "pad", pad: msg.pad }, msg.name) || undefined;
    } else {
      couch.update((ps) => ps.map((x) => (x.id === p!.id ? { ...x, padOff: false, name: msg.name || x.name, auto: msg.name ? false : x.auto } : x)));
    }
    delete padSent[msg.pad];
    updatePadLeader();
    const cur = padPlayer(msg.pad);
    if (cur) padIdentify(cur);
    syncPads();
  });
  h.on("leave", (msg: { pad: number }) => {
    setPeers((ps) => ps.map((x) => (x.pad === msg.pad ? { ...x, connected: false } : x)));
    const p = padPlayer(msg.pad);
    if (p) {
      couch.update((ps) => ps.map((x) => (x.id === p.id ? { ...x, padOff: true } : x)));
      session?.releasePlayer(p.id);
      updatePadLeader();
    }
  });
  h.on("gone", (msg: { pad: number }) => {
    removePeer(msg.pad);
    const p = padPlayer(msg.pad);
    if (p) removeLocalPlayer(p.id);
    updatePadLeader();
  });
  h.on("input", (msg: { pad: number; k: string; d: boolean }) => {
    const p = padPlayer(msg.pad);
    if (p && session) session.padInput(p.id, msg.k, !!msg.d);
  });
  h.on("msg", (msg: { pad: number; data: { t?: string; mode?: string; rounds?: number } }) => {
    const data = msg.data;
    if (!data || !data.t) return;
    if (data.t === "sync") { delete padSent[msg.pad]; syncPads(); return; }
    if (msg.pad !== padLeader) return;
    if (data.t === "setMode" && !session && (ROOM_MODES as readonly string[]).includes(data.mode || "")) { localMode.set(data.mode as RoomMode); syncPads(); return; }
    if (data.t === "setRounds" && !session) { localRounds.set(Math.max(1, Math.min(20, Number(data.rounds) || get(localRounds)))); syncPads(); return; }
    if (data.t === "start" && !session) { startLocalMatch(); syncPads(); return; }
    if (data.t === "again" && session && session.sim.phase === "final") { rematchLocal(); syncPads(); }
  });
  h.on("status", (s: string) => {
    if (s === "ready") setError("pad", "");
    else if (s === "reconnecting") setError("pad", t("pad.reconnecting"));
    else if (s === "error") { padState.update((st) => ({ ...st, open: false })); setError("pad", t("pad.failed")); }
  });
}

export function openPadRoom() {
  if (!padHost) { padHost = new PadHost(); wirePadHost(padHost); }
  if (!get(padState).open) padHost.open();
  if (!syncTimer) syncTimer = window.setInterval(syncPads, 100);
}

export function closePadRoom() {
  if (padHost) padHost.close();
  padHost = null;
  padLeader = null;
  padState.set({ open: false, code: null, url: "", peers: [], status: "" });
  couch.update((ps) => ps.filter((p) => p.source.type !== "pad"));
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

/* ---------------------------------------------------------------- partida */
export function startLocalMatch(): boolean {
  const ps = players();
  if (ps.length < 2) { setError("local", t("local.needTwo")); return false; }
  setError("local", "");
  hideFinal();
  session = new LocalSession(engine, ps.map(toDef), get(localMode), get(localRounds), {
    onFinal: (ranked, scores) => {
      const s = session!;
      showFinal({
        ranked, scores,
        nameFor: (id) => s.nameFor(id), colorFor: (id) => s.colorFor(id), hatFor: (id) => s.hatFor(id),
        canRematch: true, showChangeMode: true, showBackMenu: false,
        unit: get(localMode) === "orbking" ? "s" : undefined,
      });
    },
  });
  engine.start(session);
  for (const k in padSent) delete padSent[k];
  return true;
}

function toDef(p: CouchPlayer): LocalPlayerDef {
  return { id: p.id, name: p.name, color: p.color, hat: p.hat, source: p.source };
}

export function rematchLocal() {
  if (!session) return;
  hideFinal();
  session.rematch(players().map(toDef));
  for (const k in padSent) delete padSent[k];
}

/** Cortar la local vuelve al armado del sillón (la sala de mandos sigue abierta). */
export function exitLocalToSetup() {
  session = null;
  hideFinal();
  engine.stop();
  menuScreen.set("localSetup");
  for (const k in padSent) delete padSent[k];
}

export function isLocalActive() { return !!session; }

/* Un mando que se desenchufa en el armado sale del sillón; en plena partida se queda (sacarlo a
   mitad de ronda sería injusto) y el motor ya le soltó las teclas. */
window.addEventListener("gamepaddisconnected", (e) => {
  if (session) return;
  couch.update((ps) => ps.filter((p) => !(p.source.type === "gp" && p.source.index === e.gamepad.index)));
});
