/* Base de los modos de un solo jugador humano (práctica, Last Stick Standing, Modo Historia): todos
   los slots de entrada (los dos teclados, el mouse, cualquier mando) manejan al mismo muñeco. */

import { type InputKey } from "@lss/shared";
import { get } from "svelte/store";
import { SimSession } from "../session";
import type { Engine } from "../engine";
import { input, type Slot } from "../input";
import { profile } from "../../app/persist";
import { t } from "../../app/i18n";

export const ME = 1;

export abstract class SoloSession extends SimSession {
  private lastPadSlot: number | null = null;

  constructor(engine: Engine) {
    super(engine);
    this.meId = ME;
  }

  protected setupMe() {
    const p = get(profile);
    this.names = { [ME]: p.name.trim() || t("player.default") };
    this.colors = p.color ? { [ME]: p.color } : {};
    this.hats = { [ME]: p.hat };
  }

  onInput(slot: Slot, key: InputKey, down: boolean) {
    if (slot.startsWith("gp")) this.lastPadSlot = Number(slot.slice(2));
    this.sim.handleInput(ME, key, down);
  }

  protected override rumbleFor(id: number, s: number, ms: number) {
    if (id === ME && this.lastPadSlot !== null) input.rumble(this.lastPadSlot, s, ms);
  }
}
