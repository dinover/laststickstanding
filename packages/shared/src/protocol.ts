/* Protocolo de red. Binario (MessagePack vía msgpackr) en vez del JSON de V1, con los jugadores
   del snapshot empaquetados como tuplas cuantizadas: el snapshot típico baja de ~2.3 KB a unos
   pocos cientos de bytes.

   Los mensajes del cliente se validan con zod en el servidor (antes era validación a mano,
   mensaje por mensaje). */

import { Packr } from "msgpackr";
import { z } from "zod";
import { INPUT_KEYS, POWER_TYPES } from "./constants";
import type { GameMode, Phase, Player, SimEvent } from "./sim/types";
import type { MapDef } from "./world/types";

const packr = new Packr({ useRecords: false, int64AsType: "number" });

export function encode(msg: unknown): Uint8Array {
  return packr.pack(msg);
}

export function decode<T = unknown>(buf: Uint8Array | ArrayBuffer): T {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return packr.unpack(u8) as T;
}

/* ---------------------------------------------------------------- input por tick */
/* El cliente manda un frame de input por tick de simulación (60/s). Los flancos (salto, piña,
   patada) son "se apretó desde el frame anterior"; izquierda/derecha son estado sostenido. */
export const IN_LEFT = 1, IN_RIGHT = 2, IN_JUMP = 4, IN_PUNCH = 8, IN_KICK = 16;

export interface InputFrame {
  seq: number;
  bits: number;
}

/* ---------------------------------------------------------------- cliente → servidor */
const nick = z.string().max(40).optional();
const color = z.string().max(16).nullish();
const hat = z.string().max(16).nullish();
const code = z.string().max(8);
const anyData = z.unknown();

