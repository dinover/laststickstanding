<script lang="ts">
  /* Ticker de puntajes del modo infinito: tipea letra por letra la línea de puntajes y después los
     datos graciosos de a uno. */
  import { fade } from "svelte/transition";
  import { scoreReveal, type RevealSeg } from "../../app/ui";
  import { tr } from "../../app/i18n";
  import { audio } from "../../audio/audio";

  const CHAR_MS = 38, PAUSE_MS = 300, HOLD_MS = 1700, END_HOLD_MS = 2000;
  let line1 = $state<RevealSeg[]>([]);
  let line2 = $state<RevealSeg[]>([]);
  let visible = $state(false);
  let timers: number[] = [];

  function clear() { timers.forEach(clearTimeout); timers = []; }

  function typeInto(target: "l1" | "l2", seg: RevealSeg, start: number): number {
    for (let i = 0; i <= seg.text.length; i++) {
      timers.push(window.setTimeout(() => {
        const piece = { text: seg.text.slice(0, i), color: seg.color };
        if (target === "l1") line1 = [...line1.slice(0, -1), piece];
        else line2 = [piece];
      }, start + i * CHAR_MS));
    }
    return start + seg.text.length * CHAR_MS;
  }

  $effect(() => {
    const r = $scoreReveal;
    clear();
    if (!r) { visible = false; return; }
    visible = true;
    line1 = []; line2 = [];
    let t = 0;
    for (const seg of r.line1) {
      timers.push(window.setTimeout(() => { line1 = [...line1, { text: "", color: seg.color }]; if (seg.color) audio.on.uiHover(); }, t));
      t = typeInto("l1", seg, t) + (seg.color ? PAUSE_MS : 0);
    }
    for (const seg of r.stats) {
      t += PAUSE_MS;
      t = typeInto("l2", seg, t) + HOLD_MS;
    }
    timers.push(window.setTimeout(() => (visible = false), t + (r.stats.length ? 0 : END_HOLD_MS)));
    return clear;
  });
</script>

{#if visible}
  <div class="reveal" transition:fade={{ duration: 250 }}>
    <span class="label">{$tr("hud.scores")}</span>
    <div class="line big">{#each line1 as s}<span style:color={s.color} class:glow={!!s.color}>{s.text}</span>{/each}<i class="cur"></i></div>
    <div class="line">{#each line2 as s}<span style:color={s.color} class:glow={!!s.color}>{s.text}</span>{/each}</div>
  </div>
{/if}

<style>
  .reveal { position: absolute; left: 50%; top: 110px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 14px 32px; border-radius: 16px; background: linear-gradient(180deg, rgba(10,12,24,.72), rgba(10,12,24,.2)); text-align: center; max-width: 94vw; }
  .line { font-size: 17px; font-weight: 600; min-height: 24px; white-space: nowrap; }
  .line.big { font-size: 24px; font-weight: 700; }
  .glow { text-shadow: 0 0 14px currentColor; }
  .cur { display: inline-block; width: 3px; height: 20px; background: var(--cyan); margin-left: 3px; vertical-align: text-bottom; animation: blink .9s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
