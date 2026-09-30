<script lang="ts">
  /* El muñeco real (misma drawStickman del juego) en un canvas chico: idle en la personalización,
     festejo con patadas y estela en la pantalla de victoria. */
  import { onMount } from "svelte";
  import { drawStickman, drawStickShine, type RenderPlayer, type RigAnim, type RigInfo } from "../render/art/stickman";

  let { color = "#35f0e0", hat = "none", mode = "idle", width = 150, height = 160, scale = 1.6, feetY = 138 }:
    { color?: string; hat?: string; mode?: "idle" | "dance"; width?: number; height?: number; scale?: number; feetY?: number } = $props();

  let canvas: HTMLCanvasElement;

  onMount(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    const p: RenderPlayer = {
      id: 1, x: 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true, alive: true, attack: null, walkCycle: 0,
      idleT: Math.random() * 10, squash: 0, jumpAnticT: 0, hitStunT: 0, hitDir: 1, power: null, burnT: 0, slowT: 0,
      burnFlashT: 0, hp: 100, deathFadeT: 0,
    };
    const anim: RigAnim = {};
    const info = {} as RigInfo;
    const trail: RenderPlayer[] = [];
    let raf = 0, last = performance.now(), kickT = 0, crouchT = 0, trailT = 0;
    const frame = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      p.idleT += dt * 0.001;
      if (mode === "dance") {
        const f = dt / 16.667;
        p.squash = Math.max(0, p.squash - dt / 180);
        p.jumpAnticT = Math.max(0, p.jumpAnticT - dt);
        if (p.grounded) {
          crouchT -= dt;
          if (crouchT <= 0) { p.grounded = false; p.vy = -7.2; p.jumpAnticT = 90; }
        } else {
          p.vy += 0.94 * f;
          p.y += p.vy * f;
          if (p.y >= 0) { p.y = 0; p.vy = 0; p.grounded = true; p.squash = 1; crouchT = 90; }
        }
        if (p.attack) { p.attack.t -= dt; if (p.attack.t <= 0) p.attack = null; }
        kickT += dt;
        if (kickT >= 170) { kickT = 0; p.facing = p.facing > 0 ? -1 : 1; p.attack = { type: "kick", t: 150, dur: 150 }; }
        p.x = p.facing * Math.sin((kickT / 170) * Math.PI) * 26;
        if (now - trailT > 18) { trailT = now; trail.push({ ...p, attack: p.attack ? { ...p.attack } : null }); if (trail.length > 6) trail.shift(); }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (width / 2) * dpr, feetY * dpr);
      if (mode === "dance") {
        trail.forEach((g, i) => { ctx.save(); ctx.globalAlpha = 0.05 + (i / trail.length) * 0.3; drawStickman(ctx, g, color, hat, null); ctx.restore(); });
      }
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      drawStickman(ctx, p, color, hat, anim, info);
      ctx.restore();
      drawStickShine(ctx, info);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas bind:this={canvas} style="width:{width}px;height:{height}px" class="stick-preview"></canvas>

<style>
  .stick-preview { display: block; max-width: 100%; }
</style>
