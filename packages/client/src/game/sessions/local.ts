/* Modo Local: hasta 8 en la misma máquina con dos esquemas de teclado, mandos y celulares. La sim
   corre acá; cada fuente de input está atada a un jugador. */

import type { InputKey, PhaseInfo, RoomMode } from "@lss/shared";
import { SimSession } from "../session";
import type { Engine } from "../engine";
import { input, type Slot } from "../input";
import { banner, pulseFight, type HudState } from "../../app/ui";
import { t, translateMapName } from "../../app/i18n";
import { showScoreReveal, hideScoreReveal } from "../reveal";

export type LocalSource = { type: "kb"; slot: 1 | 2 } | { type: "gp"; index: number } | { type: "pad"; pad: number };

export interface LocalPlayerDef {
  id: number;
  name: string;
  color: string;
  hat: string;
  source: LocalSource;
}

export interface LocalCallbacks {
  onFinal(ranked: number[], scores: Record<number, number>): void;
}

export class LocalSession extends SimSession {
  readonly kind = "local";
  /** Quiénes entraron de verdad a esta partida (un celular que se suma tarde espera la próxima). */
  readonly matchIds = new Set<number>();
  private finalShown = false;

  constructor(engine: Engine, private players: LocalPlayerDef[], readonly mode: RoomMode, readonly rounds: number, private cb: LocalCallbacks) {
    super(engine);
    this.startMatch();
  }

  startMatch() {
    this.finalShown = false;
    this.sim.resetToLobby();
    this.bots.reset();
    this.matchIds.clear();
    this.names = {}; this.colors = {}; this.hats = {};
    for (const p of this.players) {
      this.names[p.id] = p.name;
      this.colors[p.id] = p.color;
      this.hats[p.id] = p.hat;
      this.sim.addPlayer(p.id);
      this.matchIds.add(p.id);
    }
    this.sim.startMatch(this.rounds, { mode: this.mode });
  }

  /** Revancha con el sillón tal como está ahora (pueden haberse sumado celulares). */
  rematch(players: LocalPlayerDef[]) {
    this.players = players;
    this.engine.renderer.resetPlayers();
    this.startMatch();
  }

  private playerForSlot(slot: Slot): number | null {
    for (const p of this.players) {
      const s = p.source;
      if (s.type === "kb" && ((slot === "kb1" || slot === "mouse" || slot === "touch") ? s.slot === 1 : slot === "kb2" && s.slot === 2)) return p.id;
      if (s.type === "gp" && slot === `gp${s.index}`) return p.id;
    }
    return null;
  }

  onInput(slot: Slot, key: InputKey, down: boolean) {
    const id = this.playerForSlot(slot);
    if (id !== null && this.matchIds.has(id)) this.sim.handleInput(id, key, down);
  }

  padInput(playerId: number, key: string, down: boolean) {
    if (this.matchIds.has(playerId)) this.sim.handleInput(playerId, key, down);
  }

  releasePlayer(playerId: number) {
    if (this.matchIds.has(playerId)) this.sim.clearInputs(playerId);
  }

  protected override rumbleFor(id: number, s: number, ms: number) {
    const p = this.players.find((x) => x.id === id);
    if (p && p.source.type === "gp") input.rumble(p.source.index, s, ms);
  }

  protected override onPhase(info: PhaseInfo) {
    if (info.t === "roundStart") {
      hideScoreReveal();
      const map = translateMapName(info.mapName);
      if (this.mode === "koth") banner.set(t("hud.koth", { map }));
      else if (this.mode === "orbking") banner.set(t("hud.orbking", { map }));
      else if (this.mode === "wins") banner.set(t("hud.round", { n: info.round }));
      else banner.set(t("hud.roundOf", { n: info.round, total: Number.isFinite(info.totalRounds) ? info.totalRounds : "∞", map }));
      pulseFight();
      if (info.infinite && info.round % 5 === 0) showScoreReveal(this.sim.roster, this.sim.scores, this.sim.matchStats, (id) => this.nameFor(id), (id) => this.colorFor(id));
    } else if (info.t === "final" && !this.finalShown) {
      this.finalShown = true;
      banner.set(null);
      hideScoreReveal();
      this.cb.onFinal(info.ranked, { ...this.sim.scores });
    }
  }

  protected override hudBase(): Partial<HudState> {
    return {
      label: t("hud.localTitle"),
      endLabel: t("hud.leaveLocal"),
      showScores: this.mode === "wins" || this.mode === "rounds" || this.mode === "infinite",
    };
  }

  override dispose() {
    super.dispose();
    banner.set(null);
    hideScoreReveal();
  }
}
