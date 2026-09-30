import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";
import { decode, encode, IN_RIGHT, IN_JUMP, unpackPlayer, type ServerMsg, type Snapshot } from "@lss/shared";

const PORT = 18000 + Math.floor(Math.random() * 1000);
let proc: ChildProcess;

function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("timeout")); }
    }, 20);
  });
}

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  open = false;
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.binaryType = "nodebuffer";
    this.ws.on("open", () => { this.open = true; });
    this.ws.on("message", (d) => this.msgs.push(decode<ServerMsg>(d as Buffer)));
  }
  send(m: unknown) { this.ws.send(encode(m)); }
  last<T extends ServerMsg["t"]>(t: T) { return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined; }
  count(t: string) { return this.msgs.filter((m) => m.t === t).length; }
}

beforeAll(async () => {
  const root = path.resolve(__dirname, "..");
  proc = spawn(process.execPath, [path.resolve(root, "../../node_modules/tsx/dist/cli.mjs"), "src/server.ts", "--port", String(PORT)], { cwd: root, stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    proc.stdout!.on("data", (d) => { if (String(d).includes("escuchando")) { clearTimeout(timer); resolve(); } });
    proc.stderr!.on("data", (d) => process.stderr.write(d));
  });
}, 30000);

afterAll(() => { proc?.kill(); });

describe("game server", () => {
  it("serves /health", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    const j = (await r.json()) as { ok: boolean; version: number };
    expect(j.ok).toBe(true);
    expect(j.version).toBe(2);
  });

  it("create → join → start → snapshots with acks and events", async () => {
    const a = new Client(), b = new Client();
    await waitFor(() => a.open && b.open);
    a.send({ t: "create", nick: "Ana", color: "#ff2e88", hat: "crown" });
    await waitFor(() => !!a.last("joined"));
    const code = a.last("joined")!.code;
    b.send({ t: "join", code, nick: "Beto", color: "#ff2e88", hat: "nope" });
    await waitFor(() => !!b.last("joined") && (a.last("lobby")?.players.length ?? 0) === 2);
    const lobby = a.last("lobby")!;
    expect(lobby.players[0].color).toBe("#ff2e88");
    expect(lobby.players[1].color).not.toBe("#ff2e88"); // color único por sala
    expect(lobby.players[1].hat).toBe("none"); // accesorio inválido → none

    // solo el anfitrión cambia el modo
    b.send({ t: "setMode", mode: "koth" });
    a.send({ t: "setMode", mode: "wins" });
    a.send({ t: "setRounds", rounds: 5 });
    await waitFor(() => a.last("lobby")?.mode === "wins" && a.last("lobby")?.rounds === 5);

    a.send({ t: "start" });
    await waitFor(() => a.count("s") > 20 && !!a.last("round"));
    const snap = a.last("s") as Snapshot;
    expect(snap.ro.length).toBe(2);
    expect(a.msgs.some((m) => m.t === "s" && (m as Snapshot).m)).toBe(true); // el mapa viajó al menos una vez
    expect(a.msgs.some((m) => m.t === "s" && (m as Snapshot).e?.some((e) => e.k === "round"))).toBe(true);

    // inputs por tick: el ack avanza y el jugador se mueve
    const myId = a.last("joined")!.id;
    const x0 = unpackPlayer((a.last("s") as Snapshot).p.find((p) => p[0] === myId)!).x;
    let seq = 0;
    for (let i = 0; i < 90; i++) {
      seq++;
      a.send({ t: "in", f: [[seq, IN_RIGHT | (i === 30 ? IN_JUMP : 0)]] });
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 150));
    const me = unpackPlayer((a.last("s") as Snapshot).p.find((p) => p[0] === myId)!);
    expect(me.ack).toBeGreaterThan(60);
    expect(me.x).toBeGreaterThan(x0 + 50);
    const evKinds = () => a.msgs.flatMap((m) => (m.t === "s" ? ((m as Snapshot).e || []).map((e) => e.k + ":" + ("id" in e ? e.id : "")) : []));
    await waitFor(() => evKinds().includes("jump:" + myId), 3000);

    // snapshots chicos
    const bytes = encode(a.last("s")).byteLength;
    expect(bytes).toBeLessThan(700);

    // reconexión al mismo slot con el token
    const token = b.last("joined")!.token;
    b.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const b2 = new Client();
    await waitFor(() => b2.open);
    b2.send({ t: "rejoin", code, token });
    await waitFor(() => !!b2.last("joined"));
    expect(b2.last("joined")!.resumed).toBe(true);
    expect(b2.last("joined")!.id).toBe(b.last("joined")!.id);
    await waitFor(() => b2.msgs.some((m) => m.t === "s" && !!(m as Snapshot).m));

    a.ws.close();
    b2.ws.close();
  }, 30000);

  it("rejects garbage without crashing", async () => {
    const c = new Client();
    await waitFor(() => c.open);
    c.ws.send(Buffer.from([0xff, 0x00, 0x13]));
    c.send({ t: "join", code: 12345 });
    c.send({ t: "in", f: "nope" });
    c.send({ t: "join", code: "ZZZZ", nick: "x" });
    await waitFor(() => !!c.last("err"));
    expect(c.last("err")!.code).toBe("noRoom");
    c.ws.close();
  });

  it("pad relay: host + phone", async () => {
    const host = new Client(), phone = new Client();
    await waitFor(() => host.open && phone.open);
    host.send({ t: "padCreate" });
    await waitFor(() => !!host.last("padCreated"));
    const code = host.last("padCreated")!.code;
    phone.send({ t: "padJoin", code, nick: "Tel" });
    await waitFor(() => !!phone.last("padJoined") && !!host.last("padJoin"));
    phone.send({ t: "padInput", k: "jump", d: true });
    await waitFor(() => !!host.last("padInput"));
    expect(host.last("padInput")!.k).toBe("jump");
    host.send({ t: "padTo", pad: phone.last("padJoined")!.pad, data: { t: "you", name: "Tel", color: "#fff" } });
    await waitFor(() => !!phone.last("padMsg"));
    host.ws.close();
    phone.ws.close();
  });
});
