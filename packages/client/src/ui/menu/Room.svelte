<script lang="ts">
  import { tr } from "../../app/i18n";
  import { errors, showToast } from "../../app/ui";
  import { room, net } from "../../net/net";
  import { setRoomMode, setRoomRounds, startRoomMatch } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import ModePicker from "./ModePicker.svelte";
  import { icons, HAT_GLYPHS } from "../icons";

  const isOwner = $derived($room.myId !== null && $room.myId === $room.owner);
  const link = $derived(location.origin + "/?join=" + ($room.code || ""));

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); showToast($tr("common.copied")); } catch { /* sin permiso */ }
  }
  async function share() {
    const data = { title: "Last Stick Standing", text: $tr("room.share") + " " + $room.code, url: link };
    if (navigator.share) { try { await navigator.share(data); return; } catch { /* cancelado */ } }
    copy(link);
  }
</script>

<div class="card panel">
  <p class="label">{$tr("room.share")}</p>
  <div class="code-row">
    <div class="code">{$room.code || "----"}</div>
    <div class="code-actions">
      <button class="btn-icon" title={$tr("common.copy")} onclick={() => copy($room.code || "")}>{@html icons.copy}</button>
      <button class="btn-icon" title={$tr("common.share")} onclick={share}>{@html icons.share}</button>
    </div>
  </div>

  <div class="roster-head"><span class="label">{$tr("room.players")}</span><span class="count">{$room.players.length}/8</span></div>
  <div class="roster" class:wide={$room.players.length > 4}>
    {#each $room.players as p (p.id)}
      <div class="row" class:gone={!p.connected} class:me={p.id === $room.myId}>
        <span class="dot" style="color:{p.color};background:{p.color}"></span>
        <span class="nm">{p.name}</span>
        {#if p.hat !== "none"}<span class="hat">{HAT_GLYPHS[p.hat]}</span>{/if}
        {#if p.id === $room.owner}<span class="tag host">{$tr("room.hostTag")}</span>{/if}
        {#if !p.connected}<span class="tag gone">{$tr("room.goneTag")}</span>{/if}
      </div>
    {/each}
  </div>

  <ModePicker mode={$room.mode} rounds={$room.rounds} editable={isOwner} onMode={(m) => { audio.on.uiClick(); setRoomMode(m); }} onRounds={(n) => { audio.on.uiClick(); setRoomRounds(n); }} />

  {#if isOwner}
    <button class="btn btn-primary btn-block start" onclick={() => { audio.on.uiClick(); startRoomMatch(); }}>{$tr("common.startMatch")}</button>
  {:else}
    <p class="wait">{$tr("room.waitOwner")}</p>
  {/if}
  <p class="hint">{$tr("room.hint")}</p>
  <div class="err">{$errors.room}</div>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 12px; width: min(520px, 100%); }
  .code-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .code { font-family: var(--font-display); font-size: 52px; font-weight: 700; letter-spacing: .22em; color: var(--cyan); text-shadow: 0 0 24px rgba(53,240,224,.45); line-height: 1; }
  .code-actions { display: flex; gap: 8px; }
  .roster-head { display: flex; justify-content: space-between; align-items: center; }
  .count { font-size: 12px; color: var(--muted); }
  .roster { display: flex; flex-direction: column; gap: 6px; }
  .roster.wide { display: grid; grid-template-columns: 1fr 1fr; }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(16,20,40,.55); border: 1px solid var(--line); min-width: 0; animation: pop .25s ease; }
  .row.me { border-color: rgba(53,240,224,.35); }
  .row.gone { opacity: .5; }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .hat { font-size: 14px; }
  .tag { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 2px 6px; border-radius: 999px; }
  .tag.host { color: var(--gold); border: 1px solid rgba(255,194,71,.4); }
  .tag.gone { color: var(--red); }
  .start { margin-top: 4px; font-size: 16px; padding: 15px; }
  .wait { margin: 0; text-align: center; color: var(--muted); font-size: 13px; }
  .hint { margin: 0; font-size: 11px; color: var(--dim); line-height: 1.5; }
  @keyframes pop { from { transform: scale(.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
</style>
