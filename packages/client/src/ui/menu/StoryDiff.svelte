<script lang="ts">
  import { tr } from "../../app/i18n";
  import { storyState, type StoryDifficulty } from "../../app/persist";
  import { startStory } from "../../app/actions";
  import { audio } from "../../audio/audio";

  let diff = $state<StoryDifficulty>("easy");
  const list = $derived<{ id: StoryDifficulty; label: string; desc: string }[]>([
    { id: "easy", label: "practice.easy", desc: "story.easyDesc" },
    { id: "medium", label: "practice.medium", desc: "story.mediumDesc" },
    { id: "hard", label: "practice.hard", desc: "story.hardDesc" },
    ...($storyState.unlocks.clearedHard ? [{ id: "hardcore" as StoryDifficulty, label: "story.hardcore", desc: "story.hardcoreDesc" }] : []),
  ]);
</script>

<div class="card panel">
  <p class="label">{$tr("story.pickDiff")}</p>
  {#each list as d}
    <button class="option" class:selected={diff === d.id} class:hc={d.id === "hardcore"} onclick={() => { diff = d.id; audio.on.uiClick(); }}>
      <span class="ico">{d.id === "hardcore" ? "☠️" : d.id === "hard" ? "🔥" : d.id === "medium" ? "⚔️" : "🌱"}</span>
      <span><strong>{$tr(d.label)}</strong><span class="desc">{$tr(d.desc)}</span></span>
    </button>
  {/each}
  <button class="btn btn-primary btn-block" onclick={() => { audio.on.uiClick(); startStory(diff, false); }}>{$tr("story.start")}</button>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 9px; width: min(460px, 100%); }
  .hc strong { color: var(--pink); }
</style>
