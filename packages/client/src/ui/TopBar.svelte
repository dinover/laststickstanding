<script lang="ts">
  import { fly } from "svelte/transition";
  import { lang, tr } from "../app/i18n";
  import { settings } from "../app/persist";
  import { playing } from "../app/ui";
  import { audio, type AudioSettings } from "../audio/audio";
  import { authUser, authSubmit, authLogout, type AuthError } from "../services/supabase";
  import { relabelAutoNames } from "../app/local";
  import { ping } from "../net/net";
  import { icons, FLAGS } from "./icons";

  let open = $state<"audio" | "settings" | "account" | null>(null);
  let vol = $state<AudioSettings>({ ...audio.settings });

  function toggle(p: typeof open) { open = open === p ? null : p; audio.on.uiClick(); }
  function setVol(k: "master" | "music" | "sfx", v: number) { vol = { ...vol, [k]: v }; audio.set({ [k]: v }); }
  function toggleMute() { vol = { ...vol, muted: !vol.muted }; audio.set({ muted: vol.muted }); }
  function swapLang() { lang.set($lang === "es" ? "en" : "es"); relabelAutoNames(); audio.on.uiClick(); }

  // cuenta
  let mode = $state<"login" | "signup">("login");
  let user = $state(""), pass = $state(""), pass2 = $state("");
  let authErr = $state<AuthError | null>(null);
  let busy = $state(false);
  const ERR: Record<AuthError, string> = {
    format: "auth.errUsernameFormat", short: "auth.errShortPass", mismatch: "auth.errMismatch",
    taken: "auth.errTaken", badLogin: "auth.errBadLogin", generic: "auth.errGeneric",
  };
  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    authErr = await authSubmit(mode, user, pass, pass2);
    busy = false;
    if (!authErr) { open = null; pass = pass2 = ""; }
  }

  function onDocClick(e: MouseEvent) {
    if (open && !(e.target as HTMLElement).closest(".topbar")) open = null;
  }
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") open = null; }
</script>

<svelte:window onclick={onDocClick} onkeydown={onKey} />

