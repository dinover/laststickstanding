/* Modo Historia (saga): 5 zonas fijas, 3 pantallas normales (1/2/3 NPCs) + jefe por zona, sin
   orbes. Al cruzar cada jefe el jugador se queda con el poder de esa zona, que le pulsa solo
   desde la zona siguiente. Los enemigos pulsan el poder de su zona; el jefe tiene su combo fijo.
   Port de V1 con la misma progresión y guardado. */

import { BOT_DIFFICULTY, STANDARD_ARCHETYPES, getBiome, POWER_TYPES, type BiomeId, type PowerType, type Power } from "@lss/shared";
import { get } from "svelte/store";
import { SoloSession, ME } from "./solo";
import type { Engine } from "../engine";
import { banner, crawl, pulseFight, storyMsg, showToast, type HudState } from "../../app/ui";
import { t } from "../../app/i18n";
import { sagaState, type SagaRun } from "../../app/persist";
import { formatRunTime, submitRun } from "../../services/supabase";
import { audio } from "../../audio/audio";

const ZONES: BiomeId[] = ["ruinas", "volcan", "bosque", "nieve", "neon"];
const ZONE_POWER: Record<BiomeId, PowerType | null> = { ruinas: "aire", volcan: "fuego", bosque: "tierra", nieve: "hielo", neon: null };
const ENEMY_COLOR: Partial<Record<BiomeId, string>> = { ruinas: "#9aa3bd", volcan: "#ff4d4d", bosque: "#4dff88", nieve: "#f5f5f5" };
const NEON_COLORS = ["#9aa3bd", "#ff4d4d", "#4dff88", "#f5f5f5"];
const PULSE_MS = 10000, PULSE_DUR_MS = 5000;

export class SagaSession extends SoloSession {
  readonly kind = "saga";
  private zoneIdx = 0;
  private level = 1; // 1-3 normal, 4 jefe
  private earned: PowerType[] = [];
  private botIds: number[] = [];
  private resolved = false;
  private messageShowing = false;
  private pulseT = 0;
  private pendingPortal: (() => void) | null = null;
  private retryTimer: number | null = null;

  constructor(engine: Engine, resume: SagaRun | null, private onExit: () => void) {
    super(engine);
    this.setupMe();
    if (resume) {
      this.zoneIdx = resume.zoneIdx;
      this.level = resume.level;
      this.earned = (resume.earnedPowers || []).filter((p): p is PowerType => (POWER_TYPES as readonly string[]).includes(p));
      this.simTimeMs = resume.elapsedMs || 0;
      this.startLevel();
    } else {
      this.saveRun();
      this.narrative(0, () => this.startLevel());
    }
  }

  protected override frozen() {
    return this.paused || this.messageShowing;
  }

  private saveRun() {
    sagaState.set({ run: { zoneIdx: this.zoneIdx, level: this.level, earnedPowers: this.earned, elapsedMs: this.simTimeMs } });
  }

  private message(title: string, body: string, button: string, onContinue: () => void, accent?: string) {
    this.messageShowing = true;
    storyMsg.set({ title, body, button, accent, onContinue: () => { this.messageShowing = false; storyMsg.set(null); onContinue(); } });
  }

  private narrative(idx: number, next: () => void) {
    const z = ZONES[idx];
    this.message(t("biome." + z), t("saga.narrative." + z), t("story.continue"), next, getBiome(z).accentText);
  }

  private bossPowers(zoneIdx: number): Partial<Record<PowerType, boolean>> {
    const powers: Partial<Record<PowerType, boolean>> = {};
    for (let i = 0; i < Math.min(zoneIdx + 1, 4); i++) {
      const k = ZONE_POWER[ZONES[i]];
      if (k) powers[k] = true;
    }
    return powers;
  }

