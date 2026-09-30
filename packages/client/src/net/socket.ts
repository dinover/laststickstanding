/* WebSocket binario (MessagePack) con reconexión con backoff. Lo comparten la conexión de juego
   (net.ts) y la de la sala de mandos (padHost.ts), que son dos sockets independientes como en V1. */

import { decode, encode, type ClientMsg, type ServerMsg } from "@lss/shared";

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "failed";

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/ws";
}

export class GameSocket {
  /** `at`: cuándo se recibió el mensaje (reloj de performance.now). */
  onMessage: (msg: ServerMsg, at: number) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  onStatus: (s: SocketStatus, attempt?: number, max?: number) => void = () => {};
  /** Si es false, un corte no dispara reintentos (el que llama decide). */
  shouldReconnect: () => boolean = () => true;

  private ws: WebSocket | null = null;
  private tries = 0;
  private retryTimer: number | null = null;
  private wanted = false;
  private queue: ClientMsg[] = [];

  constructor(private maxTries = 12) {}

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === 1;
  }

  connect() {
    this.wanted = true;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.onStatus(this.tries ? "reconnecting" : "connecting", this.tries, this.maxTries);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.onStatus("failed");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.onStatus("open");
      this.onOpen();
      const q = this.queue;
      this.queue = [];
      for (const m of q) this.send(m);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") return;
      let msg: ServerMsg;
      try { msg = decode<ServerMsg>(ev.data as ArrayBuffer); } catch { return; }
      if (msg && typeof (msg as { t?: unknown }).t === "string") this.onMessage(msg, performance.now());
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.onClose();
      if (this.wanted && this.shouldReconnect()) this.scheduleRetry();
      else this.onStatus("closed");
    };
    ws.onerror = () => { /* onclose viene después */ };
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    if (this.tries >= this.maxTries) { this.onStatus("failed"); return; }
    const delay = Math.min(4000, 300 * Math.pow(1.6, this.tries));
    this.tries++;
    this.onStatus("reconnecting", this.tries, this.maxTries);
    this.retryTimer = window.setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encode(msg));
    else if (msg.t !== "in" && msg.t !== "ping") this.queue.push(msg);
  }

  close() {
    this.wanted = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.queue = [];
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
    this.tries = 0;
  }

  /** Bytes pendientes de mandar (para no apilar input si la conexión está saturada). */
  buffered(): number {
    return this.ws ? this.ws.bufferedAmount : 0;
  }
}
