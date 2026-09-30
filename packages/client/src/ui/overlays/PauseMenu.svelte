<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { tr } from "../../app/i18n";

  let { online, endLabel, onResume, onQuit }: { online: boolean; endLabel: string; onResume: () => void; onQuit: () => void } = $props();
</script>

<div class="pause ui-block" transition:fade={{ duration: 150 }}>
  <div class="card panel" in:scale={{ start: 0.94, duration: 200 }}>
    <h2>{$tr("hud.pause")}</h2>
    {#if online}<p class="muted">{$tr("room.hint")}</p>{/if}
    <button class="btn btn-primary btn-block" onclick={onResume}>{$tr("hud.resume")}</button>
    <button class="btn btn-danger btn-block" onclick={onQuit}>{endLabel}</button>
  </div>
</div>

<style>
  .pause { position: absolute; inset: 0; z-index: 28; display: grid; place-items: center; background: rgba(5,6,13,.6); backdrop-filter: blur(4px); }
  .card { padding: 24px; width: min(340px, 90vw); display: flex; flex-direction: column; gap: 12px; text-align: center; }
  h2 { margin: 0 0 4px; font-family: var(--font-display); font-size: 34px; letter-spacing: .06em; }
  p { margin: 0; font-size: 12px; line-height: 1.5; }
</style>
