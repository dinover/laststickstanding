import { describe, expect, it } from "vitest";
import {
  BOT_DIFFICULTY, BotAI, PHYS, Sim, TICK_MS, decode, encode, generateMap, makeReachability,
  packPlayer, predictStep, unpackPlayer, ARCHETYPE_IDS, type Player,
} from "../src";

describe("world generation", () => {
  it("every archetype produces a fully connected layout across many seeds", () => {
    const reach = makeReachability(PHYS);
    for (const arch of ARCHETYPE_IDS) {
      for (let seed = 1; seed <= 120; seed++) {
        const map = generateMap(seed * 7919, PHYS, arch);
        expect(map.platforms.length).toBeGreaterThan(1);
        expect(reach.allConnected(map.platforms), `${arch} seed ${seed}`).toBe(true);
        for (const p of map.platforms) {
          expect(p.x).toBeGreaterThanOrEqual(-1);
          expect(p.x + p.w).toBeLessThanOrEqual(PHYS.W + 1);
        }
      }
    }
  });

  it("same seed → same map", () => {
    const a = generateMap(4242, PHYS);
    const b = generateMap(4242, PHYS);
    expect(a).toEqual(b);
  });
});

function runBotsMatch(n: number, mode: "rounds" | "koth" | "orbking" | "wins", maxSeconds: number) {
  const sim = new Sim();
  const bots = new BotAI(sim);
  for (let i = 0; i < n; i++) sim.addPlayer(i);
  sim.startMatch(2, { mode });
  const ticks = (maxSeconds * 1000) / TICK_MS;
  let finals = 0;
  for (let t = 0; t < ticks && sim.phase !== "final"; t++) {
    for (const id of sim.roster) {
      // cada bot persigue al siguiente vivo
      const target = sim.roster.find((o) => o !== id && sim.players[o]?.alive) ?? id;
      bots.tick(id, target, TICK_MS, BOT_DIFFICULTY.hard);
    }
    sim.step(TICK_MS);
    for (const e of sim.drainEvents()) if (e.k === "final") finals++;
  }
  return { sim, finals };
}

describe("simulation", () => {
  it("a 4-bot rounds match reaches the final screen", () => {
    const { sim, finals } = runBotsMatch(4, "rounds", 600);
    expect(sim.phase).toBe("final");
    expect(finals).toBe(1);
    const total = Object.values(sim.scores).reduce((a, b) => a + b, 0);
    expect(total).toBe(2); // 1 punto por ronda ganada, 2 rondas
  });

  it("king of the hill ends when someone reaches 100", () => {
    const { sim } = runBotsMatch(3, "koth", 900);
    expect(sim.phase).toBe("final");
    expect(Math.max(...Object.values(sim.scores))).toBe(100);
  });

  it("orb king ends on the 2 minute clock", () => {
    const { sim } = runBotsMatch(2, "orbking", 200);
    expect(sim.phase).toBe("final");
  });

  it("emits hit/ko events with positions for the client FX", () => {
    const sim = new Sim();
    const bots = new BotAI(sim);
    sim.addPlayer(1); sim.addPlayer(2);
    sim.startMatch(1, { mode: "rounds" });
    const kinds = new Set<string>();
    for (let t = 0; t < 60 * 120 && sim.phase !== "final"; t++) {
      bots.tick(1, 2, TICK_MS, BOT_DIFFICULTY.hard);
      bots.tick(2, 1, TICK_MS, BOT_DIFFICULTY.hard);
      sim.step(TICK_MS);
      for (const e of sim.drainEvents()) kinds.add(e.k);
    }
    for (const k of ["round", "fight", "swing", "hit", "ko", "final"]) expect(kinds.has(k), k).toBe(true);
  });
});

describe("bot AI", () => {
  /* Mapas al azar (la sim usa Math.random): se tolera UNA caída rara en 12 mapas. Límite conocido,
     igual que en V1: el empuje de cuerpos contra el rival cerca de un borde no lo prevé la IA. */
  it("a lone bot almost never falls off the map by itself", () => {
    let totalFalls = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new Sim();
      const bots = new BotAI(sim);
      sim.addPlayer(1); sim.addPlayer(2);
      sim.startMatch(1, { mode: "infinite", mapArchetype: ARCHETYPE_IDS[seed % 8] });
      // el objetivo (2) queda quieto en su plataforma; el bot tiene que llegar sin suicidarse
      let falls = 0;
      for (let t = 0; t < 60 * 20; t++) {
        bots.tick(1, 2, TICK_MS, BOT_DIFFICULTY.medium);
        sim.step(TICK_MS);
        for (const e of sim.drainEvents()) if (e.k === "ko" && e.id === 1) falls++;
      }
      totalFalls += falls;
    }
    expect(totalFalls).toBeLessThanOrEqual(1);
  });
});

describe("netcode helpers", () => {
  it("player tuples round-trip through msgpack", () => {
    const sim = new Sim();
    const p = sim.addPlayer(3);
    p.x = 123.45; p.y = 400; p.vx = -4.3; p.vy = 7.1; p.power = { t: 5000, fuego: true, aire: true };
    p.attack = { type: "kick", t: 120, dur: 280, hitSet: {} };
    const bytes = encode({ t: "s", p: [packPlayer(p, 77)] });
    const back = decode<{ p: number[][] }>(bytes);
    const np = unpackPlayer(back.p[0]);
    expect(np.x).toBeCloseTo(123.5, 0);
    expect(np.power?.fuego).toBe(true);
    expect(np.power?.aire).toBe(true);
    expect(np.power?.hielo).toBeUndefined();
    expect(np.attack?.type).toBe("kick");
    expect(np.ack).toBe(77);
    expect(bytes.byteLength).toBeLessThan(80);
  });

  it("client prediction matches the authoritative sim for pure movement", () => {
    const sim = new Sim();
    sim.addPlayer(1);
    sim.startMatch(1, { mode: "infinite" });
    const p = sim.players[1];
    // clon "predicho"
    const clone = (): Player => JSON.parse(JSON.stringify(p));
    let pred = clone();
    const script = (t: number) => ({ left: t % 90 < 30, right: t % 90 >= 50, jump: t % 45 === 0 });
    for (let t = 0; t < 600; t++) {
      const inp = script(t);
      sim.handleInput(1, "left", inp.left);
      sim.handleInput(1, "right", inp.right);
      if (inp.jump) sim.handleInput(1, "jump", true);
      pred.input.left = inp.left; pred.input.right = inp.right;
      if (inp.jump) pred.jumpEdge = true;
      sim.step(TICK_MS);
      predictStep(pred, TICK_MS, sim.currentMap.platforms);
      if (!p.alive) break;
      // con el mapa inicial nadie cae ni recibe golpes: tienen que coincidir exacto
      expect(pred.x).toBeCloseTo(p.x, 6);
      expect(pred.y).toBeCloseTo(p.y, 6);
    }
  });
});
