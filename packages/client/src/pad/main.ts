import "../ui/theme.css";
import { mount } from "svelte";
import Pad from "./Pad.svelte";

mount(Pad, { target: document.getElementById("pad-app")! });
