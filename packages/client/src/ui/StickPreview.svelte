<script lang="ts">
  /* El muñeco del juego (el mismo esqueleto y pintor V2) en un canvas chico: guardia de peleador en
     el menú y la personalización, festejo con saltos y patadas en la pantalla de victoria. Se dibuja
     con el adaptador Canvas 2D del pintor, así no hace falta otro contexto WebGL. */
  import { onMount } from "svelte";
  import { drawAccessory, type RenderPlayer } from "../render/art/stickman";
  import { CanvasPen } from "../render/canvasPen";
  import { solveRig, type RigState } from "../render/rig";
  import { hatDrop, hexN, paintStick } from "../render/stickPaint";

  let { color = "#35f0e0", hat = "none", mode = "idle", width = 150, height = 160, scale = 1.6, feetY = 138 }:
    { color?: string; hat?: string; mode?: "idle" | "dance"; width?: number; height?: number; scale?: number; feetY?: number } = $props();

  let canvas: HTMLCanvasElement;

  onMount(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    const pen = new CanvasPen(ctx);
    const p: RenderPlayer = {
      id: 1, x: 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true, alive: true, attack: null, walkCycle: 0,
      idleT: Math.random() * 10, squash: 0, jumpAnticT: 0, hitStunT: 0, hitDir: 1, power: null, burnT: 0, slowT: 0,
      burnFlashT: 0, hp: 100, deathFadeT: 0, jumpsLeft: 2,
    };
    const st: RigState = {};
    let raf = 0, last = performance.now(), actT = 0, step = 0;
    const frame = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      p.idleT += dt * 0.001;
      if (mode === "dance") {
        // festejo: salto, doble salto con mortal, patada al caer, y otra vez para el otro lado
        const f = dt / 16.667;
        p.squash = Math.max(0, p.squash - dt / 180);
        p.jumpAnticT = Math.max(0, p.jumpAnticT - dt);
        if (p.attack) { p.attack.t -= dt; if (p.attack.t <= 0) p.attack = null; }
        actT -= dt;
        if (p.grounded) {
          if (actT <= 0) { p.grounded = false; p.vy = -9.5; p.jumpAnticT = 90; p.jumpsLeft = 1; step = 0; }
        } else {
          p.vy += (p.vy < 0 ? 0.95 : 0.7) * f;
          p.y += p.vy * f;
          if (step === 0 && p.vy > -2) { p.vy = -7.5; p.jumpsLeft = 0; step = 1; }
          else if (step === 1 && p.vy > 4 && !p.attack) { p.attack = { type: "kick", t: 280, dur: 280 }; step = 2; }
          if (p.y >= 0) {
            p.y = 0; p.vy = 0; p.grounded = true; p.squash = 1; p.jumpsLeft = 2; actT = 520;
            p.facing = p.facing > 0 ? -1 : 1;
          }
        }
      }
      const r = solveRig(p, st);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (width / 2) * dpr, feetY * dpr);
      paintStick({ ground: pen, body: pen, front: pen }, p, r, hexN(color), { low: false, head: "ring", whiten: 0, powerUp: 0 });
      if (hat && hat !== "none") {
        ctx.save();
        ctx.translate(r.head.x, r.head.y);
        ctx.rotate(r.headLean * r.facing * (Math.PI / 180));
        drawAccessory(ctx, hat, 0, hatDrop(hat, "ring"), 0, r.facing, p.idleT);
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas bind:this={canvas} style="width:{width}px;height:{height}px;--glow:{color}" class="stick-preview"></canvas>

<style>
  /* el brillo lo pone el compositor (en el juego lo hace el bloom de WebGL) */
  .stick-preview { display: block; max-width: 100%; filter: drop-shadow(0 0 5px color-mix(in srgb, var(--glow) 55%, transparent)); }
</style>
