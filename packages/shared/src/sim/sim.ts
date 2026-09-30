import { ATTACKS, MODES_TUNING, PHYS, POWERS, STORY_BALANCE, type AttackDef, type AttackKind } from "../balance";
import { POWER_TYPES, type InputKey, type PowerType } from "../constants";
import { clamp } from "../rng";
import { getBiome } from "../world/biomes";
import { checkHazards, cloneMap, generateMap, makeStartMap } from "../world/generate";
import type { MapDef, Platform, Hazard } from "../world/types";
import { applyMoveInput, collidePlatforms, integrateBody, tickMoveTimers } from "./physics";
import type {
  GameMode, Hill, MatchStats, Orb, Phase, PhaseInfo, Player, RoundsMode, SimEvent, StartOptions, WorldObject,
} from "./types";

export interface SimHooks {
  onPhase?: (info: PhaseInfo) => void;
  onPortalEnter?: () => void;
  onVoidEnter?: () => void;
}

const W = PHYS.W, H = PHYS.H, PW = PHYS.PW, PH = PHYS.PH;
const COLLIDE_HW = PW + 4;
/* Solo se corrige una fracción del solapamiento por frame: caminar contra alguien lo empuja
   suave en vez de arrastrarlo como si fuera parte de tu cuerpo. */
const COLLIDE_PUSH = 0.18;
const WORLD_OBJECT_R = 34;

export function newPlayer(id: number): Player {
  return {
    id,
    x: 100 + Math.random() * (W - 200), y: -40, vx: 0, vy: 0, kbx: 0,
    grounded: false, facing: 1, hp: 100, alive: true,
    attack: null, attackCooldown: 0,
    input: { left: false, right: false },
    jumpEdge: false, punchEdge: false, kickEdge: false,
    walkCycle: 0, idleT: Math.random() * 10, squash: 0,
    hitStunT: 0, hitDir: 1, jumpAnticT: 0, deathFadeT: 0,
    power: null, burnT: 0, burnTickT: 0, burnFlashT: 0, slowT: 0,
    jumpsLeft: PHYS.MAX_JUMPS, jumpBufT: 0, hillMs: 0, orbMs: 0,
    isBot: false, isHero: false,
  };
}

/**
 * Simulación autoritativa. Una instancia = una partida: el servidor crea una por sala y los modos
 * locales una por sesión (en V1 era un singleton de globals y el servidor tenía que evaluarla en
 * un contexto `vm` por sala para aislarlas).
 */
export class Sim {
  readonly W = W;
  readonly H = H;
  readonly attacks: Record<AttackKind, AttackDef> = {
    punch: { ...ATTACKS.punch },
    kick: { ...ATTACKS.kick },
  };

  phase: Phase = "lobby";
  currentMap: MapDef = makeStartMap(W, H);
  currentRound = 0;
  totalRounds = 3;
  roster: number[] = [];
  scores: Record<number, number> = {};
  matchStats: Record<number, MatchStats> = {};
  players: Record<number, Player> = {};
  eliminationOrder: number[] = [];
  phaseTimer = 0;
  roundsMode: RoundsMode = "fixed";
  winTarget = 3;
  winnerOnlyScoring = true;
  gameMode: GameMode = "normal";
  orb: Orb | null = null;
  orbTimer: number = POWERS.ORB_SPAWN_MS;
  hill: Hill | null = null;
  hillTimer = 0;
  hillLastPlatformIdx = -1;
  orbkingTimer = 0;
  noOrbs = false;
  portal: WorldObject | null = null;
  voidHole: WorldObject | null = null;
  /** Ticks simulados desde que se creó la instancia (lo usa la red como reloj). */
  tick = 0;

  private forcedArchetype: string | null = null;
  private forcedBiome: string | null = null;
  private events: SimEvent[] = [];

  constructor(private hooks: SimHooks = {}) {}

  setHooks(h: SimHooks): void {
    this.hooks = { ...this.hooks, ...h };
  }

  /* ---------------------------------------------------------------- eventos */
  private emit(e: SimEvent): void {
    this.events.push(e);
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }

  /** Devuelve y vacía los eventos acumulados desde la última llamada. */
  drainEvents(): SimEvent[] {
    if (!this.events.length) return EMPTY;
    const out = this.events;
    this.events = [];
    return out;
  }

