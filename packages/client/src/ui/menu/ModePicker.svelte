<script lang="ts">
  import { ROOM_MODES, type RoomMode } from "@lss/shared";
  import { tr, modeSummaryText } from "../../app/i18n";

  let { mode, rounds, editable, onMode, onRounds }:
    { mode: string; rounds: number; editable: boolean; onMode: (m: RoomMode) => void; onRounds: (n: number) => void } = $props();

  const ICON: Record<string, string> = { rounds: "🎯", wins: "🏆", infinite: "♾️", koth: "⛰️", orbking: "🔮" };
  const summary = $derived.by(() => { void $tr; return modeSummaryText(mode, rounds); });
</script>

<div class="mode">
  <p class="label">{$tr("room.modeLabel")}</p>
  <div class="grid" class:readonly={!editable}>
    {#each ROOM_MODES as m}
      <button class="m" class:selected={m === mode} disabled={!editable && m !== mode} title={$tr("mode." + m + "Desc")} onclick={() => editable && onMode(m)}>
        <span class="i">{ICON[m]}</span><span class="n">{$tr("mode." + m)}</span>
      </button>
    {/each}
  </div>
  <p class="summary">{summary}</p>
  {#if mode === "rounds" || mode === "wins"}
    <div class="rounds">
      {#if editable}<button class="btn btn-ghost btn-sm" aria-label="-" onclick={() => onRounds(Math.max(1, rounds - 1))}>−</button>{/if}
      <span class="num">{rounds}</span><span class="muted">{rounds === 1 ? $tr("word.round") : $tr("word.rounds")}</span>
      {#if editable}<button class="btn btn-ghost btn-sm" aria-label="+" onclick={() => onRounds(Math.min(20, rounds + 1))}>+</button>{/if}
    </div>
  {/if}
</div>

<style>
  .mode { display: flex; flex-direction: column; gap: 8px; }
  .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
  .m { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 10px; background: rgba(16,20,40,.65); border: 1px solid var(--line); transition: all .15s; }
  .m:hover:not(:disabled) { border-color: var(--line-2); transform: translateY(-1px); }
  .m.selected { border-color: var(--cyan); box-shadow: inset 0 0 0 1px var(--cyan), 0 0 18px rgba(53,240,224,.15); }
  .m:disabled { opacity: .35; }
  .readonly .m.selected { opacity: 1; }
  .i { font-size: 20px; }
  .n { font-size: 11px; font-weight: 600; text-align: center; line-height: 1.2; }
  .m.selected .n { color: var(--cyan); }
  .summary { margin: 0; font-size: 13px; color: var(--muted); }
  .rounds { display: flex; align-items: center; gap: 10px; justify-content: center; }
  .num { font-family: var(--font-display); font-size: 28px; font-weight: 700; min-width: 30px; text-align: center; }
  @media (max-width: 480px) { .grid { grid-template-columns: repeat(3, 1fr); } }
</style>
