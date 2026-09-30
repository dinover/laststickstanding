/* Director de efectos: traduce los eventos de la simulación a efectos visuales + audio. Es la
   misma función para partidas locales (eventos de la sim del navegador) y online (eventos que
   manda el servidor dentro del snapshot). En V1 online nada de esto llegaba a los clientes. */

import { ATTACKS, POWER_COLORS, type SimEvent } from "@lss/shared";
import { audio } from "../audio/audio";
import type { Renderer } from "../render/renderer";

export interface FxContext {
  colorFor(id: number): string;
  /** Jugador propio (para no repetir sonidos que la predicción ya disparó, y para vibrar). */
  meId: number | null;
  /** Online: los saltos y golpes al aire propios ya sonaron al predecirlos. */
  skipOwnPredicted: boolean;
  damageNumbers: boolean;
  /** Vibración del mando del jugador `id`, si es local. */
  rumble?(id: number, strength: number, ms: number): void;
  /** Hitstop real (solo modos locales, donde la sim corre acá). */
  hitStop?(ms: number): void;
  /** Sin audio (la pelea de fondo del menú). */
  silent?: boolean;
}

const MUTED = new Proxy({}, { get: () => () => {} }) as typeof audio.on;

export function playSimEvent(e: SimEvent, r: Renderer, ctx: FxContext): void {
  const snd = ctx.silent ? MUTED : audio.on;
  switch (e.k) {
    case "jump":
      if (!(ctx.skipOwnPredicted && e.id === ctx.meId)) snd.jump(e.x, e.dbl);
      r.jumpPuff(e.x, e.y, e.dbl);
      break;
    case "swing":
      if (!(ctx.skipOwnPredicted && e.id === ctx.meId)) snd.swing(e.a);
      break;
    case "hit": {
      const atk = ATTACKS[e.a];
      const heavy = e.a === "kick";
      ctx.hitStop?.(atk.hitStop);
      r.camera.addTrauma(atk.trauma);
      r.camera.zoomImpulse(heavy ? 0.035 : 0.02);
      r.sparks(e.x, e.y, e.dir, ctx.colorFor(e.id));
      r.impactStreak(e.x, e.y, e.dir);
      if (heavy) r.shockwave(e.x, e.y, 0.35);
      if (ctx.damageNumbers) r.damageNumber(e.x, e.y - 20, e.dmg, heavy ? "#ffd166" : "#ffffff", heavy);
      snd.hit(e.a, e.x, heavy);
      ctx.rumble?.(e.t, heavy ? 0.8 : 0.45, heavy ? 160 : 90);
      ctx.rumble?.(e.id, 0.2, 50);
      break;
    }
    case "land":
      r.camera.addTrauma(e.s * 0.22);
      r.landingDust(e.x, e.y, e.s);
      snd.land(e.s, e.x);
      break;
    case "ko": {
      const color = ctx.colorFor(e.id);
      ctx.hitStop?.(55);
      r.camera.addTrauma(0.85);
      r.camera.zoomImpulse(0.05);
      r.screenFlash(0.5);
      r.koBurst(e.x, e.y, color);
      r.limbDebris(e.x, e.y + 20, color, e.x < 576 ? 1 : -1);
      r.shockwave(e.x, e.y, 1);
      r.chroma(160);
      snd.ko(e.x);
      ctx.rumble?.(e.id, 1, 320);
      break;
    }
    case "burn":
      r.embers(e.x, e.y);
      snd.burn(e.x);
      break;
    case "respawn":
      break;
    case "pickup":
      r.pickupBurst(e.x, e.y, POWER_COLORS[e.p]);
      snd.pickup(e.x);
      break;
    case "clutch":
      snd.clutch();
      break;
    case "round":
      snd.roundStart(e.biome);
      r.clearTransient();
      break;
    case "fight":
      r.camera.zoomImpulse(0.04);
      snd.fightBegin();
      break;
    case "final":
      if (e.winner !== null) snd.victory(); else snd.gameOver();
      break;
    case "lobby":
      snd.toLobby();
      break;
  }
}