  /* ---------------------------------------------------------------- jugadores */
  private maxHpFor(p: Player): number {
    return p.isHero ? STORY_BALANCE.HERO_MAX_HP : 100;
  }

  maxHp(id: number): number {
    const p = this.players[id];
    return p ? this.maxHpFor(p) : 100;
  }

  private ensurePlayer(id: number): Player {
    return this.players[id] || (this.players[id] = newPlayer(id));
  }

  addPlayer(id: number): Player {
    return this.ensurePlayer(id);
  }

  removePlayer(id: number): void {
    delete this.players[id];
    this.roster = this.roster.filter((i) => i !== id);
  }

  handleInput(id: number, key: InputKey | string, down: boolean): void {
    const p = this.players[id];
    if (!p) return;
    if (key === "left") p.input.left = down;
    else if (key === "right") p.input.right = down;
    else if (key === "jump" && down) p.jumpEdge = true;
    else if (key === "punch" && down) p.punchEdge = true;
    else if (key === "kick" && down) p.kickEdge = true;
  }

  /** Suelta todo lo que tenga apretado (desconexiones, pads que se caen). */
  clearInputs(id: number): void {
    const p = this.players[id];
    if (!p) return;
    p.input.left = p.input.right = false;
    p.jumpEdge = p.punchEdge = p.kickEdge = false;
  }

  /* ---------------------------------------------------------------- flujo de ronda */
  /* x seguro para caer sobre `plat` sin quedar parado en una púa (las púas siempre van pegadas a
     un borde, así que la franja del otro lado queda libre). */
  private computeSpawnX(plat: Platform, hazards: Hazard[]): number {
    const pad = Math.min(22, plat.w / 3);
    let lo = plat.x + pad, hi = plat.x + plat.w - pad;
    if (hi <= lo) { lo = plat.x + plat.w / 2; hi = lo; }
    const hz = hazards.find((c) => Math.abs(c.y - plat.y) < 2 && c.x >= plat.x - 1 && c.x + c.w <= plat.x + plat.w + 1);
    if (hz) {
      const hzLo = hz.x, hzHi = hz.x + hz.w, safety = PW + 6;
      if (hzLo <= plat.x + 1) lo = Math.max(lo, hzHi + safety);
      else hi = Math.min(hi, hzLo - safety);
      if (hi <= lo) lo = hi = hzLo <= plat.x + 1 ? plat.x + plat.w - pad : plat.x + pad;
    }
    return lo + Math.random() * Math.max(0, hi - lo);
  }

  private resetCombatState(p: Player): void {
    p.vx = 0; p.vy = 0; p.kbx = 0; p.hp = this.maxHpFor(p);
    p.attack = null; p.attackCooldown = 0;
    p.power = null; p.burnT = 0; p.burnTickT = 0; p.burnFlashT = 0; p.slowT = 0;
    p.jumpsLeft = PHYS.MAX_JUMPS; p.jumpBufT = 0;
  }

  private spawnRoundPlayers(map: MapDef): void {
    const plats = map.platforms;
    this.roster.forEach((id, i) => {
      const p = this.ensurePlayer(id);
      const plat = plats[i % plats.length];
      p.x = this.computeSpawnX(plat, map.hazards);
      p.y = -20 - i * 50;
      this.resetCombatState(p);
      p.alive = true;
      p.hitStunT = 0;
      p.deathFadeT = 0;
    });
    this.orb = null;
    this.orbTimer = POWERS.ORB_SPAWN_MS;
  }

  private noElimination(): boolean {
    return this.gameMode === "koth" || this.gameMode === "orbking";
  }

  private genMap(seed: number): MapDef {
    return generateMap(seed, PHYS, this.forcedArchetype, this.forcedBiome);
  }

