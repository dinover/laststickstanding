<script lang="ts">
  /* Entrenamiento: rival (dificultad) y bioma en una sola pantalla (en V1 eran dos pasos). */
  import { onMount } from "svelte";
  import { BIOME_IDS, type BiomeId, type BotDifficultyId } from "@lss/shared";
  import { tr } from "../../app/i18n";
  import { startPractice } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import { drawBackgroundThumb } from "../../render/art/world";

  let diff = $state<BotDifficultyId>("medium");
  let biome = $state<BiomeId | "">("");
  const diffs: { id: BotDifficultyId; ico: string }[] = [{ id: "easy", ico: "🙂" }, { id: "medium", ico: "😤" }, { id: "hard", ico: "💀" }];
  const canvases: Record<string, HTMLCanvasElement> = {};

  onMount(() => {
    for (const id of BIOME_IDS) {
      const c = canvases[id];
      if (!c) continue;
      c.width = 192; c.height = 108;
      drawBackgroundThumb(c.getContext("2d")!, id, 7, 192, 108);
    }
  });

  function pick(d: BotDifficultyId) { diff = d; audio.on.uiClick(); }
  function pickBiome(b: BiomeId | "") { biome = b; audio.on.uiClick(); }
</script>

<div class="card panel">
  <p class="label">{$tr("practice.pickDiff")}</p>
  <div class="diffs">
    {#each diffs as d}
      <button class="option" class:selected={diff === d.id} onclick={() => pick(d.id)}>
        <span class="ico">{d.ico}</span>
        <span><strong>{$tr("practice." + d.id)}</strong><span class="desc">{$tr("practice." + d.id + "Desc")}</span></span>
      </button>
    {/each}
  </div>
  <p class="label">{$tr("practice.pickMap")}</p>
  <div class="themes">
    <button class="theme" class:selected={biome === ""} onclick={() => pickBiome("")}>
      <span class="thumb dice">🎲</span><span class="lbl">{$tr("theme.random")}</span>
    </button>
    {#each BIOME_IDS as b}
      <button class="theme" class:selected={biome === b} onclick={() => pickBiome(b)}>
        <canvas class="thumb" bind:this={canvases[b]}></canvas><span class="lbl">{$tr("biome." + b)}</span>
      </button>
    {/each}
  </div>
  <button class="btn btn-primary btn-block" onclick={() => { audio.on.uiClick(); startPractice(diff, biome || null); }}>{$tr("practice.start")}</button>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 10px; width: min(520px, 100%); }
  .diffs { display: flex; flex-direction: column; gap: 8px; }
  .themes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 6px; }
  .theme { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: rgba(16,20,40,.6); padding: 0; transition: border-color .15s, transform .12s; }
  .theme:hover { transform: translateY(-2px); border-color: var(--line-2); }
  .theme.selected { border-color: var(--cyan); box-shadow: inset 0 0 0 1px var(--cyan); }
  .thumb { display: block; width: 100%; aspect-ratio: 16 / 9; }
  .dice { display: grid; place-items: center; font-size: 26px; background: linear-gradient(135deg, #1c1330, #26293e); }
  .lbl { display: block; padding: 6px 4px; font-size: 12px; }
  .theme.selected .lbl { color: var(--cyan); }
</style>
