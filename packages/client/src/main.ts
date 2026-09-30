import "./ui/theme.css";
import { mount } from "svelte";
import App from "./ui/App.svelte";
import { audio } from "./audio/audio";

audio.armUnlock();

const app = mount(App, { target: document.getElementById("app")! });

// Solo en desarrollo: acceso al motor desde la consola para probar pantallas sin jugar una partida entera.
if (import.meta.env.DEV) {
  void import("./game/engine").then(({ engine }) => { (window as unknown as { __lss: unknown }).__lss = { engine }; });
}

export default app;
