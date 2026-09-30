/* Acciones de alto nivel que disparan los botones de la UI: arrancar cada modo, entrar/salir de
   salas online, revanchas, volver al menú. Es el único lugar que conoce a la vez la UI, el motor
   y la red. */

import { get } from "svelte/store";
import type { BiomeId, BotDifficultyId, RoomMode } from "@lss/shared";
import { engine } from "../game/engine";
import { PracticeSession } from "../game/sessions/practice";
import { StorySession } from "../game/sessions/story";
import { SagaSession } from "../game/sessions/saga";
import { OnlineSession } from "../game/sessions/online";
import { net, room } from "../net/net";
import { profile, sagaState, storyState, type StoryDifficulty } from "./persist";
import { t } from "./i18n";
import { clearErrors, crawl, finalScreen, menuScreen, reconnect, setError, storyMsg, type MenuScreen } from "./ui";
import { exitLocalToSetup, isLocalActive, rematchLocal } from "./local";
import { hideFinal } from "./final";
import { audio } from "../audio/audio";

let online: OnlineSession | null = null;

export function go(screen: MenuScreen) {
  audio.on.uiClick();
  clearErrors();
  menuScreen.set(screen);
}

function myName(): string {
  return get(profile).name.trim() || t("player.default");
}

/* ---------------------------------------------------------------- solo */
export function startPractice(diff: BotDifficultyId, biome: BiomeId | null) {
  engine.start(new PracticeSession(engine, diff, biome));
}

export function startStory(diff: StoryDifficulty, resume: boolean) {
  const run = resume ? get(storyState).run : null;
  engine.start(new StorySession(engine, run, diff, () => backToMenu("solo")));
}

export function startSaga(resume: boolean) {
  const run = resume ? get(sagaState).run : null;
  engine.start(new SagaSession(engine, run, () => backToMenu("solo")));
}

/** Vuelve al menú (desde cualquier modo local/solo). */
export function backToMenu(screen: MenuScreen = "home") {
  hideFinal();
  storyMsg.set(null);
  crawl.set(null);
  engine.stop();
  menuScreen.set(screen);
}

/* ---------------------------------------------------------------- online */
function ensureOnlineSession() {
  if (!online) {
    online = new OnlineSession(engine);
    engine.start(online);
  }
}

export function createOnlineRoom() {
  setError("origin", "");
  const p = get(profile);
  net.create(p.name.trim() || t("room.defaultHost"), p.color, p.hat);
}

export function joinOnlineRoom(code: string) {
  if (!code || code.trim().length < 4) { setError("join", t("join.needCode")); return; }
  setError("join", t("join.connecting"));
  const p = get(profile);
  net.join(code, myName(), p.color, p.hat);
}

export function leaveOnlineRoom() {
  net.leave();
  dropOnline();
  menuScreen.set("home");
}

function dropOnline() {
  if (online) {
    online = null;
    engine.stop();
  }
  hideFinal();
}

const SERVER_ERR: Record<string, string> = {
  started: "err.started", full: "err.full", notRegistered: "err.notRegistered", noCodes: "err.noCodes", noRoom: "err.noRoom",
};

let wired = false;
export function wireNet() {
  if (wired) return;
  wired = true;
  net.listen((msg) => {
    switch (msg.t) {
      case "joined":
        reconnect.set(null);
        clearErrors();
        ensureOnlineSession();
        menuScreen.set("room");
        break;
      case "err": {
        const key = SERVER_ERR[msg.code];
        const text = key ? t(key) : msg.msg || t("err.generic");
        const screen = get(menuScreen);
        setError(screen === "join" ? "join" : screen === "origin" ? "origin" : screen === "room" ? "room" : "main", text);
        break;
      }
      case "rejoinFailed":
        reconnect.set(null);
        dropOnline();
        menuScreen.set("home");
        setError("main", t("err.prevGone"));
        break;
      case "toLobby":
        menuScreen.set("room");
        break;
    }
  });
  net.onReconnecting = (i, n) => reconnect.set({ msg: t("rec.retrying", { i, n }), gaveUp: false });
  net.onGaveUp = () => reconnect.set({ msg: t("rec.gaveUp"), gaveUp: true });
  net.onClose = () => {
    if (!net.savedSession() && get(room).code) {
      setError("room", t("err.connLost"));
      setError("main", t("err.noConn"));
    }
  };
}

export function resumeOnlineIfSaved() {
  if (net.resumeIfSaved()) reconnect.set({ msg: t("rec.resuming"), gaveUp: false });
  else net.connect(); // conectar temprano: el ping se ve desde el menú
}

export function giveUpReconnect() {
  net.forget();
  location.reload();
}

export function setRoomMode(mode: RoomMode) { net.send({ t: "setMode", mode }); }
export function setRoomRounds(n: number) { net.send({ t: "setRounds", rounds: n }); }
export function startRoomMatch() { net.send({ t: "start" }); }

/* ---------------------------------------------------------------- HUD / final */
/** Botón "salir/cortar" del HUD, según el modo en curso. */
export function hudEnd() {
  const s = engine.session;
  if (!s) return;
  if (s.kind === "online") { net.send({ t: "endMatch" }); return; }
  if (s.kind === "local") { exitLocalToSetup(); return; }
  if (s instanceof StorySession || s instanceof SagaSession) { s.exit(); return; }
  backToMenu("solo");
}

export function rematch() {
  if (isLocalActive()) { rematchLocal(); return; }
  if (online) net.send({ t: "again" });
}

export function finalChangeMode() {
  exitLocalToSetup();
}

export function finalBackToMenu() {
  if (online) { leaveOnlineRoom(); return; }
  backToMenu();
}

export function isFinalOpen() {
  return !!get(finalScreen);
}
