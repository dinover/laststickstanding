<script lang="ts">
  import { profile } from "../../app/persist";
  import { tr } from "../../app/i18n";
  import { errors } from "../../app/ui";
  import { go, createOnlineRoom } from "../../app/actions";
  import { audio } from "../../audio/audio";
  import StickPreview from "../StickPreview.svelte";
  import Leaderboards from "./Leaderboards.svelte";
  import { openLocalSetup } from "./localNav";

  let supportOpen = $state(false);

  function onName(e: Event) {
    const v = (e.target as HTMLInputElement).value.slice(0, 14);
    profile.update((p) => ({ ...p, name: v }));
  }

  const color = $derived($profile.color || "#35f0e0");
</script>

<div class="home">
  <div class="col">
    <div class="me panel">
      {#key color + $profile.hat}
        <div class="me-preview"><StickPreview {color} hat={$profile.hat} width={78} height={92} scale={1.05} feetY={84} /></div>
      {/key}
      <div class="me-body">
        <span class="label">{$tr("lobby.yourName")}</span>
        <input value={$profile.name} oninput={onName} maxlength="14" placeholder={$tr("lobby.yourName")} autocomplete="nickname" />
      </div>
      <button class="btn btn-ghost customize" title={$tr("lobby.customizeTitle")} onclick={() => go("customize")}>🎨</button>
    </div>

    <div class="tiles">
      <button class="tile tile-main" onclick={() => { audio.on.uiClick(); createOnlineRoom(); }} onmouseenter={() => audio.on.uiHover()}>
        <span class="t-ico">🌐</span>
        <span class="t-txt"><strong>{$tr("lobby.create")}</strong><span>{$tr("origin.onlineDesc")}</span></span>
      </button>
      <button class="tile" onclick={() => go("join")} onmouseenter={() => audio.on.uiHover()}>
        <span class="t-ico">🔑</span>
        <span class="t-txt"><strong>{$tr("lobby.join")}</strong><span>{$tr("join.codePlaceholder")} · 4</span></span>
      </button>
      <button class="tile" onclick={openLocalSetup} onmouseenter={() => audio.on.uiHover()}>
        <span class="t-ico">🛋️</span>
        <span class="t-txt"><strong>{$tr("origin.local")}</strong><span>{$tr("origin.localDesc")}</span></span>
      </button>
      <button class="tile tile-wide" onclick={() => go("solo")} onmouseenter={() => audio.on.uiHover()}>
        <span class="t-ico">🎯</span>
        <span class="t-txt"><strong>{$tr("lobby.practice")}</strong><span>{$tr("solo.pick")}</span></span>
      </button>
    </div>
    <div class="err">{$errors.main || $errors.origin}</div>

    <div class="support">
      <button class="btn btn-ghost btn-sm" onclick={() => (supportOpen = !supportOpen)}>{$tr("support.cta")}</button>
      {#if supportOpen}
        <div class="support-panel">
          <p class="muted">{$tr("support.blurb")}</p>
          <div class="links">
            <a class="btn btn-sm sp-paypal" href="https://www.paypal.com/paypalme/zoulta?country.x=UY&locale.x=en_US" target="_blank" rel="noopener noreferrer">PayPal</a>
            <a class="btn btn-sm sp-mp" href="https://link.mercadopago.com.uy/leinonair" target="_blank" rel="noopener noreferrer">Mercado Pago</a>
          </div>
        </div>
      {/if}
    </div>
  </div>
  <aside class="side">
    <Leaderboards />
  </aside>
</div>

<style>
  .home { display: grid; grid-template-columns: minmax(0, 440px) minmax(0, 340px); gap: 22px; align-items: start; }
  .col { display: flex; flex-direction: column; gap: 14px; }
  .me { display: flex; align-items: center; gap: 14px; padding: 12px 14px; }
  .me-preview { width: 78px; height: 92px; flex: none; border-radius: 12px; background: radial-gradient(circle at 50% 70%, rgba(53,240,224,.12), transparent 70%); }
  .me-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .customize { width: 48px; height: 48px; padding: 0; font-size: 20px; flex: none; }
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .tile {
    display: flex; flex-direction: column; align-items: flex-start; gap: 10px; text-align: left; padding: 16px;
    border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line);
    backdrop-filter: blur(14px); transition: transform .15s ease, border-color .15s, box-shadow .2s, background .2s;
    min-height: 118px;
  }
  .tile:hover { transform: translateY(-3px); border-color: rgba(53,240,224,.5); box-shadow: 0 14px 36px rgba(0,0,0,.4), 0 0 0 1px rgba(53,240,224,.2); }
  .tile-main { grid-column: span 2; flex-direction: row; align-items: center; min-height: 0; padding: 18px;
    background: linear-gradient(120deg, rgba(53,240,224,.18), rgba(43,200,255,.08) 55%, rgba(11,13,27,.7)); border-color: rgba(53,240,224,.45); }
  .tile-main strong { font-size: 19px; color: #fff; }
  .tile-wide { grid-column: span 2; flex-direction: row; align-items: center; min-height: 0; background: linear-gradient(120deg, rgba(255,46,136,.12), rgba(11,13,27,.7) 60%); border-color: rgba(255,46,136,.3); }
  .tile-wide:hover { border-color: rgba(255,46,136,.6); box-shadow: 0 14px 36px rgba(0,0,0,.4), 0 0 0 1px rgba(255,46,136,.25); }
  .t-ico { font-size: 26px; width: 46px; height: 46px; display: grid; place-items: center; border-radius: 12px; background: rgba(255,255,255,.06); flex: none; }
  .t-txt { display: flex; flex-direction: column; gap: 4px; }
  .t-txt strong { font-size: 15px; letter-spacing: .02em; }
  .t-txt span { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .support { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
  .support-panel { max-width: 380px; }
  .support-panel p { font-size: 12px; margin: 0 0 10px; }
  .links { display: flex; gap: 8px; }
  .sp-paypal { background: #4fd2ff; color: #05060d; }
  .sp-mp { background: #ffc247; color: #05060d; }
  @media (max-width: 860px) {
    .home { grid-template-columns: 1fr; }
    .side { order: 3; }
  }
  @media (max-width: 420px) {
    .tiles { grid-template-columns: 1fr; }
    .tile-main, .tile-wide { grid-column: auto; }
    .tile { min-height: 0; flex-direction: row; align-items: center; }
  }
</style>
