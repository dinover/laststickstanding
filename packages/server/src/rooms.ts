/* Salas de juego online: una instancia de Sim por sala (ya no hace falta el contexto `vm` de V1),
   paso fijo de 60 Hz con acumulador, cola de input por jugador con buffer anti-jitter y snapshots
   binarios a 30 Hz. */

import crypto from "node:crypto";
import type { WebSocket } from "ws";
import {
  IN_JUMP, IN_KICK, IN_LEFT, IN_PUNCH, IN_RIGHT, MAX_PLAYERS, PLAYER_COLORS, GAME_MODES, PHASES, TICK_MS,
  Sim, cleanColor, cleanHat, cleanNick, normalizeMode, orbTuple, packPlayer,
  type LobbyPlayer, type RoomMode, type ServerMsg, type SimEvent, type Snapshot,
} from "@lss/shared";
import { freeCode, send, broadcastRaw, encodeMsg } from "./util";

export const REJOIN_GRACE_MS = 30000;
export const EMPTY_ROOM_GRACE_MS = 60000;
const BROADCAST_EVERY = 2; // ticks → 30 Hz
/* Buffer anti-jitter: el servidor consume un frame de input por tick. Si se acumulan más de
   MAX_QUEUE (el cliente mandó en ráfaga), se fusionan los sobrantes; si la cola está vacía, se
   repite lo que tenía apretado sin flancos. */
const MAX_QUEUE = 4;

export interface RoomPlayer {
  id: number;
  name: string;
  color: string;
  hat: string;
  ws: WebSocket | null;
  connected: boolean;
  token: string;
  goneSince: number | null;
  queue: [number, number][];
  ack: number;
  held: number;
}

export interface Room {
  code: string;
  players: Map<number, RoomPlayer>;
  ownerId: number | null;
  sim: Sim;
  mode: RoomMode;
  rounds: number;
  timer: NodeJS.Timeout | null;
  last: number;
  acc: number;
  tickCount: number;
  createdAt: number;
  lastMapKey: string | null;
  events: SimEvent[];
  emptySince: number | null;
}

export const rooms = new Map<string, Room>();

export function countPlayers(): number {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return n;
}

export function createRoom(isTaken: (c: string) => boolean): Room | null {
  const code = freeCode(isTaken);
  if (!code) return null;
  const room: Room = {
    code, players: new Map(), ownerId: null, sim: new Sim(), mode: "rounds", rounds: 3,
    timer: null, last: 0, acc: 0, tickCount: 0, createdAt: performance.now(), lastMapKey: null, events: [], emptySince: Date.now(),
  };
  room.sim.setHooks({ onPhase: (info) => { if (info.t === "roundStart") onRoundStart(room, info); } });
  rooms.set(code, room);
  return room;
}

export function destroyRoom(room: Room) {
  stopLoop(room);
  rooms.delete(room.code);
}

/* Saca de la ronda el cuerpo de alguien que ya no está: tirándolo fuera del mapa se elimina por el
   camino normal (que respeta el orden de eliminación y cierra la ronda). */
function dropBody(room: Room, id: number) {
  const p = room.sim.players[id];
  if (p && p.alive) { p.y = 100000; p.vy = 1; }
}

function onRoundStart(room: Room, info: { round: number; totalRounds: number; mapName: string; infinite: boolean }) {
  for (const id of room.sim.roster) if (!room.players.has(id)) dropBody(room, id);
  broadcast(room, {
    t: "round", round: info.round, totalRounds: Number.isFinite(info.totalRounds) ? info.totalRounds : null,
    mapName: info.mapName, infinite: info.infinite, mode: room.mode, rounds: room.rounds, stats: room.sim.matchStats,
  });
}

/* ---------------------------------------------------------------- loop */
export function startLoop(room: Room) {
  if (room.timer) return;
  room.last = performance.now();
  room.acc = 0;
  room.timer = setInterval(() => tick(room), 4);
}

export function stopLoop(room: Room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}

function applyInputs(room: Room) {
  for (const p of room.players.values()) {
    const sp = room.sim.players[p.id];
    if (!sp) continue;
    if (!p.connected) { p.queue.length = 0; continue; }
    let frame: [number, number] | undefined;
    if (p.queue.length > MAX_QUEUE) {
      // fusionar los sobrantes: flancos con OR, estado sostenido del más nuevo
      let edges = 0;
      while (p.queue.length > 2) edges |= p.queue.shift()![1] & (IN_JUMP | IN_PUNCH | IN_KICK);
      frame = p.queue.shift()!;
      frame = [frame[0], frame[1] | edges];
    } else frame = p.queue.shift();
    if (frame) {
      p.ack = frame[0];
      p.held = frame[1] & (IN_LEFT | IN_RIGHT);
      const b = frame[1];
      if (b & IN_JUMP) sp.jumpEdge = true;
      if (b & IN_PUNCH) sp.punchEdge = true;
      if (b & IN_KICK) sp.kickEdge = true;
    }
    sp.input.left = !!(p.held & IN_LEFT);
    sp.input.right = !!(p.held & IN_RIGHT);
  }
}

