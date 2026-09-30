/* Conexión de juego online: crear/unirse a una sala, lobby, reconexión al mismo slot con token y
   medición de ping. La partida en sí (snapshots, predicción) la maneja OnlineSession. */

import { writable, get } from "svelte/store";
import type { ClientMsg, LobbyPlayer, ServerMsg } from "@lss/shared";
import { GameSocket } from "./socket";

export interface RoomState {
  code: string | null;
  myId: number | null;
  owner: number | null;
  mode: string;
  rounds: number;
  phase: string;
  players: LobbyPlayer[];
}

export const room = writable<RoomState>({ code: null, myId: null, owner: null, mode: "rounds", rounds: 3, phase: "lobby", players: [] });
export const ping = writable<number | null>(null);

const SESSION_KEY = "lss-session";

type Listener = (msg: ServerMsg) => void;

class NetClient {
  private sock = new GameSocket(12);
  private token: string | null = null;
  private listeners = new Set<Listener>();
  private pingTimer: number | null = null;
  onReconnecting: (attempt: number, max: number) => void = () => {};
  onGaveUp: () => void = () => {};
  onClose: () => void = () => {};

  constructor() {
    this.sock.shouldReconnect = () => !!this.token;
    this.sock.onOpen = () => {
      const sess = this.savedSession();
      if (sess && sess.token) this.sock.send({ t: "rejoin", code: sess.code, token: sess.token });
      this.sendPing();
      if (!this.pingTimer) this.pingTimer = window.setInterval(() => this.sendPing(), 1000);
    };
    this.sock.onClose = () => {
      ping.set(null);
      this.onClose();
    };
    this.sock.onStatus = (s, attempt, max) => {
      if (s === "reconnecting" && this.token) this.onReconnecting(attempt || 0, max || 12);
      if (s === "failed" && this.token) this.onGaveUp();
    };
    this.sock.onMessage = (msg, at) => this.handle(msg, at);
  }

  private sendPing() {
    if (this.sock.isOpen) this.sock.send({ t: "ping", ts: performance.now() });
  }

  private pings: number[] = [];

  private handle(msg: ServerMsg, at = performance.now()) {
    switch (msg.t) {
      case "pong": {
        /* ida y vuelta, mostrando la mediana de los últimos 5: un cuadro lento o un pico aislado no
           dispara el número. */
        this.pings.push(Math.max(0, at - msg.ts));
        if (this.pings.length > 5) this.pings.shift();
        const sorted = this.pings.slice().sort((a, b) => a - b);
        ping.set(Math.round(sorted[Math.floor(sorted.length / 2)]));
        return;
      }
      case "joined":
        room.update((r) => ({ ...r, code: msg.code, myId: msg.id, owner: msg.owner }));
        if (msg.token) { this.token = msg.token; this.saveSession(msg.code, msg.token); }
        break;
      case "lobby":
        room.update((r) => ({ ...r, code: msg.code, owner: msg.owner, mode: msg.mode, rounds: msg.rounds, phase: msg.phase, players: msg.players }));
        break;
      case "rejoinFailed":
        this.forget();
        room.set({ code: null, myId: null, owner: null, mode: "rounds", rounds: 3, phase: "lobby", players: [] });
        break;
    }
    for (const l of this.listeners) l(msg);
  }

  listen(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect() { this.sock.connect(); }

  send(msg: ClientMsg) { this.sock.send(msg); }

  create(nick: string, color: string | null, hat: string) {
    this.connect();
    this.sock.send({ t: "create", nick, color, hat });
  }

  join(code: string, nick: string, color: string | null, hat: string) {
    this.connect();
    this.sock.send({ t: "join", code: code.toUpperCase().trim(), nick, color, hat });
  }

  leave() {
    this.forget();
    this.sock.send({ t: "leave" });
    room.set({ code: null, myId: null, owner: null, mode: "rounds", rounds: 3, phase: "lobby", players: [] });
  }

  isOwner(): boolean {
    const r = get(room);
    return r.myId !== null && r.myId === r.owner;
  }

  savedSession(): { code: string; token: string } | null {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }

  private saveSession(code: string, token: string) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, token })); } catch { /* */ }
  }

  forget() {
    this.token = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* */ }
  }

  /** Tras un F5: si había sesión, intenta volver al mismo lugar. */
  resumeIfSaved(): boolean {
    const s = this.savedSession();
    if (!s) return false;
    this.token = s.token;
    this.connect();
    return true;
  }

  buffered() { return this.sock.buffered(); }
}

export const net = new NetClient();
