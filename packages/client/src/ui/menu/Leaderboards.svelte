<script lang="ts">
  import { onMount } from "svelte";
  import { tr } from "../../app/i18n";
  import { leaderboards, refreshAllBoards, formatRunTime, type Board } from "../../services/supabase";
  import { icons } from "../icons";

  onMount(() => refreshAllBoards());

  const lss: { board: Board; key: string }[] = [
    { board: "lss_easy", key: "practice.easy" },
    { board: "lss_medium", key: "practice.medium" },
    { board: "lss_hard", key: "practice.hard" },
    { board: "lss_hardcore", key: "story.hardcore" },
  ];
</script>

<div class="lb panel">
  <div class="head"><span class="ico">{@html icons.trophy}</span><span>{$tr("lb.title")}</span></div>
  <p class="label">{$tr("lb.sagaTitle")}</p>
  {@render board("saga", null)}
  <p class="label">{$tr("lb.lssTitle")}</p>
  <div class="grid">
    {#each lss as b}
      {@render board(b.board, b.key)}
    {/each}
  </div>
</div>

{#snippet board(id: Board, key: string | null)}
  <div class="board">
    {#if key}<h4>{$tr(key)}</h4>{/if}
    <ol>
      {#if $leaderboards[id] === undefined}
        {#each [0, 1, 2] as i}<li class="skel" style="opacity:{0.6 - i * 0.15}"></li>{/each}
      {:else if $leaderboards[id] === null}
        <li class="empty">{$tr("lb.empty")}</li>
      {:else if $leaderboards[id]!.length === 0}
        <li class="empty">{$tr("lb.none")}</li>
      {:else}
        {#each $leaderboards[id]! as row, i}
          <li><span class="pos p{i}">{i + 1}</span><span class="nm">{row.name}</span><span class="tm">{formatRunTime(row.time_ms)}</span></li>
        {/each}
      {/if}
    </ol>
  </div>
{/snippet}

<style>
  .lb { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .head { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: .06em; color: var(--gold); }
  .head .ico { width: 20px; height: 20px; display: inline-flex; }
  .label { margin: 4px 0 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .board { background: rgba(16,20,40,.6); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; }
  h4 { margin: 0 0 5px; font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: .05em; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; align-items: center; gap: 7px; font-size: 12px; min-height: 18px; }
  li.skel { background: rgba(255,255,255,.06); border-radius: 4px; height: 14px; }
  li.empty { color: var(--dim); font-style: italic; }
  .pos { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; background: rgba(255,255,255,.08); flex: none; }
  .pos.p0 { background: var(--gold); color: #1a1200; }
  .pos.p1 { background: #cfd6e8; color: #111; }
  .pos.p2 { background: #c98a55; color: #1a0d00; }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tm { color: var(--cyan); font-variant-numeric: tabular-nums; }
</style>
