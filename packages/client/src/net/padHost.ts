/* Lado "pantalla" de los celulares-control del modo Local. El Sim corre en esta máquina; los
   teléfonos entran a una sala de mandos del servidor con un código y sus botones llegan acá como
   eventos de input. El servidor es solo un cable. Socket propio (no el de juego), como en V1. */

import type { ServerMsg } from "@lss/shared";
import { GameSocket } from "./socket";

type Handler = (msg: never) => void;
const TOKEN_KEY = "lss-pad-host";

export class PadHost {
  private sock = new GameSocket(20);
  private code: string | null = null;
  private token: string | null = null;
  private handlers: Record<string, (payload: unknown) => void> = {};

  constructor() {
    this.sock.onOpen = () => {
      let saved: string | null = null;
      try { saved = sessionStorage.getItem(TOKEN_KEY); } catch { /* */ }
      this.sock.send({ t: "padCreate", token: this.token || saved || undefined });
    };
    this.sock.onStatus = (s) => {
      if (s === "open") this.emit("status", "ready");
      else if (s === "reconnecting") this.emit("status", "reconnecting");
      else if (s === "failed") this.emit("status", "error");
    };
    this.sock.onMessage = (msg: ServerMsg) => {
      switch (msg.t) {
        case "padCreated":
          this.code = msg.code;
          this.token = msg.token;
          try { sessionStorage.setItem(TOKEN_KEY, msg.token); } catch { /* */ }
          this.emit("created", { code: msg.code, pads: msg.pads || [], resumed: !!msg.resumed });
          break;
        case "padJoin": this.emit("join", msg); break;
        case "padLeave": this.emit("leave", msg); break;
        case "padGone": this.emit("gone", msg); break;
        case "padInput": this.emit("input", msg); break;
        case "padMsg": this.emit("msg", msg); break;
        case "err": this.emit("error", msg); break;
      }
    };
  }

  on(name: "created" | "join" | "leave" | "gone" | "input" | "msg" | "status" | "error", fn: Handler) {
    this.handlers[name] = fn as (p: unknown) => void;
  }

  private emit(name: string, payload: unknown) {
    this.handlers[name]?.(payload);
  }

  open() {
    this.sock.connect();
  }

  close() {
    this.sock.send({ t: "padClose" });
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ }
    this.token = null;
    this.code = null;
    setTimeout(() => this.sock.close(), 50);
  }

  getCode() { return this.code; }
  isOpen() { return !!this.code && this.sock.isOpen; }
  joinUrl() { return location.origin + "/pad" + (this.code ? "?c=" + this.code : ""); }
  sendTo(pad: number, data: unknown) { this.sock.send({ t: "padTo", pad, data }); }
  broadcast(data: unknown) { this.sock.send({ t: "padAll", data }); }
  kick(pad: number, reason?: string) { this.sock.send({ t: "padKick", pad, reason: reason || null }); }
}
