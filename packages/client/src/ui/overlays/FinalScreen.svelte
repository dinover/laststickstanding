<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { backOut } from "svelte/easing";
  import { finalScreen } from "../../app/ui";
  import { tr } from "../../app/i18n";
  import { rematch, finalChangeMode, finalBackToMenu } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import StickPreview from "../StickPreview.svelte";
</script>

{#if $finalScreen}
  {@const f = $finalScreen}
  <div class="final ui-block" transition:fade={{ duration: 300 }}>
    <div class="glow" style="--c:{f.winnerColor}"></div>
    <div class="content">
      {#if f.winnerId !== null}
        <div class="dance" in:fly={{ y: 30, duration: 500, easing: backOut }}>
          <StickPreview color={f.winnerColor} hat={f.winnerHat} mode="dance" width={300} height={180} scale={1.35} feetY={160} />
        </div>
      {/if}
      <h1 in:fly={{ y: -20, duration: 450, delay: 100, easing: backOut }} style="--c:{f.winnerColor}">{f.title}</h1>
      <div class="ranking">
        {#each f.rows as r, i (r.id)}
          <div class="row" class:win={i === 0} in:fly={{ x: -30, duration: 350, delay: 250 + i * 80 }}>
            <span class="pos">#{i + 1}</span>
            <span class="dot" style="color:{r.color};background:{r.color}"></span>
            <span class="nm">{r.name}</span>
            <span class="sc">{r.score} {f.unit}</span>
          </div>
        {/each}
      </div>
      <div class="actions">
        {#if f.canRematch}
          <button class="btn btn-primary" onclick={() => { audio.on.uiClick(); rematch(); }}>{$tr("final.playAgain")}</button>
        {:else}
          <p class="wait">{$tr("final.waitHost")}</p>
        {/if}
        {#if f.showChangeMode}<button class="btn btn-ghost" onclick={() => { audio.on.uiBack(); finalChangeMode(); }}>{$tr("final.changeMode")}</button>{/if}
        {#if f.showBackMenu}<button class="btn btn-ghost" onclick={() => { audio.on.uiBack(); finalBackToMenu(); }}>{$tr("final.backMenu")}</button>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .final { position: absolute; inset: 0; z-index: 25; display: grid; place-items: center; background: rgba(5,6,13,.78); backdrop-filter: blur(6px); overflow-y: auto; }
  .glow { position: absolute; inset: 0; background: radial-gradient(circle at 50% 28%, color-mix(in srgb, var(--c) 22%, transparent), transparent 55%); pointer-events: none; }
  .content { position: relative; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 24px 16px; width: min(460px, 100%); }
  .dance { margin-bottom: -18px; }
  h1 { margin: 0; font-family: var(--font-display); font-size: clamp(34px, 6vw, 52px); letter-spacing: .03em; text-align: center; color: #fff;
    text-shadow: 0 0 26px var(--c), 0 4px 0 rgba(0,0,0,.3); }
  .ranking { display: flex; flex-direction: column; gap: 7px; width: 100%; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: rgba(16,20,40,.7); border: 1px solid var(--line); }
  .row.win { border-color: var(--gold); box-shadow: 0 0 22px rgba(255,194,71,.22); background: linear-gradient(90deg, rgba(255,194,71,.12), rgba(16,20,40,.7)); }
  .pos { color: var(--dim); width: 26px; font-weight: 700; }
  .row.win .pos { color: var(--gold); }
  .dot { width: 16px; height: 16px; }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc { color: var(--cyan); font-weight: 700; font-variant-numeric: tabular-nums; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
  .wait { color: var(--muted); font-size: 13px; margin: 0; }
</style>