  private nextRound(): void {
    this.currentRound++;
    if (this.roundsMode === "fixed" && this.currentRound > this.totalRounds) { this.endMatch(); return; }
    if (this.roundsMode === "wins" && this.roster.some((id) => (this.scores[id] || 0) >= this.winTarget)) {
      this.endMatch();
      return;
    }
    /* Ronda 1 (y cada 5 en infinito) vuelve al mapa inicial. Con archetype forzado (Historia) o en
       Colina/Orbe (una sola ronda larga) no: ahí toca un mapa procedural. */
    const useStartMap = !this.forcedArchetype && !this.noElimination() &&
      (this.currentRound === 1 || (this.roundsMode === "infinite" && this.currentRound % 5 === 0));
    if (useStartMap) {
      const biome = (this.forcedBiome as MapDef["biome"]) || "ruinas";
      this.currentMap = makeStartMap(W, H, biome, this.forcedBiome ? getBiome(biome).name : undefined);
    } else {
      this.currentMap = this.genMap(1000 + this.currentRound * 37 + Math.floor(Math.random() * 900));
    }
    this.eliminationOrder = [];
    this.spawnRoundPlayers(this.currentMap);
    this.phase = "fightIntro";
    this.phaseTimer = 1100;
    const info = {
      t: "roundStart" as const,
      round: this.currentRound,
      totalRounds: this.totalRounds,
      mapName: this.currentMap.name,
      infinite: this.roundsMode === "infinite",
    };
    this.emit({
      k: "round", round: info.round, total: Number.isFinite(info.totalRounds) ? info.totalRounds : null,
      map: info.mapName, biome: this.currentMap.biome, inf: info.infinite,
    });
    this.hooks.onPhase?.(info);
  }

  forceEndMatch(): void {
    if (this.phase === "lobby" || this.phase === "final") return;
    this.endMatch();
  }

  private respawnPlayer(p: Player): void {
    const plats = this.currentMap.platforms;
    const plat = plats[Math.floor(Math.random() * plats.length)];
    p.x = this.computeSpawnX(plat, this.currentMap.hazards);
    p.y = -20 - Math.random() * 60;
    this.resetCombatState(p);
    p.hitStunT = 0;
    p.deathFadeT = 0;
    this.emit({ k: "respawn", id: p.id });
  }

  private eliminate(p: Player): void {
    if (!p.alive) return;
    if (this.matchStats[p.id]) this.matchStats[p.id].falls++;
    this.emit({ k: "ko", id: p.id, x: p.x, y: Math.min(p.y, H + 20) - 24 });

    // Colina/Orbe: nadie queda afuera, caerse o llegar a 0 solo te hace reaparecer.
    if (this.noElimination()) { this.respawnPlayer(p); return; }

    p.alive = false;
    p.deathFadeT = 420;
    this.eliminationOrder.push(p.id);
    const aliveN = this.roster.filter((id) => this.players[id]?.alive).length;
    if (aliveN === 2) this.emit({ k: "clutch" });
    this.checkRoundEnd();
  }

  private checkRoundEnd(): void {
    if (this.phase !== "fight") return;
    const alive = this.roster.filter((id) => this.players[id]?.alive);
    if (alive.length > 1) return;
    if (alive.length === 1) this.eliminationOrder.push(alive[0]);
    if (this.winnerOnlyScoring) {
      const winnerId = this.eliminationOrder[this.eliminationOrder.length - 1];
      if (winnerId !== undefined) this.scores[winnerId] = (this.scores[winnerId] || 0) + 1;
    } else {
      this.eliminationOrder.forEach((id, idx) => { this.scores[id] = (this.scores[id] || 0) + idx + 1; });
    }
    this.phase = "roundEnd";
    this.phaseTimer = 2600;
    this.orb = null;
  }

  private endMatch(): void {
    this.phase = "final";
    const ranked = this.roster.slice().sort((a, b) => (this.scores[b] || 0) - (this.scores[a] || 0));
    const winner = ranked[0];
    this.emit({ k: "final", ranked, winner: winner === undefined ? null : winner });
    this.hooks.onPhase?.({ t: "final", ranked, winner });
  }

  /* ---------------------------------------------------------------- rey de la colina */
  private pickHillSpot(): Hill | null {
    const plats = this.currentMap.platforms;
    if (!plats.length) return null;
    let idx = Math.floor(Math.random() * plats.length);
    if (plats.length > 1 && idx === this.hillLastPlatformIdx) idx = (idx + 1) % plats.length;
    this.hillLastPlatformIdx = idx;
    const pl = plats[idx];
    return { x: pl.x + pl.w / 2, y: pl.y - 30, r: MODES_TUNING.HILL_RADIUS };
  }

