/* Pelea de fondo del menú: cuatro bots en un mapa y bioma al azar, sin sonido ni carteles. Le da
   vida a la pantalla de inicio y muestra el juego antes de que nadie toque nada. */

import { BOT_DIFFICULTY, PLAYER_COLORS, STANDARD_ARCHETYPES, BIOME_IDS, type InputKey } from "@lss/shared";
import { SimSession } from "../session";
import type { Engine } from "../engine";
import type { Slot } from "../input";
import type { RenderView } from "../../render/renderer";

const HATS = ["tophat", "crown", "cowboy", "halo", "horns", "cap", "party", "mohawk"];

export class AttractSession extends SimSession {
  readonly kind = "attract";
  override readonly interactive = false;
  suspended = false;

  constructor(engine: Engine) {
    super(engine);
    this.fxCtx.silent = true;
    this.showDamageNumbers = false;
    this.fxCtx.hitStop = undefined;
    this.fxCtx.rumble = undefined;
    this.restart();
  }

  restart() {
    this.sim.resetToLobby();
    this.bots.reset();
    const palette = [...PLAYER_COLORS].sort(() => Math.random() - 0.5);
    for (let i = 0; i < 4; i++) {
      this.sim.addPlayer(i);
      this.colors[i] = palette[i];
      this.hats[i] = HATS[Math.floor(Math.random() * HATS.length)];
    }
    this.sim.startMatch(1, {
      mode: "infinite",
      biome: BIOME_IDS[Math.floor(Math.random() * BIOME_IDS.length)],
      mapArchetype: STANDARD_ARCHETYPES[Math.floor(Math.random() * STANDARD_ARCHETYPES.length)],
    });
  }

  protected override preStep(dt: number) {
    const alive = this.sim.roster.filter((id) => this.sim.players[id]?.alive);
    for (const id of this.sim.roster) {
      const target = alive.find((o) => o !== id) ?? id;
      this.bots.tick(id, target, dt, id % 2 ? BOT_DIFFICULTY.medium : BOT_DIFFICULTY.hard);
    }
  }

  override update(dt: number) {
    if (this.suspended) return;
    super.update(dt);
  }

  protected override pushHud() { /* sin HUD */ }

  onInput(_s: Slot, _k: InputKey, _d: boolean) {}

  override view(): RenderView {
    return { ...super.view(), hideTags: true };
  }
}
