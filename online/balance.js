/* Ajuste de combate EXCLUSIVO del build web (online + Práctica Libre).
   Se aplica via Sim.init({ attacks }) sobre los valores por defecto de ../desktop/sim.js, que
   quedan intactos: los builds de escritorio y Steam siguen jugando como siempre.

   Cargado en DOS contextos con el mismo archivo, sin bundler:
   - Node (sim-host.js, autoridad real de las salas online): `require("./balance")`.
   - Navegador (Práctica Libre, que corre Sim de verdad en el cliente — ver online/public/
     index.html): `<script src="/balance.js">`, sirviéndose vía la ruta agregada en server.js.
   El bloque final expone lo mismo por los dos caminos sin duplicar los números.

   Diseño (2026-08-18, ajustado tras la primera prueba real post-relanzamiento): la piña sigue
   siendo el ataque de ritmo — más rápida — pero con menos daño que en la vuelta anterior (mataba
   demasiado rápido en la práctica). La patada gana MUCHO más empuje: ahora sirve de verdad para
   ir corriendo jugadores hacia el borde, en una parábola baja (bastante hacia atrás, apenas
   hacia arriba — no un pop alto).

     - La piña sigue siendo el DOBLE de rápida que la patada (190 ms de cooldown contra 380).
     - Daño de la piña bajado de 16 a 11 tras la prueba real: seguía ganando por demasiado
       margen y las rondas terminaban muy rápido. La patada mantiene su daño (8).
     - El empuje de la piña sigue siendo casi nulo (0.8): no compite con la patada en espacio.
     - Empuje de la patada subido de 4.2 a 7.5 en X (bastante más — es su única razón de
       existir) y bajado de -3.0 a -1.4 en Y (menos "pop" vertical, apenas un salto chico:
       "hacia atrás y un poquito arriba, no mucho").

   DPS con los números nuevos:

     piña   11 daño / 0.19 s = 57.9 daño/s
     patada  8 daño / 0.38 s = 21.1 daño/s

   La piña sigue ganando en daño sostenido (menos por goleada que antes), la patada sigue
   siendo la única herramienta de espacio/cierre de ronda — ahora con un empuje que realmente
   se nota. */

var BALANCE_ATTACKS = {
  punch: {
    dur: 140,       // mitad exacta de la patada: la animación también tiene que leerse rápida
    cooldown: 190,  // mitad exacta de la patada -> dos piñas por patada
    damage: 11,     // bajado de 16 tras la prueba real — mataba demasiado rápido
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
    damage: 8,
    reach: 44,
    kbX: 7.5,       // subido de 4.2 — tiene que servir para ir corriendo jugadores de verdad
    kbY: -1.4,      // bajado de -3.0 — parábola baja: "hacia atrás y apenas arriba", no un pop alto
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