<div class="topbar ui-block">
  {#if !$playing && $ping !== null}
    <span class="ping" class:good={$ping < 60} class:ok={$ping >= 60 && $ping < 150} class:bad={$ping >= 150} title={$tr("ping.label")}><i></i>{$ping} ms</span>
  {/if}
  {#if !$playing}
    <button class="btn-icon flag" title="Idioma / Language" onclick={swapLang}>{@html FLAGS[$lang]}</button>
  {/if}
  <div class="wrap">
    <button class="btn-icon" class:active={open === "audio"} title={$tr("audio.title")} onclick={() => toggle("audio")}>{@html vol.muted ? icons.mute : icons.sound}</button>
    {#if open === "audio"}
      <div class="pop panel" transition:fly={{ y: -6, duration: 140 }}>
        <div class="pop-head"><span class="label">{$tr("audio.title")}</span>
          <button class="btn-icon small" class:danger={vol.muted} title={$tr("audio.mute")} onclick={toggleMute}>{@html vol.muted ? icons.mute : icons.sound}</button>
        </div>
        {#each [["sfx", "audio.sfx"], ["music", "audio.music"], ["master", "audio.master"]] as [k, label]}
          <label class="slider" class:dim={vol.muted}>
            <span class="sl-l">{$tr(label)}</span>
            <input type="range" min="0" max="1" step="0.01" value={vol[k as "sfx"]} style="--p:{vol[k as "sfx"] * 100}%"
              oninput={(e) => setVol(k as "sfx", parseFloat((e.target as HTMLInputElement).value))} />
            <span class="sl-v">{Math.round(vol[k as "sfx"] * 100)}%</span>
          </label>
        {/each}
      </div>
    {/if}
  </div>
  <div class="wrap">
    <button class="btn-icon" class:active={open === "settings"} title={$tr("settings.title")} onclick={() => toggle("settings")}>{@html icons.gear}</button>
    {#if open === "settings"}
      <div class="pop panel" transition:fly={{ y: -6, duration: 140 }}>
        <div class="pop-head"><span class="label">{$tr("settings.graphics")}</span></div>
        <div class="seg">
          <span class="sl-l">{$tr("settings.quality")}</span>
          <div class="chips">
            <button class="chip" class:selected={$settings.quality === "high"} onclick={() => settings.update((s) => ({ ...s, quality: "high" }))}>{$tr("settings.high")}</button>
            <button class="chip" class:selected={$settings.quality === "low"} onclick={() => settings.update((s) => ({ ...s, quality: "low" }))}>{$tr("settings.low")}</button>
          </div>
        </div>
        <label class="check"><input type="checkbox" checked={$settings.dynamicCamera} onchange={(e) => settings.update((s) => ({ ...s, dynamicCamera: (e.target as HTMLInputElement).checked }))} /><span>{$tr("settings.camera")}<small>{$tr("settings.cameraDesc")}</small></span></label>
        <label class="check"><input type="checkbox" checked={$settings.damageNumbers} onchange={(e) => settings.update((s) => ({ ...s, damageNumbers: (e.target as HTMLInputElement).checked }))} /><span>{$tr("settings.damageNumbers")}</span></label>
        <label class="check"><input type="checkbox" checked={$settings.reduceMotion} onchange={(e) => settings.update((s) => ({ ...s, reduceMotion: (e.target as HTMLInputElement).checked }))} /><span>{$tr("settings.reduceMotion")}</span></label>
        <label class="check"><input type="checkbox" checked={$settings.showFps} onchange={(e) => settings.update((s) => ({ ...s, showFps: (e.target as HTMLInputElement).checked }))} /><span>{$tr("settings.fps")}</span></label>
      </div>
    {/if}
  </div>
  {#if !$playing}
    <div class="wrap">
      <button class="btn-icon" class:logged={!!$authUser} class:active={open === "account"} title={$tr("auth.title")} onclick={() => toggle("account")}>
        {#if $authUser}<b>{$authUser.username.charAt(0).toUpperCase()}</b>{:else}{@html icons.user}{/if}
      </button>
      {#if open === "account"}
        <div class="pop panel" transition:fly={{ y: -6, duration: 140 }}>
          <div class="pop-head"><span class="label">{$tr("auth.title")}</span></div>
          {#if $authUser}
            <p class="who">{$tr("auth.loggedInAs")} <b>{$authUser.username}</b></p>
            <button class="btn btn-ghost btn-block btn-sm" onclick={() => authLogout()}>{$tr("auth.logout")}</button>
          {:else}
            <form class="auth" onsubmit={submit}>
              <input bind:value={user} maxlength="20" autocomplete="username" placeholder={$tr("auth.username")} />
              <input bind:value={pass} type="password" maxlength="72" autocomplete={mode === "login" ? "current-password" : "new-password"} placeholder={$tr("auth.password")} />
              {#if mode === "signup"}<input bind:value={pass2} type="password" maxlength="72" autocomplete="new-password" placeholder={$tr("auth.passwordConfirm")} />{/if}
              {#if authErr}<div class="err">{$tr(ERR[authErr])}</div>{/if}
              <button class="btn btn-primary btn-block btn-sm" type="submit" disabled={busy}>{$tr(mode === "signup" ? "auth.createBtn" : "auth.login")}</button>
              <button class="link" type="button" onclick={() => { mode = mode === "login" ? "signup" : "login"; authErr = null; }}>{$tr(mode === "signup" ? "auth.backToLogin" : "auth.createLink")}</button>
            </form>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .topbar { position: absolute; top: 14px; right: 16px; z-index: 30; display: flex; align-items: center; gap: 8px; }
  .wrap { position: relative; }
  .flag :global(svg) { width: 22px; height: 22px; border-radius: 50%; }
  .btn-icon.active { color: var(--cyan); border-color: rgba(53,240,224,.6); }
  .btn-icon.logged { color: var(--cyan); border-color: var(--cyan); }
  .btn-icon.small { width: 28px; height: 28px; }
  .btn-icon.small :global(svg) { width: 14px; height: 14px; }
  .btn-icon.danger { color: var(--red); border-color: var(--red); }
  .ping { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding: 0 6px; font-variant-numeric: tabular-nums; }
  .ping i { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .ping.good i { background: var(--green); box-shadow: 0 0 8px var(--green); } .ping.good { color: var(--green); }
  .ping.ok i { background: var(--gold); } .ping.ok { color: var(--gold); }
  .ping.bad i { background: var(--red); } .ping.bad { color: var(--red); }
  .pop { position: absolute; top: 46px; right: 0; width: 262px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .pop-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .slider { display: grid; grid-template-columns: 58px 1fr 36px; align-items: center; gap: 8px; }
  .slider.dim { opacity: .4; }
  .sl-l { font-size: 12px; color: var(--muted); }
  .sl-v { font-size: 11px; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  input[type="range"] { -webkit-appearance: none; appearance: none; height: 4px; padding: 0; border: none; border-radius: 999px;
    background: linear-gradient(90deg, var(--cyan) var(--p), #1c2140 var(--p)); box-shadow: none; }
  input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #eaf0ff; border: 2px solid var(--cyan); cursor: pointer; }
  input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #eaf0ff; border: 2px solid var(--cyan); cursor: pointer; }
  .seg { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .check { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; cursor: pointer; }
  .check input { width: 16px; height: 16px; margin-top: 2px; accent-color: var(--cyan); flex: none; }
  .check small { display: block; color: var(--dim); font-size: 11px; margin-top: 2px; }
  .who { margin: 0; font-size: 13px; text-align: center; }
  .who b { color: var(--cyan); }
  .auth { display: flex; flex-direction: column; gap: 8px; }
  .auth input { padding: 9px 11px; font-size: 13px; }
  .link { font-size: 11px; color: var(--muted); text-decoration: underline; padding: 4px; }
</style>