function tick(room: Room) {
  const now = performance.now();
  room.acc += Math.min(250, now - room.last);
  room.last = now;
  let steps = 0;
  while (room.acc >= TICK_MS && steps < 8) {
    room.acc -= TICK_MS;
    steps++;
    applyInputs(room);
    room.sim.step(TICK_MS);
    room.tickCount++;
    const evs = room.sim.drainEvents();
    if (evs.length) { room.events.push(...evs); if (room.events.length > 96) room.events.splice(0, room.events.length - 96); }
    if (room.tickCount % BROADCAST_EVERY === 0) broadcastSnapshot(room);
    if (room.sim.phase === "final") {
      broadcastSnapshot(room);
      stopLoop(room);
      return;
    }
  }
  if (steps >= 8) room.acc = 0;
}

/** Reloj de sala en ticks (no se frena cuando la sim está parada entre partidas). */
function roomClock(room: Room): number {
  return Math.round((performance.now() - room.createdAt) / TICK_MS);
}

export function buildSnapshot(room: Room, forceMap = false): Snapshot {
  const sim = room.sim;
  const key = sim.currentMap.name + ":" + sim.currentMap.seed;
  const includeMap = forceMap || key !== room.lastMapKey;
  room.lastMapKey = key;
  const snap: Snapshot = {
    t: "s",
    n: roomClock(room),
    ph: PHASES.indexOf(sim.phase),
    r: sim.currentRound,
    tr: Number.isFinite(sim.totalRounds) ? sim.totalRounds : null,
    gm: GAME_MODES.indexOf(sim.gameMode),
    ro: sim.roster,
    sc: sim.roster.map((id) => [id, sim.scores[id] || 0] as [number, number]),
    p: sim.roster.filter((id) => sim.players[id]).map((id) => packPlayer(sim.players[id], room.players.get(id)?.ack ?? 0)),
    o: orbTuple(sim.orb),
    h: sim.hill ? [Math.round(sim.hill.x * 10), Math.round(sim.hill.y * 10), sim.hill.r] : null,
    ok: Math.round(sim.orbkingTimer),
  };
  if (includeMap) snap.m = sim.cloneMap();
  if (room.events.length) { snap.e = room.events; room.events = []; }
  return snap;
}

function broadcastSnapshot(room: Room) {
  const payload = encodeMsg(buildSnapshot(room));
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    // un cliente saturado no frena a los demás: si tiene ~1 s encolado, se le saltea este frame
    if (p.ws.bufferedAmount > payload.byteLength * 30) continue;
    p.ws.send(payload);
  }
}

/* ---------------------------------------------------------------- lobby */
export function broadcast(room: Room, msg: ServerMsg) {
  broadcastRaw([...room.players.values()].map((p) => p.ws), encodeMsg(msg));
}

export function lobbyState(room: Room): ServerMsg {
  const players: LobbyPlayer[] = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat, connected: p.connected }));
  return { t: "lobby", code: room.code, owner: room.ownerId, phase: room.sim.phase, mode: room.mode, rounds: room.rounds, players };
}

export function pushLobby(room: Room) {
  broadcast(room, lobbyState(room));
}

function freeSlot(room: Room): number | null {
  for (let id = 0; id < MAX_PLAYERS; id++) if (!room.players.has(id)) return id;
  return null;
}

