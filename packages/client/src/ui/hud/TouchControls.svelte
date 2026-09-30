<script lang="ts">
  /* Controles táctiles en pantalla (V2): con esto se puede jugar online y en solitario desde el
     celular, no solo usarlo de joystick del modo Local. Misma idea que el control del /pad:
     analógico que se arma donde apoyás el pulgar izquierdo, botones a la derecha. */
  import type { InputKey } from "@lss/shared";
  import { input } from "../../game/input";
  import { tr } from "../../app/i18n";

  const DEAD = 14, RANGE = 46;
  let pressed = $state<Partial<Record<InputKey, boolean>>>({});
  let stick = $state<{ x: number; y: number; dx: number } | null>(null);
  let pid: number | null = null, ox = 0;
  let zone: HTMLDivElement;
  const heldDir = { left: false, right: false };

  function emit(k: InputKey, d: boolean) { input.sink?.onInput("touch", k, d); }
  function dir(k: "left" | "right", d: boolean) { if (heldDir[k] !== d) { heldDir[k] = d; emit(k, d); } }

  function sDown(e: PointerEvent) {
    if (pid !== null) return;
    e.preventDefault();
    pid = e.pointerId; ox = e.clientX;
    const r = zone.getBoundingClientRect();
    stick = { x: e.clientX - r.left, y: e.clientY - r.top, dx: 0 };
    try { zone.setPointerCapture(e.pointerId); } catch { /* */ }
  }
  function sMove(e: PointerEvent) {
    if (e.pointerId !== pid || !stick) return;
    const dx = e.clientX - ox;
    stick = { ...stick, dx };
    dir("left", dx < -DEAD);
    dir("right", dx > DEAD);
  }
  function sUp(e: PointerEvent) {
    if (e.pointerId !== pid) return;
    pid = null; stick = null; dir("left", false); dir("right", false);
  }
  function hold(k: InputKey, d: boolean, e?: PointerEvent) {
    e?.preventDefault();
    if (d && e) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (!!pressed[k] === d) return;
    pressed = { ...pressed, [k]: d };
    emit(k, d);
    if (d && navigator.vibrate) navigator.vibrate(6);
  }
</script>

<div class="touch ui-block">
  <div class="stick" bind:this={zone} onpointerdown={sDown} onpointermove={sMove} onpointerup={sUp} onpointercancel={sUp} onlostpointercapture={sUp}>
    {#if stick}
      <div class="base" style="left:{stick.x}px;top:{stick.y}px"><div class="knob" style="transform:translateX({Math.max(-RANGE, Math.min(RANGE, stick.dx))}px)"></div></div>
    {:else}
      <div class="hint">⟵ ⟶</div>
    {/if}
  </div>
  <div class="btns">
    <button class="b punch" class:down={pressed.punch} onpointerdown={(e) => hold("punch", true, e)} onpointerup={(e) => hold("punch", false, e)} onpointercancel={(e) => hold("punch", false, e)}>👊</button>
    <button class="b kick" class:down={pressed.kick} onpointerdown={(e) => hold("kick", true, e)} onpointerup={(e) => hold("kick", false, e)} onpointercancel={(e) => hold("kick", false, e)}>🦶</button>
    <button class="b jump" class:down={pressed.jump} onpointerdown={(e) => hold("jump", true, e)} onpointerup={(e) => hold("jump", false, e)} onpointercancel={(e) => hold("jump", false, e)} aria-label={$tr("hud.fight")}>⤒</button>
  </div>
</div>

<style>
  .touch { position: absolute; inset: auto 0 0 0; height: 42%; z-index: 13; display: flex; justify-content: space-between; padding: 0 max(14px, env(safe-area-inset-right)) max(14px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); pointer-events: none; touch-action: none; user-select: none; }
  .stick { position: relative; width: 46%; height: 100%; pointer-events: auto; touch-action: none; }
  .hint { position: absolute; left: 30%; bottom: 30%; font-size: 22px; color: rgba(255,255,255,.18); pointer-events: none; }
  .base { position: absolute; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%; border: 2px solid rgba(255,255,255,.18); background: rgba(10,12,26,.35); pointer-events: none; }
  .knob { position: absolute; top: 50%; left: 50%; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%; background: rgba(53,240,224,.35); border: 2px solid rgba(53,240,224,.8); }
  .btns { position: relative; width: 190px; height: 100%; pointer-events: none; }
  .b { position: absolute; width: 72px; height: 72px; border-radius: 50%; pointer-events: auto; touch-action: none; font-size: 26px;
    background: rgba(10,12,26,.45); border: 2px solid rgba(255,255,255,.2); color: #fff; backdrop-filter: blur(4px); transition: transform .06s; }
  .b.down { transform: scale(.92); }
  .jump { right: 0; bottom: 0; width: 84px; height: 84px; border-color: rgba(255,194,71,.6); }
  .punch { right: 96px; bottom: 6px; border-color: rgba(255,46,136,.6); }
  .kick { right: 30px; bottom: 96px; border-color: rgba(53,240,224,.6); }
  .jump.down { background: rgba(255,194,71,.3); } .punch.down { background: rgba(255,46,136,.3); } .kick.down { background: rgba(53,240,224,.3); }
</style>
