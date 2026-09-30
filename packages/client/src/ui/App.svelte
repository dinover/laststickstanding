<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { engine } from "../game/engine";
  import { SimSession } from "../game/session";
  import { input } from "../game/input";
  import { playing, menuScreen, finalScreen, storyMsg, crawl, hud } from "../app/ui";
  import { lang, t } from "../app/i18n";
  import { wireNet, resumeOnlineIfSaved, hudEnd, leaveOnlineRoom } from "../app/actions";
  import { restoreSession, startProfileSync } from "../services/supabase";
  import Menu from "./menu/Menu.svelte";
  import Hud from "./hud/Hud.svelte";
  import TopBar from "./TopBar.svelte";
  import FinalScreen from "./overlays/FinalScreen.svelte";
  import Overlays from "./overlays/Overlays.svelte";
  import PauseMenu from "./overlays/PauseMenu.svelte";

  let stage: HTMLDivElement;
  let ready = $state(false);
  let paused = $state(false);
  let joinCode = $state("");

  onMount(async () => {
    const params = new URLSearchParams(location.search);
    const code = (params.get("join") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    await engine.init(stage);
    ready = true;
    wireNet();
    resumeOnlineIfSaved();
    startProfileSync();
    void restoreSession();
    if (code.length === 4) {
      joinCode = code;
      menuScreen.set("join");
      history.replaceState(null, "", location.pathname);
    }
  });

  function setPaused(on: boolean) {
    paused = on;
    const s = engine.session;
    if (s instanceof SimSession) s.paused = on;
    input.active = !on && get(playing);
    if (on) input.releaseAll();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !$playing || $finalScreen || $storyMsg || $crawl) return;
    setPaused(!paused);
  }

  function quit() {
    setPaused(false);
    const s = engine.session;
    if (s && s.kind === "online") leaveOnlineRoom();
    else hudEnd();
  }

  $effect(() => { if (!$playing && paused) setPaused(false); });
  // re-render reactivo del idioma en toda la app
  $effect(() => { void $lang; });
</script>

<svelte:window onkeydown={onKey} />

<div class="stage" bind:this={stage}></div>
{#if ready}
  {#if !$playing}<Menu {joinCode} />{/if}
  {#if $playing}<Hud onPause={() => setPaused(true)} />{/if}
  <TopBar />
  <FinalScreen />
  <Overlays />
  {#if paused}
    <PauseMenu online={engine.session?.kind === "online"} endLabel={engine.session?.kind === "online" ? t("final.backMenu") : ($hud.endLabel || t("final.backMenu"))}
      onResume={() => setPaused(false)} onQuit={quit} />
  {/if}
{:else}
  <div class="boot"><div class="boot-logo">LAST STICK <span>STANDING</span></div><div class="bar"></div></div>
{/if}

<style>
  .stage { position: absolute; inset: 0; }
  .boot { position: absolute; inset: 0; display: grid; place-content: center; gap: 18px; text-align: center; }
  .boot-logo { font-family: var(--font-display); font-size: 40px; font-weight: 700; letter-spacing: .04em; }
  .boot-logo span { color: var(--cyan); }
  .bar { height: 3px; width: 200px; margin: 0 auto; border-radius: 3px; background: linear-gradient(90deg, transparent, var(--cyan), transparent); background-size: 200% 100%; animation: load 1.2s linear infinite; }
  @keyframes load { from { background-position: 200% 0; } to { background-position: -200% 0; } }
</style>
