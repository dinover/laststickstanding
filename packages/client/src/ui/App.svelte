<script lang="ts">
  import { onMount } from "svelte";
  import { engine } from "../game/engine";
  import { PracticeSession } from "../game/sessions/practice";
  import { playing } from "../app/ui";

  let stage: HTMLDivElement;

  onMount(async () => {
    await engine.init(stage);
  });

  function practice() {
    engine.start(new PracticeSession(engine, "medium", null));
  }
</script>

<div class="stage" bind:this={stage}></div>
{#if !$playing}
  <div style="position:absolute;left:20px;top:20px;z-index:5">
    <button class="btn btn-primary" onclick={practice}>Práctica</button>
  </div>
{/if}

<style>
  .stage { position: absolute; inset: 0; }
</style>
