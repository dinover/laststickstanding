<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { MAX_PLAYERS } from "@lss/shared";
  import { tr } from "../../app/i18n";
  import { errors } from "../../app/ui";
  import {
    couch, localMode, localRounds, padState, addLocalPlayer, removeLocalPlayer, renameLocalPlayer, hasKb, usedPads, startLocalMatch,
  } from "../../app/local";
  import { input } from "../../game/input";
  import { go } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import ModePicker from "./ModePicker.svelte";
  import { icons } from "../icons";

  let pads = $state<number[]>([]);
  let timer: number;
  /* Chrome no lista un mando recién enchufado hasta que se aprieta un botón: hay que re-consultar. */
  onMount(() => {
    const poll = () => { pads = input.connectedPads(); };
    poll();
    timer = window.setInterval(poll, 700);
  });
  onDestroy(() => clearInterval(timer));

  const free = $derived.by(() => { void $couch; return pads.filter((i) => !usedPads().includes(i)); });
  const full = $derived($couch.length >= MAX_PLAYERS);
  const kb1 = $derived.by(() => { void $couch; return hasKb(1); });
  const kb2 = $derived.by(() => { void $couch; return hasKb(2); });

  function srcLabel(p: (typeof $couch)[number]) {
    if (p.source.type === "kb") return { ico: icons.keyboard, txt: $tr("local.keyboard", { n: p.source.slot }) };
    if (p.source.type === "gp") return { ico: icons.gamepad, txt: $tr("local.gamepad", { n: p.source.index + 1 }) };
    return { ico: icons.phone, txt: $tr(p.padOff ? "local.phoneOff" : "local.phone") };
  }
  function add(fn: () => void) { audio.on.uiClick(); fn(); }
</script>

<div class="card panel">
  <ModePicker mode={$localMode} rounds={$localRounds} editable={true} onMode={(m) => { audio.on.uiClick(); localMode.set(m); }} onRounds={(n) => localRounds.set(n)} />

  <div class="roster-head"><span class="label">{$tr("local.addPlayers")}</span><span class="count">{$couch.length}/8</span></div>
  <div class="roster">
    {#each $couch as p (p.id)}
      {@const s = srcLabel(p)}
      <div class="row" class:off={p.padOff}>
        <span class="dot" style="color:{p.color};background:{p.color}"></span>
        <input value={p.name} maxlength="14" onchange={(e) => renameLocalPlayer(p.id, (e.target as HTMLInputElement).value)} />
        <span class="src"><span class="si">{@html s.ico}</span>{s.txt}</span>
        <button class="rm" aria-label="x" onclick={() => { audio.on.uiBack(); removeLocalPlayer(p.id); }}>{@html icons.x}</button>
      </div>
    {:else}
      <div class="empty muted">{$tr("local.needTwo")}</div>
    {/each}
  </div>

  {#if full}
    <div class="muted small">{$tr("local.full")}</div>
  {:else}
    <div class="adds">
      {#if !kb1}<button class="add" onclick={() => add(() => addLocalPlayer({ type: "kb", slot: 1 }))}><span class="si">{@html icons.keyboard}</span>{$tr("local.addKeyboard", { n: 1 })}</button>{/if}
      {#if !kb2}<button class="add" onclick={() => add(() => addLocalPlayer({ type: "kb", slot: 2 }))}><span class="si">{@html icons.keyboard}</span>{$tr("local.addKeyboard", { n: 2 })}</button>{/if}
      {#each free as idx}
        <button class="add" onclick={() => add(() => addLocalPlayer({ type: "gp", index: idx }))}><span class="si">{@html icons.gamepad}</span>{$tr("local.addGamepad", { n: idx + 1 })}</button>
      {/each}
      <button class="add phone" onclick={() => go("pad")}>{$tr("pad.open")}</button>
    </div>
  {/if}
  {#if $padState.open}
    <div class="muted small">{$tr("pad.roomHint", { code: $padState.code || "----" })} · {$padState.peers.filter((p) => p.connected).length
      ? $tr($padState.peers.filter((p) => p.connected).length === 1 ? "pad.count" : "pad.countN", { n: $padState.peers.filter((p) => p.connected).length })
      : $tr("pad.none")}</div>
  {/if}

  <button class="btn btn-primary btn-block" disabled={$couch.length < 2} onclick={() => { audio.on.uiClick(); startLocalMatch(); }}>{$tr("common.startMatch")}</button>
  <div class="err">{$errors.local}</div>
  <p class="hint">{@html $tr("local.hint")}</p>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 12px; width: min(560px, 100%); }
  .roster-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .count { font-size: 12px; color: var(--muted); flex: none; }
  .roster { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 10px; background: rgba(16,20,40,.55); border: 1px solid var(--line); animation: pop .25s ease; }
  .row.off { opacity: .5; }
  .row input { flex: 1; min-width: 0; padding: 7px 9px; font-size: 13px; }
  .src { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .si { width: 15px; height: 15px; display: inline-flex; }
  .rm { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--line); color: var(--red); display: grid; place-items: center; padding: 6px; flex: none; }
  .rm:hover { border-color: var(--red); }
  .empty { font-size: 13px; padding: 8px 2px; }
  .adds { display: flex; flex-wrap: wrap; gap: 6px; }
  .add { display: inline-flex; align-items: center; gap: 6px; padding: 8px 11px; font-size: 12px; font-weight: 600; color: var(--cyan); border: 1px dashed var(--line-2); border-radius: 10px; transition: all .15s; }
  .add:hover { border-style: solid; border-color: var(--cyan); background: rgba(53,240,224,.06); }
  .small { font-size: 12px; }
  .hint { margin: 0; font-size: 11px; color: var(--dim); line-height: 1.6; }
  @keyframes pop { from { transform: scale(.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
</style>
