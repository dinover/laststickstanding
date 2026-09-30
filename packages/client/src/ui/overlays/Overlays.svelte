<script lang="ts">
  /* Pantallas superpuestas: mensajes de las campañas, crawl final, reconexión y avisos. */
  import { fade, fly, scale } from "svelte/transition";
  import { backOut } from "svelte/easing";
  import { crawl, reconnect, storyMsg, toast } from "../../app/ui";
  import { tr } from "../../app/i18n";
  import { giveUpReconnect } from "../../app/actions";
  import { audio } from "../../audio/audio";

  let toastVisible = $state(false);
  $effect(() => {
    if (!$toast) return;
    toastVisible = true;
    const t = setTimeout(() => (toastVisible = false), 2200);
    return () => clearTimeout(t);
  });

  $effect(() => {
    const c = $crawl;
    if (!c) return;
    const t = setTimeout(() => c.onEnd(), 42000);
    return () => clearTimeout(t);
  });

  function onKey(e: KeyboardEvent) {
    if ($storyMsg && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); audio.on.uiClick(); $storyMsg.onContinue(); }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if $storyMsg}
  <div class="msg ui-block" transition:fade={{ duration: 250 }} style="--c:{$storyMsg.accent || '#35f0e0'}">
    <div class="msg-card" in:scale={{ start: 0.92, duration: 350, easing: backOut }}>
      <h1>{$storyMsg.title}</h1>
      <p>{$storyMsg.body}</p>
      <button class="btn btn-primary" onclick={() => { audio.on.uiClick(); $storyMsg?.onContinue(); }}>{$storyMsg.button}</button>
    </div>
  </div>
{/if}

{#if $crawl}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="crawl ui-block" transition:fade={{ duration: 400 }} onclick={() => $crawl?.onEnd()}>
    <div class="vp">
      <div class="txt">
        <h1>{$tr("saga.crawlTitle")}</h1>
        <p>{$tr("saga.crawlBody")}</p>
      </div>
    </div>
    <div class="skip">{$tr("saga.crawlHint")}</div>
  </div>
{/if}

{#if $reconnect}
  <div class="rec ui-block" transition:fade={{ duration: 200 }}>
    {#if !$reconnect.gaveUp}<div class="spin"></div>{/if}
    <h2>{$tr("rec.title")}</h2>
    <p>{$reconnect.msg}</p>
    {#if $reconnect.gaveUp}<button class="btn btn-ghost" onclick={giveUpReconnect}>{$tr("rec.backHome")}</button>{/if}
  </div>
{/if}

{#if toastVisible && $toast}
  {#key $toast.id}
    <div class="toast" in:fly={{ y: 20, duration: 250 }} out:fade={{ duration: 200 }}>{$toast.text}</div>
  {/key}
{/if}

<style>
  .msg { position: absolute; inset: 0; z-index: 26; display: grid; place-items: center; padding: 20px;
    background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--c) 14%, transparent), transparent 60%), rgba(5,6,13,.82); backdrop-filter: blur(5px); }
  .msg-card { max-width: 520px; text-align: center; display: flex; flex-direction: column; gap: 16px; align-items: center; }
  .msg h1 { margin: 0; font-family: var(--font-display); font-size: clamp(30px, 5vw, 44px); letter-spacing: .04em; color: var(--c); text-shadow: 0 0 22px color-mix(in srgb, var(--c) 60%, transparent); }
  .msg p { margin: 0; font-size: 16px; line-height: 1.65; color: var(--text); }
  .crawl { position: absolute; inset: 0; z-index: 27; background: #05060d; overflow: hidden; cursor: pointer; }
  .vp { position: absolute; inset: 0; perspective: 700px; perspective-origin: 50% 100%; overflow: hidden; }
  .txt { position: absolute; left: 50%; bottom: -20%; width: 620px; max-width: 84vw; transform: translateX(-50%) rotateX(30deg); transform-origin: 50% 100%;
    text-align: center; color: #ffc247; text-shadow: 0 0 12px rgba(255,194,71,.35); animation: crawl 42s linear forwards; }
  .txt h1 { font-family: var(--font-display); font-size: 40px; letter-spacing: .05em; margin: 0 0 26px; }
  .txt p { font-size: 21px; line-height: 1.85; margin: 0; }
  .skip { position: absolute; left: 0; right: 0; bottom: 18px; text-align: center; color: var(--dim); font-size: 12px; }
  @keyframes crawl { from { bottom: -20%; opacity: 1; } 65% { opacity: 1; } to { bottom: 68%; opacity: 0; } }
  .rec { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    background: rgba(5,6,13,.88); backdrop-filter: blur(4px); text-align: center; padding: 20px; }
  .rec h2 { margin: 0; color: var(--gold); letter-spacing: .1em; font-size: 22px; }
  .rec p { margin: 0; color: var(--muted); font-size: 14px; }
  .spin { width: 38px; height: 38px; border-radius: 50%; border: 3px solid rgba(255,194,71,.2); border-top-color: var(--gold); animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%); z-index: 45; padding: 10px 18px; border-radius: 999px;
    background: rgba(12,16,34,.92); border: 1px solid rgba(53,240,224,.4); color: #fff; font-weight: 600; font-size: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.4); pointer-events: none; }
</style>