  private startLevel() {
    this.resolved = false;
    this.bots.reset();
    this.sim.resetToLobby();
    this.sim.addPlayer(ME).isHero = true;
    this.botIds = [];
    const zone = ZONES[this.zoneIdx];
    const isBoss = this.level === 4;
    const n = isBoss ? 1 : this.level;
    const myColor = this.colors[ME];
    this.colors = myColor ? { [ME]: myColor } : {};
    for (let i = 0; i < n; i++) {
      const id = 2 + i;
      this.colors[id] = zone === "neon" ? NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)] : ENEMY_COLOR[zone]!;
      this.sim.addPlayer(id).isBot = true;
      this.names[id] = isBoss ? t("player.boss") : t("player.npc") + " " + (i + 1);
      this.hats[id] = isBoss ? "crown" : "none";
      this.botIds.push(id);
    }
    this.pulseT = 0;
    this.sim.startMatch(1, {
      mode: "infinite", biome: zone, noOrbs: true,
      mapArchetype: isBoss ? "santuario" : STANDARD_ARCHETYPES[Math.floor(Math.random() * STANDARD_ARCHETYPES.length)],
    });
    if (isBoss) this.sim.players[this.botIds[0]].power = { t: 1e9, ...this.bossPowers(this.zoneIdx) };
    const zoneName = t("biome." + zone);
    banner.set(isBoss ? t("saga.bossBanner", { biome: zoneName }) : t("saga.levelBanner", { biome: zoneName, n: this.level }));
    pulseFight();
    this.saveRun();
  }

  private pulse() {
    const zone = ZONES[this.zoneIdx];
    const zp = ZONE_POWER[zone];
    if (this.level < 4) {
      for (const id of this.botIds) {
        const p = this.sim.players[id];
        if (!p || !p.alive) continue;
        const power: Power = { t: PULSE_DUR_MS };
        if (zp) power[zp] = true;
        else {
          const pool: PowerType[] = [...POWER_TYPES];
          for (let k = 0; k < 2; k++) power[pool.splice(Math.floor(Math.random() * pool.length), 1)[0]] = true;
        }
        p.power = power;
      }
    }
    if (this.earned.length) {
      const power: Power = { t: PULSE_DUR_MS };
      for (const k of this.earned) power[k] = true;
      const me = this.sim.players[ME];
      if (me) me.power = power;
    }
  }

  protected override preStep(dt: number) {
    const cfg = BOT_DIFFICULTY[this.zoneIdx >= 2 ? "hard" : "medium"];
    for (const id of this.botIds) this.bots.tick(id, ME, dt, cfg);
    this.pulseT -= dt;
    if (this.pulseT <= 0) { this.pulseT += PULSE_MS; this.pulse(); }
  }

  protected override postStep() {
    if (this.resolved) return;
    const human = this.sim.players[ME];
    if (!human) return;
    if (!human.alive) { this.resolved = true; this.sim.forceEndMatch(); this.onLoss(); return; }
    if (!this.botIds.some((id) => this.sim.players[id]?.alive)) { this.resolved = true; this.sim.forceEndMatch(); this.onWin(); }
  }

  private onWin() {
    audio.on.pickup();
    if (this.level === 4) {
      if (this.zoneIdx >= ZONES.length - 1) { this.sim.spawnPortal("#ffc247"); this.pendingPortal = () => this.finishGame(); }
      else {
        this.sim.spawnPortal(getBiome(ZONES[this.zoneIdx + 1]).accentText);
        this.pendingPortal = () => {
          const gained = ZONE_POWER[ZONES[this.zoneIdx]];
          if (gained) { this.earned = this.earned.concat(gained); showToast(t("saga.powerGained", { power: t("power." + gained) })); }
          this.zoneIdx++;
          this.level = 1;
          this.saveRun();
          this.narrative(this.zoneIdx, () => this.startLevel());
        };
      }
      return;
    }
    this.sim.spawnPortal(getBiome(ZONES[this.zoneIdx]).accentText, { boss: this.level >= 3 });
    this.pendingPortal = () => { this.level++; this.startLevel(); };
  }

  private onLoss() {
    this.level = 1;
    this.saveRun();
    this.retryTimer = window.setTimeout(() => this.startLevel(), 1400);
  }

  protected override onPortalEnter() {
    const a = this.pendingPortal;
    this.pendingPortal = null;
    a?.();
  }

  private finishGame() {
    const finalMs = this.simTimeMs;
    sagaState.set({ run: null });
    const body = t("saga.finishBody") + " " + t("lb.yourTime", { time: formatRunTime(finalMs) });
    this.message(t("saga.finishTitle"), body, t("story.continue"), () => {
      crawl.set({ onEnd: () => { crawl.set(null); this.exit(); } });
    }, "#ffc247");
    void submitRun("saga", this.names[ME], finalMs).then((best) => {
      const cur = get(storyMsg);
      if (best && cur && cur.body === body) storyMsg.set({ ...cur, body: body + " " + t("lb.bestTime", { time: formatRunTime(best.time_ms), name: best.name }) });
    });
  }

  exit() {
    sagaState.set({ run: null });
    this.onExit();
  }

  protected override hudBase(): Partial<HudState> {
    return { label: t("hud.sagaTitle"), endLabel: t("hud.leaveStory"), timer: formatRunTime(this.simTimeMs) };
  }

  override dispose() {
    super.dispose();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    banner.set(null);
    storyMsg.set(null);
  }
}
