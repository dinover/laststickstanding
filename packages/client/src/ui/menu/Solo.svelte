<script lang="ts">
  import { tr } from "../../app/i18n";
  import { sagaState, storyState } from "../../app/persist";
  import { go, startSaga, startStory } from "../../app/actions";
  import { audio } from "../../audio/audio";

  function story() {
    audio.on.uiClick();
    if ($storyState.run) startStory($storyState.run.difficulty, true);
    else go("storyDiff");
  }
  function saga() {
    audio.on.uiClick();
    startSaga(!!$sagaState.run);
  }
</script>

<div class="card panel">
  <h2>{$tr("solo.pick")}</h2>
  <button class="option" onclick={() => go("practiceDiff")}>
    <span class="ico">🥊</span>
    <span><strong>{$tr("solo.training")}</strong><span class="desc">{$tr("solo.trainingDesc")}</span></span>
  </button>
  <button class="option" onclick={saga}>
    <span class="ico">📜</span>
    <span>
      <strong>{$tr("solo.saga")}{#if $sagaState.run}<em class="resume">{$tr("solo.resume")}</em>{/if}</strong>
      <span class="desc">{$tr("solo.sagaDesc")}</span>
    </span>
  </button>
  <button class="option" onclick={story}>
    <span class="ico">🏆</span>
    <span>
      <strong>{$tr("solo.story")}{#if $storyState.run}<em class="resume">{$tr("solo.resume")}</em>{/if}</strong>
      <span class="desc">{$tr("solo.storyDesc")}</span>
    </span>
  </button>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 10px; width: min(460px, 100%); }
  h2 { margin: 0 0 6px; font-size: 16px; font-weight: 600; color: var(--muted); }
  .resume { font-style: normal; font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--gold); margin-left: 8px; padding: 2px 7px; border: 1px solid rgba(255,194,71,.4); border-radius: 999px; }
</style>
