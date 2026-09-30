/* Entrenamiento infinito: vos contra un bot, en el bioma elegido, rondas sin fin. */

import { BOT_DIFFICULTY, type BiomeId, type BotDifficultyId, type PhaseInfo } from "@lss/shared";
import { SoloSession, ME } from "./solo";
import type { Engine } from "../engine";
import { banner, fightPulse, type HudState } from "../../app/ui";
import { t, translateMapName } from "../../app/i18n";
import { showScoreReveal, hideScoreReveal } from "../reveal";

const AI = 2;

export class PracticeSession extends SoloSession {
  readonly kind = "practice";

  constructor(engine: Engine, private difficulty: BotDifficultyId, private biome: BiomeId | null) {
    super(engine);
    this.setupMe();
    this.names[AI] = t("player.npc");
    this.sim.resetToLobby();
    this.sim.addPlayer(ME);
    this.sim.addPlayer(AI);
    this.sim.startMatch(1, { mode: "infinite", biome: this.biome });
  }

  protected override preStep(dt: number) {
    this.bots.tick(AI, ME, dt, BOT_DIFFICULTY[this.difficulty]);
  }

  protected override onPhase(info: PhaseInfo) {
    if (info.t === "roundStart") {
      hideScoreReveal();
      banner.set(t("hud.roundSimple", { n: info.round, map: translateMapName(info.mapName) }));
      fightPulse.update((n) => n + 1);
      if (info.infinite && info.round % 5 === 0) showScoreReveal(this.sim.roster, this.sim.scores, this.sim.matchStats, (id) => this.nameFor(id), (id) => this.colorFor(id));
    }
  }

  protected override hudBase(): Partial<HudState> {
    return { label: t("hud.practiceTitle"), endLabel: t("hud.leavePractice"), showScores: true };
  }

  override dispose() {
    super.dispose();
    banner.set(null);
    hideScoreReveal();
  }
}
