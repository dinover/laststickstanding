/* Salas de mandos: los celulares como control del modo Local. No simulan nada: son un cable entre
   la pantalla (que corre la sim) y hasta 8 teléfonos. Mismo diseño que V1, ahora en binario. */

import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { cleanNick, type ClientMsg } from "@lss/shared";
import { freeCode, send } from "./util";

const PAD_MAX = 8;
const PAD_GRACE_MS = 120000;
const PAD_HOST_GRACE_MS = 60000;

interface Pad { id: number; name: string; ws: WebSocket | null; token: string; connected: boolean; goneSince: number | null }
export interface PadRoom { code: string; ws: WebSocket | null; token: string; hostGoneSince: number | null; pads: Map<number, Pad> }
export interface PadMeta { padRoom: PadRoom | null; padId: number | null; padHost: boolean }

export const padRooms = new Map<string, PadRoom>();

function detach(meta: PadMeta) { meta.padRoom = null; meta.padId = null; meta.padHost = false; }

export function destroyPadRoom(room: PadRoom, metaOf: (ws: WebSocket) => PadMeta | undefined) {
  for (const pad of room.pads.values()) {
    if (pad.ws) { send(pad.ws, { t: "padClosed" }); const m = metaOf(pad.ws); if (m) detach(m); }
  }
  if (room.ws) { const m = metaOf(room.ws); if (m) detach(m); }
  padRooms.delete(room.code);
}

function padList(room: PadRoom) {
  return [...room.pads.values()].map((p) => ({ pad: p.id, name: p.name, connected: p.connected }));
}

export function padLeave(ws: WebSocket, meta: PadMeta) {
  const room = meta.padRoom;
  if (!room || !padRooms.has(room.code)) { detach(meta); return; }
  if (meta.padHost) {
    room.ws = null;
    room.hostGoneSince = Date.now();
    for (const pad of room.pads.values()) send(pad.ws, { t: "padHostGone" });
    detach(meta);
    return;
  }
  const pad = meta.padId !== null ? room.pads.get(meta.padId) : undefined;
  if (pad && pad.ws === ws) {
    pad.connected = false;
    pad.goneSince = Date.now();
    pad.ws = null;
    send(room.ws, { t: "padLeave", pad: pad.id });
  }
  detach(meta);
}

export function sweepPadRooms(metaOf: (ws: WebSocket) => PadMeta | undefined) {
  const now = Date.now();
  for (const room of [...padRooms.values()]) {
    if (!room.ws && room.hostGoneSince && now - room.hostGoneSince > PAD_HOST_GRACE_MS) { destroyPadRoom(room, metaOf); continue; }
    for (const pad of [...room.pads.values()]) {
      if (pad.connected || !pad.goneSince || now - pad.goneSince < PAD_GRACE_MS) continue;
      room.pads.delete(pad.id);
      send(room.ws, { t: "padGone", pad: pad.id });
    }
  }
}

/** Devuelve true si el mensaje era de una sala de mandos (y ya se atendió). */
export function handlePadMessage(ws: WebSocket, meta: PadMeta, inGameRoom: boolean, msg: ClientMsg, isTaken: (c: string) => boolean, metaOf: (ws: WebSocket) => PadMeta | undefined): boolean {
  switch (msg.t) {
    case "padCreate": {
      if (meta.padRoom || inGameRoom) return true;
      const token = msg.token || "";
      if (token) {
        for (const room of padRooms.values()) {
          if (room.token !== token) continue;
          if (room.ws && room.ws !== ws) { const m = metaOf(room.ws); if (m) detach(m); try { room.ws.terminate(); } catch { /* */ } }
          room.ws = ws;
          room.hostGoneSince = null;
          meta.padRoom = room;
          meta.padHost = true;
          send(ws, { t: "padCreated", code: room.code, token: room.token, pads: padList(room), resumed: true });
          for (const pad of room.pads.values()) send(pad.ws, { t: "padHostBack" });
          return true;
        }
      }
      const code = freeCode(isTaken);
      if (!code) { send(ws, { t: "err", code: "noCodes", msg: "No hay códigos libres, probá de nuevo." }); return true; }
      const room: PadRoom = { code, ws, token: crypto.randomUUID(), hostGoneSince: null, pads: new Map() };
      padRooms.set(code, room);
      meta.padRoom = room;
      meta.padHost = true;
      send(ws, { t: "padCreated", code, token: room.token, pads: [] });
      return true;
    }
    case "padTo":
    case "padAll":
    case "padKick":
    case "padClose": {
      const room = meta.padRoom;
      if (!room || !meta.padHost || !padRooms.has(room.code)) return true;
      if (msg.t === "padClose") { destroyPadRoom(room, metaOf); return true; }
      if (msg.t === "padAll") { for (const pad of room.pads.values()) send(pad.ws, { t: "padMsg", data: msg.data }); return true; }
      const pad = room.pads.get(msg.pad);
      if (!pad) return true;
      if (msg.t === "padTo") { send(pad.ws, { t: "padMsg", data: msg.data }); return true; }
      send(pad.ws, { t: "padKicked", reason: msg.reason || null });
      if (pad.ws) { const m = metaOf(pad.ws); if (m) detach(m); }
      room.pads.delete(pad.id);
      return true;
    }
    case "padJoin": {
      if (inGameRoom || meta.padHost) return true;
      const room = padRooms.get(String(msg.code || "").toUpperCase().trim());
      if (!room) { send(ws, { t: "padErr", code: "noRoom" }); return true; }
      if (meta.padRoom && meta.padRoom !== room) padLeave(ws, meta);
      const name = cleanNick(msg.nick);
      const token = msg.token || "";
      let pad = token ? [...room.pads.values()].find((p) => p.token === token) : undefined;
      if (pad) {
        if (pad.ws && pad.ws !== ws) { const m = metaOf(pad.ws); if (m) detach(m); try { pad.ws.terminate(); } catch { /* */ } }
        pad.ws = ws; pad.connected = true; pad.goneSince = null; pad.name = name;
      } else {
        let id: number | null = null;
        for (let i = 0; i < PAD_MAX; i++) if (!room.pads.has(i)) { id = i; break; }
        if (id === null) { send(ws, { t: "padErr", code: "full" }); return true; }
        pad = { id, name, ws, token: crypto.randomUUID(), connected: true, goneSince: null };
        room.pads.set(id, pad);
      }
      meta.padRoom = room;
      meta.padId = pad.id;
      meta.padHost = false;
      send(ws, { t: "padJoined", code: room.code, pad: pad.id, token: pad.token, name: pad.name });
      send(room.ws, { t: "padJoin", pad: pad.id, name: pad.name, resumed: !!token });
      return true;
    }
    case "padInput":
    case "padMsg": {
      const room = meta.padRoom;
      if (!room || meta.padHost || meta.padId === null || !padRooms.has(room.code)) return true;
      if (msg.t === "padInput") send(room.ws, { t: "padInput", pad: meta.padId, k: msg.k, d: msg.d });
      else send(room.ws, { t: "padMsg", pad: meta.padId, data: msg.data });
      return true;
    }
  }
  return false;
}
