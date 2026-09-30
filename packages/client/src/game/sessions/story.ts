/* "Last Stick Standing" (la campaña clásica): el héroe contra N NPCs que son equipo entre sí, a
   través de 4 biomas con checkpoints, salas secretas (agujero de vacío) y cronómetro global.
   Port de V1: misma progresión, unlocks y guardado; cada nivel es su propio startMatch de una
   ronda y ganar/perder se detecta acá. */

import { BOT_DIFFICULTY, STANDARD_ARCHETYPES, getBiome, type BiomeId } from "@lss/shared";
import { get } from "svelte/store";
import { SoloSession, ME } from "./solo";
import type { Engine } from "../engine";
import { banner, fightPulse, storyMsg, type HudState } from "../../app/ui";
import { t } from "../../app/i18n";
import { storyState, type StoryDifficulty, type StoryRun } from "../../app/persist";
import { formatRunTime, submitRun, type Board } from "../../services/supabase";
import { audio } from "../../audio/audio";

const STORY_BIOMES: BiomeId[] = ["ruinas", "volcan", "bosque", "nieve"];
const STORY_LEVELS: Record<StoryDifficulty, number> = { easy: 2, medium: 3, hard: 5, hardcore: 5 };
const SECRET_LEVEL: Partial<Record<StoryDifficulty, number>> = { easy: 1, medium: 2, hard: 3 };
const SKIP_TAUNT_THRESHOLD = 3;

export class StorySession extends SoloSession {
  readonly kind = "story";
  private difficulty: StoryDifficulty;
  private biomeIdx = 0;
  private level = 1;
  private botIds: number[] = [];
  private resolved = false;
  private messageShowing = false;
  private pendingPortal: (() => void) | null = null;
  private inSecret = false;
  private secretOriginLevel = 1;
  private voidAvailable = false;
  private skipStreak = 0;
  private skippedSecretBiomes: number[] = [];
  private secretTakenBiomes: number[] = [];
  private retryTimer: number | null = null;

  constructor(engine: Engine, resume: StoryRun | null, difficulty: StoryDifficulty, private onExit: () => void) {
    super(engine);
    this.setupMe();
    if (resume) {
      this.difficulty = resume.difficulty;
      this.biomeIdx = resume.biomeIdx;
      this.level = resume.level;
      this.skipStreak = resume.skipStreak || 0;
      this.skippedSecretBiomes = resume.skippedSecretBiomes || [];
      this.secretTakenBiomes = resume.secretTakenBiomes || [];
      this.simTimeMs = resume.elapsedMs || 0;
      this.startLevel();
    } else {
      this.difficulty = difficulty;
      this.saveRun();
      this.showNarrative(0, () => this.startLevel());
    }
  }

  protected override frozen() {
    return this.paused || this.messageShowing;
  }

  private npcCount(biomeIdx: number, level: number) {
    const base = biomeIdx + 1;
    return this.difficulty === "hardcore" ? base + (level - 1) : base;
  }

  private levelHasSecret() {
    if (this.difficulty === "hardcore") return this.level === STORY_LEVELS.hardcore;
    return this.level === SECRET_LEVEL[this.difficulty];
  }

  private saveRun() {
    storyState.update((s) => ({
      ...s,
      run: {
        difficulty: this.difficulty, biomeIdx: this.biomeIdx, level: this.level, skipStreak: this.skipStreak,
        skippedSecretBiomes: this.skippedSecretBiomes, secretTakenBiomes: this.secretTakenBiomes, elapsedMs: this.simTimeMs,
      },
    }));
  }

  private message(title: string, body: string, button: string, onContinue: () => void, accent?: string) {
    this.messageShowing = true;
    storyMsg.set({
      title, body, button, accent,
      onContinue: () => { this.messageShowing = false; storyMsg.set(null); onContinue(); },
    });
  }

  private showNarrative(idx: number, next: () => void) {
    const b = STORY_BIOMES[idx];
    this.message(t("biome." + b), t("story.narrative." + b), t("story.continue"), next, getBiome(b).accentText);
  }

  private spawnLevel(biome: BiomeId, npcCount: number) {
    this.resolved = false;
    this.bots.reset();
    this.sim.resetToLobby();
    this.sim.addPlayer(ME).isHero = true;
    this.botIds = [];
    const colors = this.colors[ME];
    this.colors = colors ? { [ME]: colors } : {};
    for (let i = 0; i < npcCount; i++) {
      const id = 2 + i;
      this.sim.addPlayer(id).isBot = true;
      this.names[id] = t("player.npc") + " " + (i + 1);
      this.botIds.push(id);
    }
    const arch = STANDARD_ARCHETYPES[Math.floor(Math.random() * STANDARD_ARCHETYPES.length)];
    this.sim.startMatch(1, { mode: "infinite", biome, mapArchetype: arch });
    banner.set(this.inSecret ? t("story.secretBanner") : t("story.levelBanner", { biome: t("biome." + biome), n: this.level, total: STORY_LEVELS[this.difficulty] }));
    fightPulse.update((n) => n + 1);
  }

  private startLevel() {
    this.inSecret = false;
    this.spawnLevel(STORY_BIOMES[this.biomeIdx], this.npcCount(this.biomeIdx, this.level));
    this.saveRun();
  }

  private enterSecretRoom() {
    this.inSecret = true;
    this.spawnLevel("neon", this.npcCount(this.biomeIdx, this.level) + 2);
    this.sim.grantAllPowers(ME);
  }

  private nextBiomeWithCongrats() {
    const idx = this.biomeIdx;
    const b = STORY_BIOMES[idx];
    this.message(t("biome." + b), t("story.congrats." + b), t("story.continue"), () => {
      this.biomeIdx++;
      this.level = 1;
      this.saveRun();
      this.showNarrative(this.biomeIdx, () => this.startLevel());
    }, getBiome(b).accentText);
  }