  private updateHill(dt: number): void {
    if (this.phase !== "fight") return;
    this.hillTimer -= dt;
    if (this.hillTimer <= 0) { this.hill = this.pickHillSpot(); this.hillTimer = MODES_TUNING.HILL_ACTIVE_MS; }
    const hill = this.hill;
    if (!hill) return;
    for (const id of this.roster) {
      const p = this.players[id];
      if (!p || !p.alive) continue;
      const dx = p.x - hill.x, dy = p.y - 20 - hill.y;
      if (dx * dx + dy * dy > hill.r * hill.r) continue;
      p.hillMs += dt;
      const target = MODES_TUNING.HILL_TARGET_SCORE;
      const newScore = Math.min(target, Math.floor(p.hillMs * (target / MODES_TUNING.HILL_TARGET_MS)));
      if (newScore > (this.scores[p.id] || 0)) this.scores[p.id] = newScore;
      if (this.scores[p.id] >= target) { this.endMatch(); return; }
    }
  }

  /* ---------------------------------------------------------------- orbes de poder */
  private spawnOrb(): void {
    const plats = this.currentMap.platforms;
    const pl = plats[Math.floor(Math.random() * plats.length)];
    const pad = Math.min(24, pl.w / 3);
    const lo = pl.x + pad, hi = pl.x + pl.w - pad;
    const x = hi > lo ? lo + Math.random() * (hi - lo) : pl.x + pl.w / 2;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    this.orb = { type, x, y: pl.y - 30, bornT: 0 };
  }

  /** Modo Historia (sala secreta): los 4 poderes a la vez, con la duración de un orbe normal. */
  grantAllPowers(id: number): void {
    const p = this.players[id];
    if (p) p.power = { fuego: true, hielo: true, tierra: true, aire: true, t: POWERS.ORB_POWER_MS };
  }

