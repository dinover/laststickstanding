<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { tr } from "../../app/i18n";
  import { menuScreen, type MenuScreen } from "../../app/ui";
  import { go, leaveOnlineRoom } from "../../app/actions";
  import { closePadRoom } from "../../app/local";
  import { audio } from "../../audio/audio";
  import { icons } from "../icons";
  import Home from "./Home.svelte";
  import Solo from "./Solo.svelte";
  import PracticeSetup from "./PracticeSetup.svelte";
  import StoryDiff from "./StoryDiff.svelte";
  import Join from "./Join.svelte";
  import Customize from "./Customize.svelte";
  import Room from "./Room.svelte";
  import LocalSetup from "./LocalSetup.svelte";
  import PadCard from "./PadCard.svelte";

  let { joinCode = "" }: { joinCode?: string } = $props();

  const PARENT: Partial<Record<MenuScreen, MenuScreen>> = {
    solo: "home", practiceDiff: "solo", practiceTheme: "practiceDiff", storyDiff: "solo",
    customize: "home", join: "home", origin: "home", localSetup: "home", pad: "localSetup", room: "home",
  };

  function back() {
    audio.on.uiBack();
    const cur = $menuScreen;
    if (cur === "room") { leaveOnlineRoom(); return; }
    if (cur === "localSetup") closePadRoom();
    go(PARENT[cur] || "home");
  }

  const TITLES: Partial<Record<MenuScreen, string>> = {
    solo: "lobby.practice", practiceDiff: "solo.training", storyDiff: "solo.story", customize: "lobby.customizeTitle",
    join: "lobby.join", localSetup: "origin.local", pad: "pad.open", room: "hud.room",
  };
</script>

<div class="menu" in:fade={{ duration: 220 }} out:fade={{ duration: 160 }}>
  <div class="scrim"></div>
  <div class="inner scroll-thin">
    <header class:compact={$menuScreen !== "home"}>
      <h1 class="logo" aria-label="Last Stick Standing">
        <span class="l1">LAST STICK</span><span class="l2">STANDING</span>
      </h1>
      {#if $menuScreen === "home"}<p class="tag">{$tr("lobby.sub")}</p>{/if}
    </header>

    {#if $menuScreen !== "home"}
      <div class="nav">
        <button class="btn btn-ghost btn-sm backbtn" onclick={back}><span class="bi">{@html icons.back}</span>{$tr("lobby.back").replace("‹ ", "")}</button>
        {#if TITLES[$menuScreen]}<span class="title">{$tr(TITLES[$menuScreen]!)}</span>{/if}
      </div>
    {/if}

    {#key $menuScreen}
      <div class="screen" in:fly={{ x: 24, duration: 260, easing: cubicOut }}>
        {#if $menuScreen === "home"}<Home />
        {:else if $menuScreen === "solo"}<Solo />
        {:else if $menuScreen === "practiceDiff" || $menuScreen === "practiceTheme"}<PracticeSetup />
        {:else if $menuScreen === "storyDiff"}<StoryDiff />
        {:else if $menuScreen === "join"}<Join initial={joinCode} />
        {:else if $menuScreen === "customize"}<Customize />
        {:else if $menuScreen === "room"}<Room />
        {:else if $menuScreen === "localSetup" || $menuScreen === "origin"}<LocalSetup />
        {:else if $menuScreen === "pad"}<PadCard />
        {/if}
      </div>
    {/key}
    <footer class="foot">V2 · <a href="https://lss.leinonair.com" target="_blank" rel="noopener">lss.leinonair.com</a></footer>
  </div>
</div>

<style>
  .menu { position: absolute; inset: 0; z-index: 10; }
  .scrim {
    position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(90deg, rgba(5,6,13,.92) 0%, rgba(5,6,13,.72) 42%, rgba(5,6,13,.25) 75%, rgba(5,6,13,.1) 100%),
      radial-gradient(120% 90% at 0% 0%, rgba(53,240,224,.08), transparent 60%);
  }
  .inner { position: relative; height: 100%; overflow-y: auto; padding: clamp(18px, 4vh, 44px) clamp(16px, 5vw, 64px) 30px; display: flex; flex-direction: column; gap: 18px; }
  header { display: flex; flex-direction: column; gap: 6px; }
  .logo { margin: 0; font-family: var(--font-display); font-weight: 700; line-height: .86; letter-spacing: .02em; display: flex; flex-direction: column; user-select: none; }
  .l1 { font-size: clamp(34px, 6vw, 64px); color: #fff; text-shadow: 0 0 30px rgba(53,240,224,.35); }
  .l2 {
    font-size: clamp(46px, 8.4vw, 92px);
    background: linear-gradient(95deg, #35f0e0 0%, #7b6cff 45%, #ff2e88 90%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 0 22px rgba(123,108,255,.45));
    animation: sheen 6s ease-in-out infinite; background-size: 200% 100%;
  }
  header.compact .l1 { font-size: 26px; }
  header.compact .l2 { font-size: 34px; }
  .tag { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  .nav { display: flex; align-items: center; gap: 12px; }
  .backbtn { gap: 4px; padding-left: 8px; }
  .bi { width: 16px; height: 16px; display: inline-flex; }
  .title { font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 13px; color: var(--muted); }
  .screen { display: flex; }
  .foot { margin-top: auto; padding-top: 18px; font-size: 11px; color: var(--dim); }
  .foot a { color: var(--dim); }
  @keyframes sheen { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  @media (max-width: 860px) {
    .scrim { background: linear-gradient(180deg, rgba(5,6,13,.85), rgba(5,6,13,.7) 50%, rgba(5,6,13,.85)); }
  }
</style>
