<script lang="ts">
  import { onMount } from "svelte";
  import { tr } from "../../app/i18n";
  import { errors } from "../../app/ui";
  import { joinOnlineRoom } from "../../app/actions";

  let { initial = "" }: { initial?: string } = $props();
  let code = $state(initial);
  let el: HTMLInputElement;
  onMount(() => el?.focus());

  function submit(e: Event) {
    e.preventDefault();
    joinOnlineRoom(code);
  }
</script>

<form class="card panel" onsubmit={submit}>
  <p class="label">{$tr("lobby.join")}</p>
  <input bind:this={el} class="code" bind:value={code} maxlength="4" placeholder={$tr("join.codePlaceholder")}
    oninput={() => (code = code.toUpperCase().replace(/[^A-Z0-9]/g, ""))} autocomplete="off" autocapitalize="characters" spellcheck="false" />
  <button class="btn btn-primary btn-block" type="submit" disabled={code.length < 4}>{$tr("join.connect")}</button>
  <div class="err">{$errors.join}</div>
</form>

<style>
  .card { padding: 20px; display: flex; flex-direction: column; gap: 12px; width: min(400px, 100%); }
  .code { font-family: var(--font-display); font-size: 40px; text-align: center; letter-spacing: .4em; padding: 14px 14px 14px 30px; text-transform: uppercase; }
</style>