  private updateOrbs(dt: number): void {
    if (this.phase !== "fight" || this.noOrbs) return;
    this.orbTimer -= dt;
    if (this.orbTimer <= 0) { this.spawnOrb(); this.orbTimer = POWERS.ORB_SPAWN_MS; }
    const orb = this.orb;
    if (!orb) return;
    orb.bornT += dt;
    for (const id of this.roster) {
      const p = this.players[id];
      if (!p || !p.alive) continue;
      const dx = p.x - orb.x, dy = p.y - 20 - orb.y;
      if (dx * dx + dy * dy < POWERS.ORB_PICKUP_R * POWERS.ORB_PICKUP_R) {
        p.power = { t: POWERS.ORB_POWER_MS, [orb.type]: true };
        this.emit({ k: "pickup", id: p.id, p: orb.type, x: orb.x, y: orb.y });
        this.orb = null;
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- portal / agujero (Historia) */
  private pickWorldObjectSpot(): { x: number; y: number } {
    const plats = this.currentMap.platforms;
    const pl = plats[Math.floor(Math.random() * plats.length)];
    const pad = Math.min(30, pl.w / 3);
    const lo = pl.x + pad, hi = pl.x + pl.w - pad;
    return { x: hi > lo ? lo + Math.random() * (hi - lo) : pl.x + pl.w / 2, y: pl.y - 36 };
  }

  spawnPortal(color?: string, opts?: { boss?: boolean }): void {
    const s = this.pickWorldObjectSpot();
    this.portal = { x: s.x, y: s.y, color: color || "#35f0e0", bornT: 0, boss: !!opts?.boss };
  }

  spawnVoidHole(): void {
    const s = this.pickWorldObjectSpot();
    this.voidHole = { x: s.x, y: s.y, bornT: 0 };
  }

  clearWorldObjects(): void {
    this.portal = null;
    this.voidHole = null;
  }

  private worldObjectOverlap(obj: WorldObject | null): boolean {
    if (!obj) return false;
    for (const id of this.roster) {
      const p = this.players[id];
      if (!p || !p.alive || p.isBot) continue;
      const dx = p.x - obj.x, dy = p.y - 20 - obj.y;
      if (dx * dx + dy * dy < WORLD_OBJECT_R * WORLD_OBJECT_R) return true;
    }
    return false;
  }

  private updateWorldObjects(dt: number): void {
    if (this.portal) {
      this.portal.bornT += dt;
      if (this.worldObjectOverlap(this.portal)) { this.portal = null; this.hooks.onPortalEnter?.(); }
    }
    if (this.voidHole) {
      this.voidHole.bornT += dt;
      if (this.worldObjectOverlap(this.voidHole)) { this.voidHole = null; this.hooks.onVoidEnter?.(); }
    }
  }

  /* ---------------------------------------------------------------- rey del orbe */
  private updateOrbHold(dt: number): void {
    if (this.phase !== "fight") return;
    this.orbkingTimer -= dt;
    for (const id of this.roster) {
      const p = this.players[id];
      if (!p || !p.alive || !p.power) continue;
      p.orbMs += dt;
      this.scores[p.id] = Math.floor(p.orbMs / 1000);
    }
    if (this.orbkingTimer <= 0) this.endMatch();
  }

  /* ---------------------------------------------------------------- colisión entre jugadores */
  private resolvePlayerCollisions(ids: number[]): void {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < ids.length; i++) {
        const a = this.players[ids[i]];
        if (!a || !a.alive) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const b = this.players[ids[j]];
          if (!b || !b.alive) continue;
          let dx = b.x - a.x;
          const dy = b.y - a.y;
          const xOverlap = COLLIDE_HW * 2 - Math.abs(dx);
          const yOverlap = PH - Math.abs(dy);
          if (xOverlap <= 0 || yOverlap <= 0) continue;
          if (dx === 0) dx = ids[i] < ids[j] ? -0.01 : 0.01;
          const dir = dx > 0 ? 1 : -1;
          const half = (xOverlap / 2) * COLLIDE_PUSH;
          a.x = clamp(a.x - dir * half, 14, W - 14);
          b.x = clamp(b.x + dir * half, 14, W - 14);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- física + combate */
  private stepPlayer(p: Player, dt: number, damageEnabled: boolean): void {
    if (!p.alive) {
      if (p.deathFadeT > 0) p.deathFadeT = Math.max(0, p.deathFadeT - dt);
      return;
    }
    const dtScale = dt / (1000 / 60);

    const jump = applyMoveInput(p);
    if (jump.jumped) {
      p.jumpAnticT = 90;
      this.emit({ k: "jump", id: p.id, x: p.x, y: p.y, dbl: jump.dbl });
    }

    if ((p.punchEdge || p.kickEdge) && p.attackCooldown <= 0) {
      const type: AttackKind = p.kickEdge ? "kick" : "punch";
      const def = this.attacks[type];
      p.attack = { type, t: def.dur, dur: def.dur, hitSet: {} };
      let cdMult = p.power && p.power.aire ? PHYS.AIR_COOLDOWN_MULT : 1;
      if (p.isBot) cdMult *= STORY_BALANCE.NPC_ATTACK_COOLDOWN_MULT;
      p.attackCooldown = def.cooldown * cdMult;
      const st = this.matchStats[p.id];
      if (st) st[type === "kick" ? "kicks" : "punches"]++;
      this.emit({ k: "swing", id: p.id, a: type });
    }
    p.punchEdge = false;
    p.kickEdge = false;

    const prevFeet = p.y;
    const wasGrounded = p.grounded;
    integrateBody(p, dtScale);

    if (p.vx !== 0 && wasGrounded) p.walkCycle = ((p.walkCycle || 0) + dt * 0.0034) % 1;
    p.idleT += dt * 0.001;
    if (p.squash > 0) p.squash = Math.max(0, p.squash - dt * 0.006);
    if (p.jumpAnticT > 0) p.jumpAnticT = Math.max(0, p.jumpAnticT - dt);
    if (p.deathFadeT > 0) p.deathFadeT = Math.max(0, p.deathFadeT - dt);
    if (p.burnFlashT > 0) p.burnFlashT = Math.max(0, p.burnFlashT - dt);
    tickMoveTimers(p, dt);

    if (damageEnabled && p.burnT > 0) {
      p.burnT -= dt;
      p.burnTickT -= dt;
      if (p.burnTickT <= 0) {
        p.hp -= POWERS.BURN_DMG;
        p.burnTickT = POWERS.BURN_TICK_MS;
        p.burnFlashT = 220;
        this.emit({ k: "burn", id: p.id, x: p.x, y: p.y - 26 });
        if (p.hp <= 0) this.eliminate(p);
      }
    }

    const landedV = collidePlatforms(p, prevFeet, wasGrounded, this.currentMap.platforms);
    if (landedV > 5) {
      p.squash = Math.min(1, landedV / 14);
      this.emit({ k: "land", id: p.id, x: p.x, y: p.y, s: clamp(landedV / 14, 0, 1) });
    }

    if (p.y > H + 60) {
      if (this.phase === "lobby") { p.x = 100 + Math.random() * (W - 200); p.y = -40; p.vy = 0; p.vx = 0; }
      else if (damageEnabled) this.eliminate(p);
      // Fuera de "fight" el daño está apagado; sin esto quedaría en caída libre para siempre.
      else if (p.alive) this.respawnPlayer(p);
    }

    if (damageEnabled && p.alive && checkHazards(p, this.currentMap, PW)) this.eliminate(p);

    if (p.attack) {
      p.attack.t -= dt;
      if (damageEnabled) this.resolveAttack(p);
      if (p.attack && p.attack.t <= 0) p.attack = null;
    }
    if (p.attackCooldown > 0) p.attackCooldown -= dt;
  }

  private resolveAttack(p: Player): void {
    const attack = p.attack!;
    const atk = this.attacks[attack.type];
    for (const oid of this.roster) {
      if (oid === p.id) continue;
      const o = this.players[oid];
      if (!o || !o.alive || attack.hitSet[oid]) continue;
      if (p.isBot && o.isBot) continue;
      const dx = o.x - p.x;
      const facingOk = p.facing > 0 ? dx > -6 && dx < atk.reach : dx < 6 && dx > -atk.reach;
      if (!facingOk || Math.abs(o.y - p.y - 10) >= 60) continue;

      attack.hitSet[oid] = true;
      let dmg = atk.damage;
      if (p.isBot) dmg *= STORY_BALANCE.NPC_DAMAGE_MULT;
      else if (p.isHero) dmg *= STORY_BALANCE.HERO_DAMAGE_MULT;
      if (o.power && o.power.tierra) dmg = Math.round(dmg * POWERS.ARMOR_MULT);
      dmg = Math.round(dmg);
      o.hp -= dmg;
      if (this.matchStats[p.id]) this.matchStats[p.id].hitsLanded++;
      if (this.matchStats[oid]) this.matchStats[oid].hitsTaken++;
      if (p.power && p.power.fuego) { o.burnT = POWERS.BURN_MS; o.burnTickT = POWERS.BURN_TICK_MS; o.burnFlashT = 220; }
      if (p.power && p.power.hielo) o.slowT = POWERS.SLOW_MS;
      o.kbx = (o.kbx || 0) + p.facing * atk.kbX;
      o.vy += atk.kbY;
      if (atk.kbY < 0) o.grounded = false;
      o.squash = Math.max(o.squash || 0, atk.squash);
      p.squash = Math.max(p.squash || 0, 0.2);
      o.hitStunT = atk.hitStun;
      o.hitDir = p.facing;
      const ko = o.hp <= 0;
      this.emit({ k: "hit", id: p.id, t: oid, a: attack.type, x: o.x, y: o.y - 14, dir: p.facing, dmg, ko });
      if (ko) this.eliminate(o);
    }
  }

  /* ================================================================== API pública */
  /**
   * Arranca una partida con los jugadores ya agregados. `rounds` es la cantidad de rondas en
   * "rounds" y el objetivo de victorias en "wins"; Colina y Orbe son una sola ronda larga.
   */
  startMatch(rounds: number, opts: StartOptions = {}): void {
    this.gameMode = opts.mode === "koth" ? "koth" : opts.mode === "orbking" ? "orbking" : "normal";
    this.roundsMode = opts.mode === "infinite" ? "infinite" : opts.mode === "wins" ? "wins" : "fixed";
    this.totalRounds = this.noElimination() ? 1 : this.roundsMode === "fixed" ? clamp(rounds || 3, 1, 20) : Infinity;
    this.winTarget = clamp(rounds || 3, 1, 20);
    this.winnerOnlyScoring = true;
    this.noOrbs = !!opts.noOrbs;
    this.forcedArchetype = opts.mapArchetype || (this.gameMode === "koth" ? "colina" : null);
    this.forcedBiome = opts.biome || null;
    this.roster = Object.keys(this.players).map(Number);
    this.scores = {};
    this.matchStats = {};
    for (const id of this.roster) {
      this.scores[id] = 0;
      this.matchStats[id] = { kicks: 0, punches: 0, falls: 0, hitsLanded: 0, hitsTaken: 0 };
      const p = this.players[id];
      p.hillMs = 0;
      p.orbMs = 0;
    }
    this.hill = null;
    this.hillTimer = 0;
    this.hillLastPlatformIdx = -1;
    this.orbkingTimer = 0;
    this.clearWorldObjects();
    this.currentRound = 0;
    this.nextRound();
  }

  resetToLobby(): void {
    this.phase = "lobby";
    this.roundsMode = "fixed";
    this.gameMode = "normal";
    this.forcedArchetype = null;
    this.forcedBiome = null;
    this.players = {};
    this.roster = [];
    this.scores = {};
    this.currentRound = 0;
    this.currentMap = makeStartMap(W, H);
    this.orb = null;
    this.orbTimer = POWERS.ORB_SPAWN_MS;
    this.noOrbs = false;
    this.hill = null;
    this.hillTimer = 0;
    this.hillLastPlatformIdx = -1;
    this.orbkingTimer = 0;
    this.clearWorldObjects();
    this.emit({ k: "lobby" });
  }

  /**
   * Un tick de simulación. `sub` (solo lo usa el servidor online) permite avanzar a cada jugador
   * una cantidad distinta de pasos físicos este tick — 0 si todavía no llegó su input, 2 si se
   * atrasó — llamando `beforeStep` antes de cada paso para aplicar el frame de input que
   * corresponde. Así el cuerpo de cada jugador avanza exactamente un paso por frame de input, que
   * es lo que el cliente predice.
   */
  step(dt: number, sub?: { steps(id: number): number; beforeStep(id: number, i: number): void }): void {
    this.tick++;
    const damageEnabled = this.phase === "fight";
    const ids = this.phase === "lobby" ? Object.keys(this.players).map(Number) : this.roster;
    for (const id of ids) {
      const p = this.players[id];
      if (!p) continue;
      const n = sub ? sub.steps(id) : 1;
      if (n === 0 && !p.alive && p.deathFadeT > 0) p.deathFadeT = Math.max(0, p.deathFadeT - dt);
      for (let i = 0; i < n; i++) {
        sub?.beforeStep(id, i);
        this.stepPlayer(p, dt, damageEnabled);
      }
    }
    this.resolvePlayerCollisions(ids);
    this.updateOrbs(dt);
    this.updateWorldObjects(dt);
    if (this.gameMode === "koth") this.updateHill(dt);
    else if (this.gameMode === "orbking") this.updateOrbHold(dt);

    if (this.phase === "fightIntro") {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.phase = "fight";
        this.orbTimer = POWERS.ORB_SPAWN_MS;
        if (this.gameMode === "koth") { this.hill = null; this.hillTimer = MODES_TUNING.HILL_APPEAR_DELAY_MS; }
        else if (this.gameMode === "orbking") this.orbkingTimer = MODES_TUNING.ORBKING_MATCH_MS;
        this.emit({ k: "fight" });
        this.hooks.onPhase?.({ t: "fight" });
      }
    } else if (this.phase === "roundEnd") {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.nextRound();
    }
  }

  /** Ids que se dibujan/simulan en la fase actual. */
  activeIds(): number[] {
    return this.phase === "lobby" ? Object.keys(this.players).map(Number) : this.roster;
  }

  cloneMap(): MapDef {
    return cloneMap(this.currentMap);
  }
}

const EMPTY: SimEvent[] = [];

export function powerList(power: Player["power"]): PowerType[] {
  if (!power) return [];
  return POWER_TYPES.filter((k) => power[k]);
}
