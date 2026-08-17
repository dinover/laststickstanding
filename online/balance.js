/* Ajuste de combate EXCLUSIVO del build web.
   Se aplica via Sim.init({ attacks }) sobre los valores por defecto de ../desktop/sim.js, que
   quedan intactos: los builds de escritorio y Steam siguen jugando como siempre.

   Diseño: la piña es el ataque de ritmo y la patada el de castigo.

     - La piña es literalmente el DOBLE de rápida que la patada (190 ms de cooldown contra
       380), así que entran exactamente dos piñas en el tiempo de una patada.
     - La patada pega casi el doble por golpe (15 contra 8) y empuja mucho más.
     - El empuje de la piña es apenas un cosquilleo (0.8 contra 3.6): sirve para acumular daño,
       no para mover al rival.

   El equilibrio real está en el DPS, no en el daño por golpe:

     piña   9 daño / 0.19 s = 47.4 daño/s
     patada 15 daño / 0.38 s = 39.5 daño/s

   La piña gana en daño sostenido — si no, sería estrictamente peor que la patada y nadie la
   usaría. Lo que compra la patada no es DPS sino ESPACIO: con kbX 4.2 y kbY -3.0 saca al rival
   de la plataforma más lejos que antes, y en este juego caerse es morir. O sea: piña para
   ganar la carrera de daño, patada para cerrar la ronda de un empujón — ahora un empujón más
   contundente. */

module.exports = {
  attacks: {
    punch: {
      dur: 140,       // mitad exacta de la patada: la animación también tiene que leerse rápida
      cooldown: 190,  // mitad exacta de la patada -> dos piñas por patada
      damage: 9,      // +1: un poco más de fuerza sin romper el diseño (sigue ganando por poco, no por mucho)
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
      damage: 15,
      reach: 44,
      kbX: 4.2,       // +0.6: empuja más lejos de la plataforma
      kbY: -3.0,      // +0.5: despega un poco más del piso, mismo motivo
      hitStun: 220,
      hitStop: 60,
      trauma: 0.55,
      squash: 0.6,
    },
  },
};
