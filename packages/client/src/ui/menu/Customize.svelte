<script lang="ts">
  import { ACCESSORY_IDS, PLAYER_COLORS, type AccessoryId } from "@lss/shared";
  import { get } from "svelte/store";
  import { tr, t } from "../../app/i18n";
  import { profile, accessoryLock, storyState } from "../../app/persist";
  import { go } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import StickPreview from "../StickPreview.svelte";
  import { HAT_GLYPHS } from "../icons";

  const start = get(profile);
  let name = $state(start.name);
  let color = $state(start.color || PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]);
  let hat = $state<AccessoryId>(start.hat);
  let hovered = $state<AccessoryId | null>(null);
  // re-evaluar candados si cambia el progreso (p.ej. al loguearse)
  const locks = $derived.by(() => { void $storyState; return Object.fromEntries(ACCESSORY_IDS.map((id) => [id, accessoryLock(id)])); });

  function save() {
    audio.on.uiClick();
    profile.set({ name: name.trim() || t("player.default"), color, hat });
    go("home");
  }

  const hatLabel = $derived.by(() => {
    const id = hovered || hat;
    const lock = locks[id];
    return lock ? $tr(lock.hintKey) : $tr("hat." + id);
  });
</script>

<div class="card panel">
  <p class="label">{$tr("lobby.customizeSub")}</p>
  <div class="top">
    <div class="preview">
      {#key color + hat}
        <StickPreview {color} {hat} width={170} height={190} scale={1.9} feetY={168} />
      {/key}
    </div>
    <div class="fields">
      <input bind:value={name} maxlength="14" placeholder={$tr("lobby.yourName")} />
      <p class="label">{$tr("lobby.colorLabel")}</p>
      <div class="swatches">
        {#each PLAYER_COLORS as c}
          <button class="swatch" class:selected={c === color} style="--c:{c}" title={c} aria-label={c} onclick={() => { color = c; audio.on.uiHover(); }}></button>
        {/each}
      </div>
    </div>
  </div>
  <p class="label">{$tr("lobby.hatLabel")}</p>
  <div class="hats">
    {#each ACCESSORY_IDS as id}
      {@const lock = locks[id]}
      <button class="hat" class:selected={id === hat} class:locked={!!lock} disabled={!!lock}
        onmouseenter={() => (hovered = id)} onmouseleave={() => (hovered = null)} onfocus={() => (hovered = id)}
        onclick={() => { hat = id; audio.on.uiHover(); }} title={lock ? $tr(lock.hintKey) : $tr("hat." + id)}>
        {lock && lock.mystery ? "🔒" : HAT_GLYPHS[id]}
      </button>
    {/each}
  </div>
  <div class="hat-name">{hatLabel}</div>
  <button class="btn btn-primary btn-block" onclick={save}>{$tr("lobby.save")}</button>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 10px; width: min(520px, 100%); }
  .top { display: flex; gap: 16px; align-items: center; }
  .preview { flex: none; border-radius: 14px; background: radial-gradient(circle at 50% 75%, rgba(53,240,224,.12), transparent 70%), rgba(6,8,18,.6); border: 1px solid var(--line); }
  .fields { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .swatch { width: 28px; height: 28px; border-radius: 50%; background: var(--c); border: 2px solid rgba(255,255,255,.15); box-shadow: 0 0 10px var(--c); transition: transform .12s; }
  .swatch:hover { transform: scale(1.12); }
  .swatch.selected { border-color: #fff; box-shadow: 0 0 0 3px rgba(255,255,255,.2), 0 0 14px var(--c); }
  .hats { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; }
  .hat { height: 44px; font-size: 20px; border-radius: 10px; background: rgba(16,20,40,.7); border: 1px solid var(--line); transition: transform .12s, border-color .15s; }
  .hat:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--line-2); }
  .hat.selected { border-color: var(--cyan); box-shadow: inset 0 0 0 1px var(--cyan); }
  .hat.locked { opacity: .35; }
  .hat-name { font-size: 12px; color: var(--muted); min-height: 16px; }
  @media (max-width: 480px) { .top { flex-direction: column; } .hats { grid-template-columns: repeat(4, 1fr); } }
</style>
