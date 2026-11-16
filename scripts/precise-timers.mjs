/* Solo para las mediciones de red (scripts/twoview.ts): en Windows los timers de Node tienen
   ~15,6 ms de resolución, así que setInterval(4) del loop de sala dispara cada 16 ms y cualquier
   demora simulada sale redondeada para arriba. En Linux (producción) no pasa. Esto reemplaza los
   timers cortos por un sondeo con setImmediate (gasta un núcleo, pero da precisión de ~0,1 ms)
   para que lo medido acá se parezca a lo que pasa en la VM. */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const LIMIT = 40;
const timers = new Set();
let spinning = false;

function spin() {
  if (!timers.size) { spinning = false; return; }
  const now = performance.now();
  for (const t of [...timers]) {
    if (now < t.at || !timers.has(t)) continue;
    if (t.every) t.at += t.every;
    else timers.delete(t);
    t.fn(...t.args);
  }
  setImmediate(spin);
}

function add(fn, ms, args, every) {
  const t = {
    fn, args, every, at: performance.now() + Math.max(0, ms || 0),
    ref() { return t; }, unref() { return t; }, hasRef() { return true; },
    refresh() { t.at = performance.now() + Math.max(0, ms || 0); return t; },
  };
  timers.add(t);
  if (!spinning) { spinning = true; setImmediate(spin); }
  return t;
}

globalThis.setTimeout = (fn, ms, ...args) =>
  typeof fn === "function" && !(ms >= LIMIT) ? add(fn, ms, args, 0) : realSetTimeout(fn, ms, ...args);
globalThis.setInterval = (fn, ms, ...args) =>
  typeof fn === "function" && !(ms >= LIMIT) ? add(fn, ms, args, Math.max(1, ms || 1)) : realSetInterval(fn, ms, ...args);
globalThis.clearTimeout = (t) => { if (timers.has(t)) timers.delete(t); else realClearTimeout(t); };
globalThis.clearInterval = (t) => { if (timers.has(t)) timers.delete(t); else realClearInterval(t); };
