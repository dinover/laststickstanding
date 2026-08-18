/* Ajuste de combate EXCLUSIVO del build web (online + Práctica Libre).
   Se aplica via Sim.init({ attacks }) sobre los valores por defecto de ../desktop/sim.js, que
   quedan intactos: los builds de escritorio y Steam siguen jugando como siempre.

   Cargado en DOS contextos con el mismo archivo, sin bundler:
   - Node (sim-host.js, autoridad real de las salas online): `require("./balance")`.
   - Navegador (Práctica Libre, que corre Sim de verdad en el cliente — ver online/public/
     index.html): `<script src="/balance.js">`, sirviéndose vía la ruta agregada en server.js.
   El bloque final expone lo mismo por los dos caminos sin duplicar los números.

   Diseño (2026-08-18, versión previa al relanzamiento): la piña es el ataque dominante — más
   rápida Y más daño — y la patada vive pura y exclusivamente del empuje.

     - La piña sigue siendo el DOBLE de rápida que la patada (190 ms de cooldown contra 380),
       así que entran exactamente dos piñas en el tiempo de una patada.
     - La piña pega el DOBLE que la patada por golpe (16 contra 8): antes era al revés
       (patada 15, piña 9). Ahora no hay ningún escenario donde convenga elegir patada por
       daño — su única razón de ser es el empuje.
     - El empuje de la piña sigue siendo casi nulo (0.8): ni con el daño más alto se puede usar
       para sacar a nadie de la plataforma.
     - La patada empuja fuerte (4.2 en X, -3.0 en Y): sigue siendo la única herramienta para
       sacar al rival del borde. Paga esa utilidad con una brecha de daño enorme.

   DPS con los números nuevos:

     piña   16 daño / 0.19 s = 84.2 daño/s
     patada  8 daño / 0.38 s = 21.1 daño/s

   La piña gana la carrera de daño por goleada — es la decisión de diseño explícita de esta
   vuelta, no un descuido: la patada deja de competir en daño sostenido y pasa a ser
   estrictamente una herramienta de espacio/cierre de ronda, no una alternativa de DPS. */

var BALANCE_ATTACKS = {
  punch: {
    dur: 140,       // mitad exacta de la patada: la animación también tiene que leerse rápida
    cooldown: 190,  // mitad exacta de la patada -> dos piñas por patada
    damage: 16,     // el doble de la patada — ver diseño arriba
    reach: 34,
    kbX: 0.8,       // "apenas hacia atrás" — el empuje sigue siendo cosa de la patada, no de esto
    kbY: 0,
    hitStun: 110,
    hitStop: 25,    // corto a propósito: un hitstop largo arruinaría el ritmo del ataque rápido
    trauma: 0.22,
    squash: 0.3,
  },
  kick: {
    dur: 280,
    cooldown: 380,
    damage: 8,      // la mitad de la piña — ver diseño arriba
    reach: 44,
    kbX: 4.2,
    kbY: -3.0,
    hitStun: 220,
    hitStop: 60,
    trauma: 0.55,
    squash: 0.6,
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { attacks: BALANCE_ATTACKS };
}
if (typeof window !== "undefined") {
  window.BALANCE = { attacks: BALANCE_ATTACKS };
}