export const ClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping"), ts: z.number() }),
  z.object({ t: z.literal("create"), nick, color, hat }),
  z.object({ t: z.literal("join"), code, nick, color, hat }),
  z.object({ t: z.literal("rejoin"), code, token: z.string().max(64) }),
  // Frames de input en lote: el cliente puede mandar más de uno por paquete si se atrasó.
  z.object({ t: z.literal("in"), f: z.array(z.tuple([z.number().int(), z.number().int().min(0).max(31)])).max(12) }),
  z.object({ t: z.literal("setMode"), mode: z.string().max(16) }),
  z.object({ t: z.literal("setRounds"), rounds: z.number() }),
  z.object({ t: z.literal("start") }),
  z.object({ t: z.literal("again") }),
  z.object({ t: z.literal("endMatch") }),
  z.object({ t: z.literal("leave") }),
  // Sala de mandos (celulares como control del modo Local)
  z.object({ t: z.literal("padCreate"), token: z.string().max(64).optional() }),
  z.object({ t: z.literal("padTo"), pad: z.number().int(), data: anyData }),
  z.object({ t: z.literal("padAll"), data: anyData }),
  z.object({ t: z.literal("padKick"), pad: z.number().int(), reason: z.string().max(32).nullish() }),
  z.object({ t: z.literal("padClose") }),
  z.object({ t: z.literal("padJoin"), code, nick, token: z.string().max(64).optional() }),
  z.object({ t: z.literal("padInput"), k: z.enum(INPUT_KEYS), d: z.boolean() }),
  z.object({ t: z.literal("padMsg"), data: anyData }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/* ---------------------------------------------------------------- servidor → cliente */
export interface LobbyPlayer {
  id: number;
  name: string;
  color: string;
  hat: string;
  connected: boolean;
}

export type ServerMsg =
  | { t: "pong"; ts: number }
  | { t: "joined"; code: string; id: number; owner: number | null; token: string; resumed?: boolean }
  | { t: "lobby"; code: string; owner: number | null; phase: Phase; mode: string; rounds: number; players: LobbyPlayer[] }
  | { t: "started" }
  | { t: "toLobby" }
  | {
      t: "round"; round: number; totalRounds: number | null; mapName: string; infinite: boolean;
      mode: string; rounds: number; stats: Record<number, { kicks: number; punches: number; falls: number; hitsLanded: number; hitsTaken: number }>;
    }
  | { t: "err"; code: string; msg?: string }
  | { t: "rejoinFailed" }
  | Snapshot
  | { t: "padCreated"; code: string; token: string; pads: { pad: number; name: string; connected: boolean }[]; resumed?: boolean }
  | { t: "padJoin"; pad: number; name: string; resumed: boolean }
  | { t: "padLeave"; pad: number }
  | { t: "padGone"; pad: number }
  | { t: "padInput"; pad: number; k: string; d: boolean }
  | { t: "padMsg"; pad?: number; data: unknown }
  | { t: "padJoined"; code: string; pad: number; token: string; name: string }
  | { t: "padErr"; code: string }
  | { t: "padKicked"; reason: string | null }
  | { t: "padClosed" }
  | { t: "padHostGone" }
  | { t: "padHostBack" };

/* ---------------------------------------------------------------- snapshot */
export const PHASES: Phase[] = ["lobby", "fightIntro", "fight", "roundEnd", "final"];
export const GAME_MODES: GameMode[] = ["normal", "koth", "orbking"];

/** Estado de un jugador tal como viaja (y como lo reconstruye el cliente). */
export interface NetPlayer {
  id: number;
  x: number; y: number; vx: number; vy: number; kbx: number;
  alive: boolean; grounded: boolean; facing: 1 | -1; isBot: boolean; isHero: boolean;
  hp: number; walkCycle: number; idleT: number; squash: number;
  hitStunT: number; hitDir: number; jumpAnticT: number; deathFadeT: number;
  power: Player["power"];
  burnT: number; burnFlashT: number; slowT: number;
  attack: { type: "punch" | "kick"; t: number; dur: number } | null;
  jumpsLeft: number; attackCooldown: number; jumpBufT: number;
  /** Último frame de input de ESTE jugador que el servidor ya aplicó (para reconciliar). */
  ack: number;
}

export type PlayerTuple = number[];

const q = (v: number, m: number) => Math.round((v || 0) * m);

export function packPlayer(p: Player, ack: number): PlayerTuple {
  let flags = 0;
  if (p.alive) flags |= 1;
  if (p.grounded) flags |= 2;
  if (p.facing > 0) flags |= 4;
  if (p.isBot) flags |= 8;
  if (p.isHero) flags |= 16;
  let pBits = 0;
  if (p.power) POWER_TYPES.forEach((k, i) => { if (p.power![k]) pBits |= 1 << i; });
  const atk = p.attack;
  return [
    p.id, q(p.x, 10), q(p.y, 10), q(p.vx, 100), q(p.vy, 100), q(p.kbx, 100), flags, Math.round(p.hp),
    q(p.walkCycle, 1000), q(p.idleT, 100), q(p.squash, 1000), Math.round(p.hitStunT), p.hitDir > 0 ? 1 : -1,
    Math.round(p.jumpAnticT), Math.round(p.deathFadeT), pBits, p.power ? Math.round(p.power.t) : 0,
    Math.round(p.burnT), Math.round(p.burnFlashT), Math.round(p.slowT),
    atk ? (atk.type === "punch" ? 1 : 2) : 0, atk ? Math.round(atk.t) : 0, atk ? atk.dur : 0,
    p.jumpsLeft, ack, Math.round(p.attackCooldown), Math.round(p.jumpBufT),
  ];
}

export function unpackPlayer(t: PlayerTuple): NetPlayer {
  const flags = t[6], pBits = t[15];
  let power: Player["power"] = null;
  if (pBits) {
    power = { t: t[16] };
    POWER_TYPES.forEach((k, i) => { if (pBits & (1 << i)) power![k] = true; });
  }
  return {
    id: t[0], x: t[1] / 10, y: t[2] / 10, vx: t[3] / 100, vy: t[4] / 100, kbx: t[5] / 100,
    alive: !!(flags & 1), grounded: !!(flags & 2), facing: flags & 4 ? 1 : -1, isBot: !!(flags & 8), isHero: !!(flags & 16),
    hp: t[7], walkCycle: t[8] / 1000, idleT: t[9] / 100, squash: t[10] / 1000, hitStunT: t[11], hitDir: t[12],
    jumpAnticT: t[13], deathFadeT: t[14], power, burnT: t[17], burnFlashT: t[18], slowT: t[19],
    attack: t[20] ? { type: t[20] === 1 ? "punch" : "kick", t: t[21], dur: t[22] } : null,
    jumpsLeft: t[23], ack: t[24], attackCooldown: t[25], jumpBufT: t[26],
  };
}

export interface Snapshot {
  t: "s";
  /** Tick del servidor. */
  n: number;
  ph: number;
  r: number;
  tr: number | null;
  gm: number;
  ro: number[];
  sc: [number, number][];
  p: PlayerTuple[];
  o: [number, number, number, number] | null;
  h: [number, number, number] | null;
  ok: number;
  /** Mapa completo: solo cuando cambió (o para quien recién entra). */
  m?: MapDef;
  /** Eventos de la simulación desde el snapshot anterior (efectos + audio para todos). */
  e?: SimEvent[];
}

export function orbTuple(orb: { type: string; x: number; y: number; bornT: number } | null): Snapshot["o"] {
  if (!orb) return null;
  return [POWER_TYPES.indexOf(orb.type as (typeof POWER_TYPES)[number]), q(orb.x, 10), q(orb.y, 10), Math.round(orb.bornT)];
}

export function orbFromTuple(t: Snapshot["o"]) {
  if (!t) return null;
  return { type: POWER_TYPES[t[0]] || "fuego", x: t[1] / 10, y: t[2] / 10, bornT: t[3] };
}
