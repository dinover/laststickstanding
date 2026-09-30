import "./ui/theme.css";
import { mount } from "svelte";
import App from "./ui/App.svelte";
import { audio } from "./audio/audio";

audio.armUnlock();

const app = mount(App, { target: document.getElementById("app")! });

export default app;
