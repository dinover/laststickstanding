/* Carga la simulación EXISTENTE del navegador (../stickman.js, ../fx.js, ../world.js,
   ../desktop/sim.js) en un contexto headless de Node, uno aislado por sala.

   Deliberadamente NO es una cuarta copia de sim.js. Los archivos se leen del disco y se
   evalúan tal cual, así que un cambio de gameplay en desktop/sim.js lo toma este servidor
   sin ningún paso de porteo. Ya hay dos copias (desktop/ y steam/) que el README de desktop
   afirma idénticas y que en la práctica ya divergieron; una tercera copia manual sería el
   punto en que la divergencia deja de ser un comentario y pasa a ser un bug.

   Por qué vm y no require(): sim.js guarda TODO su estado en variables de módulo (phase,
   roster, players, orb...). Un solo `require` daría una única partida global compartida por
   todas las salas. Cada contexto de vm es un juego de globals nuevo, así que cada sala tiene
   su propio Sim completamente aislado. Los scripts se compilan una sola vez (vm.Script) y se
   re-ejecutan por sala, que es la parte cara. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const BALANCE = require("./balance");

const ROOT = path.join(__dirname, "..");

/* Mismo orden que los <script> de desktop/game.html: stickman.js define POWER_COLORS (que
   sim.js lee para los orbes), fx.js define Camera/HitStop/Particles/Trails/ScreenFX, y
   world.js define World (generateMap + checkHazards, ambos autoritativos). */
const SOURCE_FILES = [
  path.join(ROOT, "stickman.js"),
  path.join(ROOT, "fx.js"),
  path.join(ROOT, "world.js"),
  path.join(ROOT, "desktop", "sim.js"),
];

const SCRIPTS = SOURCE_FILES.map(
  (file) => new vm.Script(fs.readFileSync(file, "utf8"), { filename: file })
);

/* Tope defensivo: si un broadcast se demora, el buffer de sfx no puede crecer sin límite. */
const MAX_SFX_PER_FLUSH = 48;

function createSim(onPhaseChange) {
  let sfx = [];

  /* AudioManager es el único global de navegador que la simulación llama y que no tiene
     equivalente headless (audio.js es WebAudio puro). En vez de un no-op, esto lo GRABA: la
     simulación corre acá, así que si el servidor se tragara los eventos de sonido nadie
     escucharía golpes ni KOs — en el build P2P al menos el host los oía porque simulaba local.
     Grabándolos y mandándolos en el snapshot, los 8 jugadores escuchan lo mismo, que es más
     de lo que tenían los guests antes.

     Proxy en vez de una lista explícita de métodos para que agregar un AudioManager.on.loQueSea
     nuevo en sim.js no tire abajo el servidor. El guard de string es porque el Proxy también
     intercepta Symbol.toPrimitive / util.inspect cuando algo intenta serializar el objeto. */
  const audioRecorder = {
    on: new Proxy(
      {},
      {
        get(_target, name) {
          if (typeof name !== "string") return undefined;
          return function () {
            if (sfx.length >= MAX_SFX_PER_FLUSH) return;
            sfx.push({ n: name, a: Array.prototype.slice.call(arguments) });
          };
        },
      }
    ),
    armUnlock() {},
    getSettings() {
      return {};
    },
  };

  const sandbox = {
    console,
    performance,
    /* fx.js, world.js y stickman.js leen window.SNAIL_MODE directo (sin copia cacheada).
       Lo dejamos en false a propósito: es lo que tiene un host normal en el navegador, y
       así la simulación del servidor es idéntica bit a bit a la que ya probaste. Ponerlo en
       true ahorraría el update del pool de partículas (220 slots a 60 Hz — irrelevante) a
       cambio de introducir una diferencia de comportamiento que no hace falta. */
    window: { SNAIL_MODE: false },
    AudioManager: audioRecorder,
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  for (const script of SCRIPTS) script.runInContext(sandbox);

  const Sim = sandbox.Sim;
  if (!Sim) throw new Error("sim.js no expuso Sim en el contexto");

  /* colorFor/nameFor solo los usa el path de dibujo y los colores de partículas, que acá no
     se ven; los clientes ponen los suyos. onPhaseChange sí importa: es como el servidor se
     entera de roundStart/final para avisarle a todos.

     `attacks` es el balance propio del build web (ver balance.js). Como cada sala tiene su
     contexto vm, esto se aplica por sala y no puede filtrarse a otra. Los clientes no lo
     necesitan: la duración de cada ataque les llega dentro del snapshot (attack.dur), que es
     lo único que mira drawStickman para animar. */
  Sim.init({
    onPhaseChange: onPhaseChange || function () {},
    attacks: BALANCE.attacks,
  });

  return {
    sim: Sim,
    takeSfx() {
      if (!sfx.length) return null;
      const out = sfx;
      sfx = [];
      return out;
    },
  };
}

module.exports = { createSim, SOURCE_FILES };
