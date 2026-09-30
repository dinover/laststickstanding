<script lang="ts">
  /* El celular como control del modo Local. Port de V1 (pad.html) al protocolo binario de V2:
     analógico que se arma donde apoyás el pulgar, piña/patada arriba y saltar abajo, panel de
     sala para el que manda (el primero que entró), vibración al recibir golpes y reconexión al
     mismo lugar tras un bloqueo de pantalla. */
  import { onMount } from "svelte";
  import { ROOM_MODES, type InputKey, type ServerMsg } from "@lss/shared";
  import { GameSocket } from "../net/socket";

  const STR = {
    es: {
      sub: "Tu teléfono es el control. Poné tu nombre y el código que está en la pantalla.", subCode: "Tu teléfono es el control. Poné tu nombre y entrá.",
      nick: "TU NOMBRE", code: "CÓDIGO", enter: "Entrar", entering: "Entrando…", needNick: "Te falta el nombre.",
      needCode: "Te falta el código (son 4 letras, están en la pantalla).", noRoom: "Ese código no existe. Fijate bien en la pantalla.",
      full: "El sillón está lleno: ocho y no entra uno más.", dead: "No hay señal. Revisá el wifi o los datos.",
      jump: "SALTAR", punch: "PIÑA", kick: "PATADA", stick: "DESLIZÁ PARA MOVERTE", rotate: "Girá el teléfono de costado para jugar.",
      stConnected: "Listo", stWaiting: "Esperando", stFight: "Peleando", stOut: "Afuera", stLost: "Sin conexión",
      waitTitle: "YA VA A EMPEZAR", waitText: "El primero que entró elige el modo y arranca. No sueltes el teléfono.",
      leadTitle: "MANEJÁS VOS", leadNeedTwo: "Falta gente: solo no se puede pelear.", leadPlayers: "{n} en el sillón.",
      start: "¡A PELEAR!", again: "JUGAR DE NUEVO", roundsWord: "rondas", winsWord: "para ganar",
      "mode.rounds": "Rondas", "mode.wins": "Victorias", "mode.infinite": "Infinito", "mode.koth": "Colina", "mode.orbking": "Orbe",
      nextTitle: "ENTRÁS EN LA PRÓXIMA", nextText: "Esta ya empezó sin vos. Aguantá al final de la ronda y jugás la que viene.",
      fight: "¡A PELEAR!", outTitle: "ELIMINADO", outText: "Ya está. Mirá la pantalla, que los demás siguen.",
      endTitle: "SE TERMINÓ", endText: "Los resultados están en la pantalla grande.",
      hostGoneTitle: "SE FUE LA PANTALLA", hostGoneText: "Esperando que vuelva. No cierres esto.",
      closedTitle: "CORTARON LA PARTIDA", closedText: "Volvé a entrar cuando armen otra.",
      kickedTitle: "TE SACARON DEL SILLÓN", kickedText: "Podés volver a entrar con el mismo código.",
    },
    en: {
      sub: "Your phone is the controller. Type your name and the code on the screen.", subCode: "Your phone is the controller. Type your name and jump in.",
      nick: "YOUR NAME", code: "CODE", enter: "Join", entering: "Joining…", needNick: "Name's missing.",
      needCode: "Code's missing (4 letters, they're on the screen).", noRoom: "No such code. Take another look at the screen.",
      full: "Couch is full: eight and not one more.", dead: "No signal. Check your wifi or data.",
      jump: "JUMP", punch: "PUNCH", kick: "KICK", stick: "SLIDE TO MOVE", rotate: "Turn your phone sideways to play.",
      stConnected: "Ready", stWaiting: "Waiting", stFight: "Fighting", stOut: "Out", stLost: "Offline",
      waitTitle: "STARTING SOON", waitText: "Whoever joined first picks the mode and starts it. Keep the phone handy.",
      leadTitle: "YOU'RE IN CHARGE", leadNeedTwo: "Not enough people: you can't brawl alone.", leadPlayers: "{n} on the couch.",
      start: "FIGHT!", again: "PLAY AGAIN", roundsWord: "rounds", winsWord: "to win",
      "mode.rounds": "Rounds", "mode.wins": "Wins", "mode.infinite": "Endless", "mode.koth": "Hill", "mode.orbking": "Orb",
      nextTitle: "YOU'RE IN THE NEXT ONE", nextText: "This one started without you. Hang on till the round ends and you're in.",
      fight: "FIGHT!", outTitle: "ELIMINATED", outText: "That's it. Watch the screen, the others are still at it.",
      endTitle: "IT'S OVER", endText: "Results are up on the big screen.",
      hostGoneTitle: "THE SCREEN LEFT", hostGoneText: "Waiting for it to come back. Don't close this.",
      closedTitle: "LOCAL MATCH ENDED", closedText: "Come back in when they set up another one.",
      kickedTitle: "YOU'RE OFF THE COUCH", kickedText: "You can join again with the same code.",
    },
  };
  type K = keyof typeof STR.es;
  const lang: "es" | "en" = String((navigator.languages && navigator.languages[0]) || navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
  const t = (k: K, p?: Record<string, string | number>) => {
    let s = STR[lang][k] || STR.es[k] || k;
    if (p) s = s.replace(/\{(\w+)\}/g, (m, x) => (p[x] !== undefined ? String(p[x]) : m));
    return s;
  };

  interface PadState { phase: string; alive: boolean; leader: boolean; mode: string; rounds: number; canStart: boolean; players: number }

  const fromUrl = (location.search.match(/[?&]c=([A-Za-z0-9]{1,8})/) || [])[1] || "";
  let nick = $state(localGet("lss-pad-name"));
  let code = $state(fromUrl.toUpperCase());
  let joinErr = $state("");
  let entering = $state(false);
  let joined = $state(false);
  let myName = $state("");
  let color = $state("#35f0e0");
  let status = $state<K | "">("");
  let st = $state<PadState | null>(null);
  let leader = $state(false);
  let overlay = $state<{ title: K; text: string; hot: boolean } | null>(null);
  let flash = $state(false);
  let lastPhase: string | null = null;
  let pending: { t: "padJoin"; code: string; nick: string; token?: string } | null = null;
  let myCode = "";

  const sock = new GameSocket(30);
  const held: Partial<Record<InputKey, boolean>> = {};

  function localGet(k: string) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
  function tokenFor(c: string) { try { return sessionStorage.getItem("lss-pad-token:" + c) || undefined; } catch { return undefined; } }
  function saveToken(c: string, tok: string | null) { try { if (tok) sessionStorage.setItem("lss-pad-token:" + c, tok); else sessionStorage.removeItem("lss-pad-token:" + c); } catch { /* */ } }

  sock.onOpen = () => { if (pending) sock.send(pending); };
  sock.onClose = () => { releaseAll(); if (joined) status = "stLost"; };
  sock.onStatus = (s) => { if (s === "failed") backToJoin("dead"); };
  sock.shouldReconnect = () => !!pending;
  sock.onMessage = (msg: ServerMsg) => {
    switch (msg.t) {
      case "padJoined":
        myCode = msg.code; myName = msg.name;
        saveToken(msg.code, msg.token);
        pending = { t: "padJoin", code: msg.code, nick: msg.name, token: msg.token };
        status = "stConnected"; joined = true; entering = false; overlay = null;
        requestWakeLock();
        sock.send({ t: "padMsg", data: { t: "sync" } });
        break;
      case "padErr":
        pending = null;
        backToJoin(msg.code === "full" ? "full" : "noRoom");
        break;
      case "padMsg": onHost(msg.data as Record<string, unknown>); break;
      case "padHostGone": status = "stLost"; overlay = { title: "hostGoneTitle", text: t("hostGoneText"), hot: false }; break;
      case "padHostBack": overlay = null; status = "stConnected"; sock.send({ t: "padMsg", data: { t: "sync" } }); break;
      case "padKicked":
      case "padClosed": {
        pending = null;
        saveToken(myCode, null);
        if (msg.t === "padKicked" && msg.reason === "full") { backToJoin("full"); break; }
        const kicked = msg.t === "padKicked";
        overlay = { title: kicked ? "kickedTitle" : "closedTitle", text: t(kicked ? "kickedText" : "closedText"), hot: true };
        setTimeout(() => backToJoin(null), 2600);
        break;
      }
    }
  };

  function onHost(d: Record<string, unknown>) {
    if (!d || !d.t) return;
    if (d.t === "you") {
      if (typeof d.color === "string") color = d.color;
      if (typeof d.name === "string") myName = d.name;
      leader = !!d.leader;
      render();
    } else if (d.t === "phase") {
      st = d as unknown as PadState;
      leader = !!d.leader;
      const enters = st.phase !== lastPhase;
      lastPhase = st.phase;
      render();
      if (enters && st.phase === "fightIntro") { flash = true; setTimeout(() => (flash = false), 900); }
    } else if (d.t === "buzz" && navigator.vibrate) navigator.vibrate(d.long ? 90 : 25);
  }

  function render() {
    if (!st) return;
    if (st.phase === "lobby") {
      status = "stWaiting";
      overlay = leader
        ? { title: "leadTitle", text: st.canStart ? t("leadPlayers", { n: st.players || 0 }) : t("leadNeedTwo"), hot: false }
        : { title: "waitTitle", text: t("waitText"), hot: false };
    } else if (st.phase === "pending") { status = "stWaiting"; overlay = { title: "nextTitle", text: t("nextText"), hot: false }; }
    else if (st.phase === "final") { status = "stWaiting"; overlay = { title: "endTitle", text: t("endText"), hot: false }; }
    else if (st.alive === false) { status = "stOut"; overlay = { title: "outTitle", text: t("outText"), hot: true }; }
    else { status = "stFight"; overlay = null; }
  }

  function backToJoin(err: K | null) {
    joined = false; leader = false; st = null; lastPhase = null; entering = false; overlay = null;
    joinErr = err ? t(err) : "";
  }

  function tryJoin(e?: Event) {
    e?.preventDefault();
    const n = nick.trim(), c = code.trim().toUpperCase();
    if (!n) { joinErr = t("needNick"); return; }
    if (c.length < 4) { joinErr = t("needCode"); return; }
    try { localStorage.setItem("lss-pad-name", n); } catch { /* */ }
    myCode = c; joinErr = ""; entering = true;
    pending = { t: "padJoin", code: c, nick: n, token: tokenFor(c) };
    if (sock.isOpen) sock.send(pending); else sock.connect();
  }

  function hostCmd(data: Record<string, unknown>) { sock.send({ t: "padMsg", data }); }

  /* ---------------------------------------------------------------- input */
  function sendInput(k: InputKey, d: boolean) {
    if (held[k] === d) return;
    held[k] = d;
    sock.send({ t: "padInput", k, d });
  }
  function releaseAll() {
    for (const k of Object.keys(held) as InputKey[]) if (held[k]) sendInput(k, false);
    pressed = {};
    stickRelease();
  }
  let pressed = $state<Partial<Record<InputKey, boolean>>>({});
  function hold(k: InputKey, d: boolean, e?: PointerEvent) {
    e?.preventDefault();
    if (d && e) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (!!pressed[k] === d) return;
    pressed = { ...pressed, [k]: d };
    sendInput(k, d);
    if (d && navigator.vibrate) navigator.vibrate(8);
  }

  // analógico flotante: solo el eje X importa
  const DEAD = 14, RANGE = 52;
  let stickPid: number | null = null, stickOx = 0;
  let stick = $state<{ x: number; y: number; dx: number } | null>(null);
  let zone = $state<HTMLDivElement>();
  function stickDown(e: PointerEvent) {
    if (stickPid !== null) return;
    e.preventDefault();
    stickPid = e.pointerId; stickOx = e.clientX;
    const r = zone!.getBoundingClientRect();
    stick = { x: e.clientX - r.left, y: e.clientY - r.top, dx: 0 };
    try { zone!.setPointerCapture(e.pointerId); } catch { /* */ }
    if (navigator.vibrate) navigator.vibrate(6);
  }
  function stickMove(e: PointerEvent) {
    if (e.pointerId !== stickPid || !stick) return;
    e.preventDefault();
    const dx = e.clientX - stickOx;
    stick = { ...stick, dx };
    sendInput("left", dx < -DEAD);
    sendInput("right", dx > DEAD);
  }
  function stickUp(e: PointerEvent) { if (e.pointerId === stickPid) stickRelease(); }
  function stickRelease() { stickPid = null; stick = null; sendInput("left", false); sendInput("right", false); }

  /* La pantalla apagada a mitad de una ronda es la forma más tonta de perder: se pide que no se apague. */
  let wakeLock: { release(): Promise<void> } | null = null;
  function requestWakeLock() {
    const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void>; addEventListener(e: string, f: () => void): void }> } };
    if (!nav.wakeLock || wakeLock) return;
    nav.wakeLock.request("screen").then((l) => { wakeLock = l; l.addEventListener("release", () => (wakeLock = null)); }).catch(() => {});
  }

  onMount(() => {
    document.documentElement.lang = lang;
    const vis = () => {
      if (document.visibilityState !== "visible") { releaseAll(); return; }
      requestWakeLock();
      if (!joined) return;
      if (!sock.isOpen) sock.connect(); else sock.send({ t: "padMsg", data: { t: "sync" } });
    };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  });