function pickColor(room: Room, wantedRaw: unknown): string {
  const wanted = cleanColor(wantedRaw);
  const used = new Set([...room.players.values()].map((p) => p.color));
  if (wanted && !used.has(wanted)) return wanted;
  const free = PLAYER_COLORS.filter((c) => !used.has(c));
  const pool = free.length ? free : PLAYER_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

export interface SocketMeta {
  room: Room | null;
  playerId: number | null;
}

export function joinRoom(room: Room, ws: WebSocket, meta: SocketMeta, nick: unknown, color: unknown, hat: unknown): { err?: string; code?: string } {
  if (room.sim.phase !== "lobby") return { err: "Esa partida ya empezó.", code: "started" };
  const id = freeSlot(room);
  if (id === null) return { err: "La sala está llena (8 jugadores).", code: "full" };
  const player: RoomPlayer = {
    id, name: cleanNick(nick), color: pickColor(room, color), hat: cleanHat(hat), ws, connected: true,
    token: crypto.randomUUID(), goneSince: null, queue: [], ack: 0, held: 0,
  };
  room.players.set(id, player);
  room.sim.addPlayer(id);
  if (room.ownerId === null) room.ownerId = id;
  room.emptySince = null;
  meta.room = room;
  meta.playerId = id;
  send(ws, { t: "joined", code: room.code, id, owner: room.ownerId, token: player.token });
  pushLobby(room);
  return {};
}

export function rejoinRoom(room: Room, ws: WebSocket, meta: SocketMeta, token: string, detach: (old: WebSocket) => void): boolean {
  const player = [...room.players.values()].find((p) => p.token && p.token === token);
  if (!player) return false;
  if (player.ws && player.ws !== ws) {
    detach(player.ws);
    try { player.ws.terminate(); } catch { /* ya estaba muerto */ }
  }
  player.ws = ws;
  player.connected = true;
  player.goneSince = null;
  player.queue.length = 0;
  player.held = 0;
  meta.room = room;
  meta.playerId = player.id;
  room.sim.clearInputs(player.id);
  room.emptySince = null;
  send(ws, { t: "joined", code: room.code, id: player.id, owner: room.ownerId, token: player.token, resumed: true });
  room.lastMapKey = null; // que el próximo snapshot traiga el mapa
  pushLobby(room);
  if (room.sim.phase !== "lobby" && room.sim.phase !== "final") startLoop(room);
  if (room.sim.phase === "final") send(ws, buildSnapshot(room, true));
  return true;
}

function connectedCount(room: Room) {
  let n = 0;
  for (const p of room.players.values()) if (p.connected) n++;
  return n;
}

function reassignOwner(room: Room) {
  room.ownerId = null;
  for (const p of room.players.values()) if (p.connected) { room.ownerId = p.id; break; }
}

export function leaveRoom(ws: WebSocket, meta: SocketMeta) {
  const room = meta.room;
  if (!room || !rooms.has(room.code) || meta.playerId === null) return;
  const player = room.players.get(meta.playerId);
  if (!player || player.ws !== ws) return;
  if (room.sim.phase === "lobby") {
    room.players.delete(player.id);
    room.sim.removePlayer(player.id);
  } else {
    // en partida el slot se guarda REJOIN_GRACE_MS: si vuelve a tiempo, retoma donde estaba
    player.connected = false;
    player.goneSince = Date.now();
    player.ws = null;
    player.queue.length = 0;
    player.held = 0;
    room.sim.clearInputs(player.id);
  }
  if (room.ownerId === player.id) reassignOwner(room);
  if (connectedCount(room) === 0) { room.emptySince = Date.now(); stopLoop(room); }
  else pushLobby(room);
}

export function sweepRooms() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    let changed = false;
    for (const p of [...room.players.values()]) {
      if (p.connected || !p.goneSince || now - p.goneSince < REJOIN_GRACE_MS) continue;
      room.players.delete(p.id);
      if (room.sim.phase === "lobby") room.sim.removePlayer(p.id);
      else dropBody(room, p.id);
      if (room.ownerId === p.id) reassignOwner(room);
      changed = true;
    }
    if (changed) pushLobby(room);
    if (connectedCount(room) === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) destroyRoom(room);
  }
}

/* ---------------------------------------------------------------- mensajes de sala */
export function handleRoomMessage(room: Room, player: RoomPlayer, msg: { t: string; [k: string]: unknown }) {
  const isOwner = room.ownerId === player.id;
  switch (msg.t) {
    case "in": {
      const frames = msg.f as [number, number][];
      for (const fr of frames) {
        if (fr[0] <= player.ack) continue;
        const last = player.queue[player.queue.length - 1];
        if (last && fr[0] <= last[0]) continue;
        player.queue.push(fr);
      }
      if (player.queue.length > 24) player.queue.splice(0, player.queue.length - 24);
      return;
    }
    case "setMode": {
      if (!isOwner || room.sim.phase !== "lobby") return;
      const next = normalizeMode(msg.mode);
      if (next === room.mode) return;
      room.mode = next;
      pushLobby(room);
      return;
    }
    case "setRounds":
      if (!isOwner || (room.mode !== "rounds" && room.mode !== "wins") || room.sim.phase !== "lobby") return;
      room.rounds = Math.max(1, Math.min(20, Math.round(Number(msg.rounds)) || room.rounds));
      pushLobby(room);
      return;
    case "start":
      if (!isOwner || room.sim.phase !== "lobby") return;
      room.lastMapKey = null;
      for (const p of room.players.values()) { p.queue.length = 0; p.held = 0; }
      room.sim.startMatch(room.rounds, { mode: room.mode });
      broadcast(room, { t: "started" });
      startLoop(room);
      return;
    case "endMatch":
      if (!isOwner || room.mode !== "infinite") return;
      room.sim.forceEndMatch();
      return;
    case "again":
      if (!isOwner) return;
      stopLoop(room);
      room.lastMapKey = null;
      room.events = [];
      room.sim.resetToLobby();
      room.sim.drainEvents();
      for (const p of room.players.values()) room.sim.addPlayer(p.id);
      broadcast(room, { t: "toLobby" });
      pushLobby(room);
      return;
  }
}