  private onWin() {
    audio.on.pickup();
    if (this.inSecret) {
      this.inSecret = false;
      this.secretTakenBiomes.push(this.biomeIdx);
      this.saveRun();
      if (this.biomeIdx >= STORY_BIOMES.length - 1) { this.sim.spawnPortal("#ffc247"); this.pendingPortal = () => this.finishGame(); }
      else { this.sim.spawnPortal(getBiome(STORY_BIOMES[this.biomeIdx + 1]).accentText); this.pendingPortal = () => this.nextBiomeWithCongrats(); }
      return;
    }
    const hasSecret = this.levelHasSecret();
    const lastLevel = this.level >= STORY_LEVELS[this.difficulty];
    const lastBiome = this.biomeIdx >= STORY_BIOMES.length - 1;
    if (lastLevel && lastBiome) { this.sim.spawnPortal("#ffc247"); this.pendingPortal = () => this.finishGame(); }
    else if (lastLevel) { this.sim.spawnPortal(getBiome(STORY_BIOMES[this.biomeIdx + 1]).accentText); this.pendingPortal = () => this.nextBiomeWithCongrats(); }
    else { this.sim.spawnPortal(getBiome(STORY_BIOMES[this.biomeIdx]).accentText); this.pendingPortal = () => { this.level++; this.startLevel(); }; }
    if (hasSecret) {
      this.secretOriginLevel = this.level;
      this.voidAvailable = true;
      this.sim.spawnVoidHole();
    }
  }

  private onLoss() {
    if (this.inSecret) { this.inSecret = false; this.level = this.secretOriginLevel; }
    else this.level = 1; // checkpoint: vuelve al inicio del bioma
    this.saveRun();
    this.retryTimer = window.setTimeout(() => this.startLevel(), 1400);
  }

  protected override postStep() {
    if (this.resolved) return;
    const human = this.sim.players[ME];
    if (!human) return;
    if (!human.alive) { this.resolved = true; this.sim.forceEndMatch(); this.onLoss(); return; }
    if (!this.botIds.some((id) => this.sim.players[id]?.alive)) { this.resolved = true; this.sim.forceEndMatch(); this.onWin(); }
  }

  protected override preStep(dt: number) {
    const cfg = BOT_DIFFICULTY[this.difficulty === "hardcore" ? "hard" : this.difficulty];
    for (const id of this.botIds) this.bots.tick(id, ME, dt, cfg);
  }

  protected override onPortalEnter() {
    const action = this.pendingPortal;
    this.pendingPortal = null;
    this.sim.clearWorldObjects();
    let taunt = false;
    if (this.voidAvailable && !this.inSecret) {
      this.skippedSecretBiomes.push(this.biomeIdx);
      if (this.difficulty !== "hardcore") {
        this.skipStreak++;
        if (this.skipStreak >= SKIP_TAUNT_THRESHOLD) { taunt = true; this.skipStreak = 0; }
      }
      this.saveRun();
    }
    this.voidAvailable = false;
    if (taunt) this.message(t("story.tauntTitle"), t("story.tauntBody"), t("story.continue"), action || (() => {}));
    else action?.();
  }

  protected override onVoidEnter() {
    this.pendingPortal = null;
    this.sim.clearWorldObjects();
    this.voidAvailable = false;
    this.skipStreak = 0;
    this.enterSecretRoom();
  }

  private finishGame() {
    const cleanClear = this.skippedSecretBiomes.length === 0;
    const wasHardcore = this.difficulty === "hardcore";
    const unlockKey = ({ easy: "clearedEasy", medium: "clearedMedium", hard: "clearedHard", hardcore: "clearedHardcore" } as const)[this.difficulty];
    const unlockedHat = ({ easy: "propeller", medium: "flame", hard: "crown", hardcore: "orbit" } as const)[this.difficulty];
    const already = get(storyState).unlocks[unlockKey];
    storyState.update((s) => ({ run: null, unlocks: { ...s.unlocks, [unlockKey]: true } }));
    const finalMs = this.simTimeMs;
    const parts = [t(wasHardcore ? "story.finalHardcoreBody" : "story.finalBody"), t(cleanClear ? "story.finalCleanClear" : "story.finalSkippedSecrets")];
    if (!wasHardcore) parts.push(t("story.finalRecommend." + (this.difficulty === "easy" ? "medium" : this.difficulty === "medium" ? "hard" : "hardcore")));
    if (!already) parts.push(t("story.unlocked", { hat: t("hat." + unlockedHat) }));
    parts.push(t("lb.yourTime", { time: formatRunTime(finalMs) }));
    const body = parts.join(" ");
    this.message(t(wasHardcore ? "story.finalTitleHardcore" : "story.finalTitle"), body, t("story.finalContinue"), () => this.exit(), "#ffc247");
    const board = ("lss_" + this.difficulty) as Board;
    void submitRun(board, this.names[ME], finalMs).then((best) => {
      const cur = get(storyMsg);
      if (best && cur && cur.body === body) storyMsg.set({ ...cur, body: body + " " + t("lb.bestTime", { time: formatRunTime(best.time_ms), name: best.name }) });
    });
  }

  exit() {
    storyState.update((s) => ({ ...s, run: null }));
    this.onExit();
  }

  protected override hudBase(): Partial<HudState> {
    return { label: t("hud.storyTitle"), endLabel: t("hud.leaveStory"), timer: formatRunTime(this.simTimeMs) };
  }

  override dispose() {
    super.dispose();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    banner.set(null);
    storyMsg.set(null);
  }
}
