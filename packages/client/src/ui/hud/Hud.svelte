<script lang="ts">
  import { fade, fly, scale } from "svelte/transition";
  import { backOut } from "svelte/easing";
  import { onMount, untrack } from "svelte";
  import { tr } from "../../app/i18n";
  import { banner, fightPulse, hud, fps, msSinceFightPulse } from "../../app/ui";
  import { settings } from "../../app/persist";
  import { hudEnd } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import ScoreReveal from "./ScoreReveal.svelte";
  import TouchControls from "./TouchControls.svelte";

  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

  let { onPause }: { onPause: () => void } = $props();

  let showFight = $state(false);
  let fightKey = $state(0);
  let hintVisible = $state(true);
  // si el "¡A PELEAR!" se disparó un instante antes de montar el HUD, igual se muestra
  let lastPulse = msSinceFightPulse() < 600 ? $fightPulse - 1 : $fightPulse;
  let fightTimer: number | undefined;
  onMount(() => fightPulse.subscribe((n) => {
    if (n === lastPulse) return;
    lastPulse = n;
    fightKey = untrack(() => fightKey) + 1;
    showFight = true;
    clearTimeout(fightTimer);
    fightTimer = window.setTimeout(() => (showFight = false), 950);
  }));
  onMount(() => { const t = setTimeout(() => (hintVisible = false), 7000); return () => clearTimeout(t); });
</script>

<div class="hud" transition:fade={{ duration: 200 }}>
  <div class="tl">
    <div class="label-chip">
      <span class="lab">{$hud.label}</span>{#if $hud.code}<b>{$hud.code}</b>{/if}
    </div>
    {#if $hud.ping !== null}
      <span class="ping" class:good={$hud.ping < 60} class:ok={$hud.ping >= 60 && $hud.ping < 150} class:bad={$hud.ping >= 150}><i></i>{$hud.ping} ms</span>
    {/if}
    {#if $hud.timer}<span class="timer">⏱ {$hud.timer}</span>{/if}
    {#if $settings.showFps}<span class="timer">{$fps} fps</span>{/if}
  </div>

  <div class="top">
    <div class="players">
      {#each $hud.players as p (p.id)}
        <div class="pl" class:out={!p.alive} class:me={p.isMe} style="--c:{p.color}" title={p.name}>
          <span class="av">{p.name.charAt(0).toUpperCase()}</span>
          {#if $hud.showScores}<span class="sc">{p.score}</span>{/if}
          {#if !p.alive}<span class="x">✕</span>{/if}
        </div>
      {/each}
    </div>
    {#if $banner}
      {#key $banner}<div class="banner" in:fly={{ y: -10, duration: 250 }}>{$banner}</div>{/key}
    {/if}
    {#if $hud.clock}<div class="clock">{$hud.clock}</div>{/if}
  </div>

  <div class="tr ui-block">
    {#if $hud.endLabel}
      <button class="btn btn-danger btn-sm" onclick={() => { audio.on.uiBack(); hudEnd(); }}>{$hud.endLabel}</button>
    {/if}
    <button class="btn-icon" title={$tr("hud.pause")} aria-label={$tr("hud.pause")} onclick={onPause}>
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
    </button>
  </div>

  {#if showFight}
    {#key fightKey}
      <div class="fight" in:scale={{ start: 0.4, duration: 380, easing: backOut }} out:fade={{ duration: 250 }}>{$tr("hud.fight")}</div>
    {/key}
  {/if}

  <ScoreReveal />

  {#if touch}<TouchControls />{/if}

  {#if hintVisible && !touch}
    <div class="hint" out:fade={{ duration: 600 }}>
      <kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> · <kbd>Espacio</kbd> · <kbd>J</kbd> <kbd>K</kbd> · 🎮 · <kbd>Esc</kbd>
    </div>
  {/if}
</div>

<style>
  .hud { position: absolute; inset: 0; z-index: 12; pointer-events: none; }
  .hud :global(button), .hud .ui-block { pointer-events: auto; }
  .tl { position: absolute; top: 14px; left: 16px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .label-chip { font-size: 12px; letter-spacing: .12em; color: var(--muted); padding: 6px 12px; border-radius: 999px; background: rgba(8,10,22,.6); border: 1px solid var(--line); backdrop-filter: blur(8px); }
  .label-chip b { color: var(--cyan); margin-left: 6px; letter-spacing: .18em; }
  .ping, .timer { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding-left: 6px; font-variant-numeric: tabular-nums; }
  .ping i { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .ping.good { color: var(--green); } .ping.good i { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .ping.ok { color: var(--gold); } .ping.ok i { background: var(--gold); }
  .ping.bad { color: var(--red); } .ping.bad i { background: var(--red); }
  .top { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .players { display: flex; gap: 8px; }
  .pl { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; transition: opacity .3s, transform .3s; }
  .pl.out { opacity: .35; transform: scale(.9); }
  .av { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 14px; color: #05060d;
    background: var(--c); border: 2px solid rgba(255,255,255,.3); box-shadow: 0 0 14px var(--c); }
  .pl.me .av { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,.25), 0 0 18px var(--c); }
  .sc { font-size: 13px; font-weight: 700; color: #fff; text-shadow: 0 1px 4px #000; font-variant-numeric: tabular-nums; }
  .x { position: absolute; top: -4px; left: 50%; transform: translateX(-50%); font-size: 30px; font-weight: 900; color: var(--pink); text-shadow: 0 0 10px var(--pink), 0 0 2px #000; line-height: 36px; }
  .banner { font-size: 13px; letter-spacing: .12em; padding: 5px 16px; border-radius: 999px; background: rgba(8,10,22,.62); border: 1px solid var(--line); backdrop-filter: blur(8px); white-space: nowrap; }
  .clock { font-family: var(--font-display); font-size: 30px; font-weight: 700; color: #fff; text-shadow: 0 0 16px rgba(157,255,79,.6); }
  .tr { position: absolute; top: 14px; right: 16px; display: flex; gap: 8px; align-items: center; margin-right: 92px; }
  .tr .btn-icon svg { width: 14px; height: 14px; }
  .fight { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); font-family: var(--font-display); font-weight: 700;
    font-size: clamp(56px, 11vw, 120px); letter-spacing: .04em; color: #ff3d63; text-shadow: 0 0 28px rgba(255,61,99,.75), 0 6px 0 rgba(0,0,0,.35);
    white-space: nowrap; }
  .hint { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); font-size: 12px; color: var(--muted); padding: 8px 14px; border-radius: 999px; background: rgba(8,10,22,.55); border: 1px solid var(--line); display: flex; gap: 5px; align-items: center; white-space: nowrap; }
  @media (max-width: 640px) {
    .tr { margin-right: 44px; }
    .av { width: 28px; height: 28px; font-size: 12px; }
    .players { gap: 5px; }
    .hint { display: none; }
    .top { top: 56px; }
  }
</style>
