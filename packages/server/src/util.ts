import type { WebSocket } from "ws";
import { CODE_CHARS, ROOM_CODE_LEN, encode, type ServerMsg } from "@lss/shared";

export function encodeMsg(msg: ServerMsg): Uint8Array {
  return encode(msg);
}

/** Tolera un ws nulo (jugador o celular ausente que conserva su lugar). */
export function send(ws: WebSocket | null | undefined, msg: ServerMsg) {
  if (ws && ws.readyState === 1) ws.send(encodeMsg(msg));
}

export function broadcastRaw(sockets: (WebSocket | null)[], payload: Uint8Array) {
  for (const ws of sockets) if (ws && ws.readyState === 1) ws.send(payload);
}

function randomCode(): string {
  let s = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/** Código libre en TODOS los espacios (partidas y salas de mandos), para que nunca se confundan. */
export function freeCode(isTaken: (c: string) => boolean): string | null {
  for (let i = 0; i < 60; i++) {
    const c = randomCode();
    if (!isTaken(c)) return c;
  }
  return null;
}
