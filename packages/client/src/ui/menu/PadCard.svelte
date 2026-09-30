<script lang="ts">
  import { onMount } from "svelte";
  import QRCode from "qrcode";
  import { tr } from "../../app/i18n";
  import { errors } from "../../app/ui";
  import { couch, openPadRoom, padState } from "../../app/local";

  let canvas: HTMLCanvasElement;
  onMount(() => openPadRoom());

  $effect(() => {
    const url = $padState.url;
    if (url && canvas) QRCode.toCanvas(canvas, url, { width: 220, margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060d", light: "#ffffff" } }).catch(() => {});
  });

  function colorOf(pad: number) {
    const p = $couch.find((x) => x.source.type === "pad" && x.source.pad === pad);
    return p ? p.color : "var(--line-2)";
  }
</script>

<div class="card panel">
  <p class="label">{$tr("pad.scan")}</p>
  <div class="qr"><canvas bind:this={canvas} class:hidden={!$padState.url}></canvas>{#if !$padState.url}<div class="spin"></div>{/if}</div>
  <p class="muted small">{$tr("pad.orType")}</p>
  <div class="url">{$padState.url.replace(/^https?:\/\//, "") || "…"}</div>
  <div class="code">{$padState.code || "----"}</div>
  <div class="peers">
    {#each $padState.peers as peer (peer.pad)}
      <span class="peer" class:off={!peer.connected} style="border-color:{colorOf(peer.pad)}">{$couch.find((x) => x.source.type === "pad" && x.source.pad === peer.pad)?.name || peer.name}</span>
    {:else}
      <span class="muted small">{$padState.open ? $tr("pad.waiting") : $tr("pad.opening")}</span>
    {/each}
  </div>
  <p class="hint">{$tr("pad.hint")}</p>
  <div class="err">{$errors.pad}</div>
</div>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 10px; align-items: center; text-align: center; width: min(420px, 100%); }
  .qr { background: #fff; border-radius: 14px; padding: 10px; width: 240px; height: 240px; display: grid; place-items: center; box-shadow: 0 0 40px rgba(53,240,224,.2); }
  .qr canvas { width: 220px !important; height: 220px !important; }
  .hidden { display: none; }
  .spin { width: 36px; height: 36px; border-radius: 50%; border: 3px solid rgba(0,0,0,.1); border-top-color: #05060d; animation: spin .9s linear infinite; }
  .url { font-size: 14px; padding: 8px 12px; border-radius: 10px; background: rgba(16,20,40,.7); border: 1px solid var(--line); word-break: break-all; }
  .code { font-family: var(--font-display); font-size: 44px; font-weight: 700; letter-spacing: .2em; color: var(--cyan); text-shadow: 0 0 22px rgba(53,240,224,.45); line-height: 1; }
  .peers { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .peer { font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid; background: rgba(16,20,40,.7); }
  .peer.off { opacity: .45; text-decoration: line-through; }
  .small { font-size: 12px; margin: 0; }
  .hint { margin: 0; font-size: 11px; color: var(--dim); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