</script>

<div class="pad-root" style="--me:{color}" class:playing={joined}>
  {#if !joined}
    <form class="join" onsubmit={tryJoin}>
      <h1>LAST STICK <span>STANDING</span></h1>
      <p class="sub">{fromUrl ? t("subCode") : t("sub")}</p>
      <input bind:value={nick} maxlength="14" placeholder={t("nick")} autocomplete="off" autocapitalize="words" />
      <input class="code" bind:value={code} maxlength="4" placeholder={t("code")} autocomplete="off" spellcheck="false" oninput={() => (code = code.toUpperCase())} />
      <button class="btn btn-primary" type="submit" disabled={entering}>{entering ? t("entering") : t("enter")}</button>
      <div class="err">{joinErr}</div>
    </form>
  {:else}
    <div class="badge"><span class="bdot"></span><div><div class="nm">{myName}</div><div class="st">{status ? t(status) : ""}</div></div></div>
    <div class="controls">
      <div class="zone stick" role="application" aria-label="stick" bind:this={zone} class:active={!!stick} onpointerdown={stickDown} onpointermove={stickMove} onpointerup={stickUp} onpointercancel={stickUp} onlostpointercapture={stickUp}>
        {#if !stick}<div class="hint">{t("stick")}</div>{/if}
        {#if stick}
          <div class="base" style="left:{stick.x}px;top:{stick.y}px">
            <div class="knob" class:on={Math.abs(stick.dx) > DEAD} style="transform:translateX({Math.max(-RANGE, Math.min(RANGE, stick.dx))}px)"></div>
          </div>
        {/if}
      </div>
      <div class="zone action">
        <div class="row">
          <button class="b punch" class:down={pressed.punch} onpointerdown={(e) => hold("punch", true, e)} onpointerup={(e) => hold("punch", false, e)} onpointercancel={(e) => hold("punch", false, e)} onlostpointercapture={() => hold("punch", false)}>{t("punch")}</button>
          <button class="b kick" class:down={pressed.kick} onpointerdown={(e) => hold("kick", true, e)} onpointerup={(e) => hold("kick", false, e)} onpointercancel={(e) => hold("kick", false, e)} onlostpointercapture={() => hold("kick", false)}>{t("kick")}</button>
        </div>
        <button class="b jump" class:down={pressed.jump} onpointerdown={(e) => hold("jump", true, e)} onpointerup={(e) => hold("jump", false, e)} onpointercancel={(e) => hold("jump", false, e)} onlostpointercapture={() => hold("jump", false)}>{t("jump")}</button>
      </div>
    </div>
    {#if flash}<div class="flash">{t("fight")}</div>{/if}
    {#if overlay}
      <div class="ov">
        <div class="big" class:hot={overlay.hot}>{t(overlay.title)}</div>
        <div class="small">{overlay.text}</div>
        {#if leader && st && st.phase === "lobby"}
          <div class="host">
            <div class="modes">
              {#each ROOM_MODES as m}
                <button class="mode" class:on={st.mode === m} onclick={() => hostCmd({ t: "setMode", mode: m })}>{t(("mode." + m) as K)}</button>
              {/each}
            </div>
            {#if st.mode === "rounds" || st.mode === "wins"}
              <div class="stepper">
                <button onclick={() => st && hostCmd({ t: "setRounds", rounds: Math.max(1, st.rounds - 1) })}>−</button>
                <span class="n">{st.rounds}</span>
                <button onclick={() => st && hostCmd({ t: "setRounds", rounds: Math.min(20, st.rounds + 1) })}>+</button>
                <span class="lbl">{t(st.mode === "wins" ? "winsWord" : "roundsWord")}</span>
              </div>
            {/if}
            <button class="btn btn-primary" disabled={!st.canStart} onclick={() => hostCmd({ t: "start" })}>{t("start")}</button>
          </div>
        {/if}
        {#if leader && st && st.phase === "final"}<button class="btn btn-primary" onclick={() => hostCmd({ t: "again" })}>{t("again")}</button>{/if}
      </div>
    {/if}
    <div class="rotate"><div class="icon"></div><p>{t("rotate")}</p></div>
  {/if}
</div>

<style>
  :global(body) { touch-action: none; user-select: none; -webkit-user-select: none; }
  .pad-root { position: fixed; inset: 0; --me: #35f0e0; }
  .join { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 20px; text-align: center; overflow-y: auto; }
  .join h1 { font-size: 20px; letter-spacing: .12em; margin: 0; }
  .join h1 span { color: var(--cyan); }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 6px; max-width: 320px; line-height: 1.45; }
  .join input { width: min(280px, 80vw); text-align: center; letter-spacing: .08em; }
  .join .code { letter-spacing: .35em; font-size: 22px; font-weight: 700; text-transform: uppercase; }
  .join .btn { width: min(280px, 80vw); }
  .badge { position: absolute; z-index: 5; pointer-events: none; top: max(6px, env(safe-area-inset-top)); left: max(10px, env(safe-area-inset-left)); display: flex; align-items: center; gap: 7px; }
  .bdot { width: 13px; height: 13px; border-radius: 50%; background: var(--me); box-shadow: 0 0 10px var(--me); }
  .nm { font-size: 12px; font-weight: 700; }
  .st { font-size: 10px; color: var(--muted); }
  .controls { position: absolute; inset: 0; display: flex; gap: 12px; padding: max(34px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
  .zone { flex: 1 1 0; min-width: 0; display: flex; gap: 10px; }
  .zone.action { flex-direction: column; }
  .row { flex: 1 1 0; display: flex; gap: 10px; min-height: 0; }
  .stick { position: relative; touch-action: none; border-radius: 20px; border: 2px dashed #1c2238; align-items: center; justify-content: center; overflow: hidden; }
  .stick.active { border-color: transparent; }
  .hint { font-size: 12px; letter-spacing: .1em; color: #39415e; pointer-events: none; text-align: center; padding: 0 12px; }
  .base { position: absolute; width: 138px; height: 138px; margin: -69px 0 0 -69px; border-radius: 50%; border: 2px solid #2a3050; background: rgba(18,22,42,.5); pointer-events: none; }
  .knob { position: absolute; top: 50%; left: 50%; width: 66px; height: 66px; margin: -33px 0 0 -33px; border-radius: 50%; border: 2px solid #2a3050; background: linear-gradient(155deg, #1a2038, #0a0c18); }
  .knob.on { border-color: var(--me); box-shadow: 0 0 22px color-mix(in srgb, var(--me) 40%, transparent); }
  .b { flex: 1 1 0; min-width: 0; min-height: 0; border-radius: 20px; border: 2px solid #2a3050; background: linear-gradient(155deg, #1a2038, #0a0c18); color: #9aa3bd; font-weight: 700; font-size: clamp(11px, 2.6vw, 15px); letter-spacing: .06em; touch-action: none; transition: transform .06s; }
  .b.down { transform: scale(.97); }
  .punch { background: linear-gradient(155deg, #2a1030, #180a18); }
  .punch.down { border-color: var(--pink); color: var(--pink); box-shadow: inset 0 0 40px rgba(255,46,136,.2); }
  .kick { background: linear-gradient(155deg, #0f2a30, #0a1818); }
  .kick.down { border-color: var(--cyan); color: var(--cyan); box-shadow: inset 0 0 40px rgba(53,240,224,.2); }
  .jump.down { border-color: var(--gold); color: var(--gold); box-shadow: inset 0 0 40px rgba(255,194,71,.18); }
  .flash { position: absolute; inset: 0; z-index: 15; display: grid; place-items: center; pointer-events: none; font-size: 36px; font-weight: 800; letter-spacing: .1em; color: var(--pink); text-shadow: 0 0 24px rgba(255,46,136,.6); }
  .ov { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 20px; background: rgba(5,6,13,.88); backdrop-filter: blur(4px); }
  .big { font-size: 22px; font-weight: 800; letter-spacing: .12em; color: var(--me); }
  .big.hot { color: var(--pink); }
  .small { color: var(--muted); font-size: 13px; max-width: 300px; line-height: 1.5; }
  .host { display: flex; flex-direction: column; align-items: center; gap: 10px; width: min(94vw, 460px); margin-top: 4px; }
  .modes { display: flex; flex-wrap: wrap; gap: 5px; justify-content: center; }
  .mode { padding: 8px 11px; font-size: 12px; font-weight: 700; border-radius: 999px; border: 1px solid #2a3050; background: #12162a; color: #9aa3bd; }
  .mode.on { border-color: var(--me); color: var(--me); box-shadow: 0 0 0 1px var(--me) inset; }
  .stepper { display: flex; align-items: center; gap: 12px; }
  .stepper button { width: 36px; height: 36px; border-radius: 50%; background: #12162a; border: 1px solid #2a3050; font-size: 18px; }
  .stepper .n { font-size: 22px; font-weight: 800; color: var(--me); min-width: 30px; }
  .stepper .lbl { font-size: 11px; color: var(--muted); }
  .rotate { display: none; position: fixed; inset: 0; z-index: 100; background: #05060d; flex-direction: column; align-items: center; justify-content: center; gap: 16px; text-align: center; padding: 24px; }
  .rotate .icon { width: 54px; height: 54px; border: 3px solid var(--cyan); border-radius: 8px; box-shadow: 0 0 18px rgba(53,240,224,.4); animation: turn 1.8s ease-in-out infinite; }
  .rotate p { margin: 0; font-size: 15px; font-weight: 700; max-width: 220px; }
  @keyframes turn { 0%, 15% { transform: rotate(0deg); } 50%, 100% { transform: rotate(-90deg); } }
  @media (orientation: portrait) { .playing .rotate { display: flex; } }
</style>
