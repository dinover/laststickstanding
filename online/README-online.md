# Last Stick Standing — build online (servidor autoritativo en Fly.io)

Versión web con **servidor dedicado**: el juego se simula en Fly.io (São Paulo) y los jugadores
solo entran con un link. Nadie instala nada y nadie hostea.

Es la tercera forma de jugar online, al lado de las que ya existen:

| Build | Transporte | Quién simula | Instalación |
|---|---|---|---|
| `index.html` / `desktop/` | WebRTC (PeerJS) | un jugador | ninguna / Electron |
| `steam/` | Steam Networking | un jugador | Steam |
| `online/` (este) | WebSocket | **el servidor** | ninguna |

## Qué cambia respecto al P2P

- **Nadie tiene ventaja.** Antes el host simulaba local (0 ms de input lag) y el resto pagaba
  RTT completo. Con cooldowns de 380 ms eso era una ventaja competitiva real. Ahora todos
  miden lo mismo contra São Paulo.
- **Se cae el broker público de PeerJS**, que era el punto de falla más probable justo cuando
  8 personas se conectan a la vez.
- **Se cae TURN por completo.** No hay NAT traversal: cada cliente abre una conexión saliente
  al 443. El relay público de `openrelay.metered.ca` que usa `net.js` no participa.
- **La partida sobrevive** si el que creó la sala se va.
- **Todos escuchan los efectos de sonido.** En el build P2P solo el host los oía, porque los
  disparaba la simulación y los guests no simulaban. El servidor los graba y los manda en el
  snapshot.

## No hay una cuarta copia de sim.js

`sim-host.js` **lee y evalúa** `../stickman.js`, `../fx.js`, `../world.js` y `../desktop/sim.js`
tal cual, en un contexto `vm` de Node por sala. Un cambio de gameplay en `desktop/sim.js` lo toma
este servidor sin ningún paso de porteo.

Un contexto por sala porque `sim.js` guarda todo su estado en variables de módulo: con un solo
`require` todas las salas compartirían la misma partida. Los scripts se compilan una vez
(`vm.Script`) y se re-ejecutan por sala, que es la parte cara.

Lo único que se sustituye es `AudioManager` (es WebAudio puro, no existe headless), y no por un
no-op sino por un grabador: los eventos viajan al cliente en `snap.sfx`.

## Correr en local

```bash
cd games/laststickstanding/online
npm install
npm start
```

Abrí `http://localhost:8080` en dos pestañas: en una "Crear sala", en la otra "Unirme" con ese
código. Andá a `http://localhost:8080/health` para ver salas y jugadores conectados.

## Deploy en Fly.io

`fly.toml` y `Dockerfile` viven en la **raíz del repo** (no acá), porque el servidor necesita
`stickman.js`, `fx.js`, `world.js` y `desktop/sim.js`, que están un nivel más arriba.

```bash
fly deploy
```

### Dos cosas que no se pueden tocar

1. **`primary_region = "gru"`** (São Paulo). Es la región más cercana a Argentina que tiene Fly:
   ~25-40 ms desde Buenos Aires contra ~120-150 ms de cualquier región de EE.UU. En un juego de
   pelea esa diferencia decide partidas. Render no sirve para esto: no tiene región en Sudamérica.

2. **Una sola máquina.** Las salas viven en la memoria del proceso. Si Fly levanta una segunda,
   dos jugadores con el mismo código pueden caer en máquinas distintas y no verse nunca.

   ```bash
   fly scale count 1
   ```

   Para repartir en varias máquinas haría falta mover el estado de salas a Redis y usar sticky
   sessions — no vale la pena para 8 amigos.

### Arranque en frío

`auto_stop_machines = "suspend"` con `min_machines_running = 0`: la máquina se congela cuando no
hay nadie y despierta en ~1 s. Si preferís cero espera para el primero que entra, poné
`min_machines_running = 1` (pasa a facturar 24/7).

## Números medidos

Test de integración con 8 clientes reales (partida completa de 3 rondas) y medición de latencia
contra el servidor desplegado, desde Buenos Aires:

| | |
|---|---|
| RTT a `gru` (São Paulo) | **30 ms**, 0% de pérdida |
| **Input lag** (tecla → visible en snapshot) | **53 ms** de mediana |
| Cadencia de snapshots | 32,3 ms de mediana (objetivo 33) |
| Snapshot promedio | ~2.270 bytes |
| Bajada por cliente | ~545 kbps |
| **Subida del servidor con 8 jugadores** | **~4,4 Mbps** |
| CPU de simulación | ~16.000 ticks/s en frío (hacen falta 60) |

El input lag arrancó en **69 ms** y bajó a 53 sin agregar predicción del lado del cliente, con
dos cambios en `server.js`:

- **El acumulador de broadcast reseteaba a 0 en vez de restar el intervalo.** Como el tick real
  dura ~16,6 ms, el umbral de 40 ms recién se cruzaba en el tercer tick y el sobrante se tiraba:
  los snapshots salían cada ~50 ms (20 Hz medidos), no cada 40.
- **El intervalo pasó a 33 ms**, que cae justo en el segundo tick (16,6 × 2 = 33,2). Cadencia
  pareja y ~9 ms menos de espera promedio.

Quedan picos ocasionales (~500 ms, ~1,6% de los frames) que son contención de CPU del
`shared-cpu-1x`. Si molestan, la salida es una VM dedicada, no tocar el código.

Dos optimizaciones bajaron el payload ~45% sin tocar `sim.js` (`compressSnapshot`):

- **Redondeo de floats.** `Sim.snapshot()` emite `"x":299.34149729142337`; a 1 decimal sobra
  para un canvas de 960x540 donde además el cliente interpola.
- **El mapa se manda una vez por ronda**, no en cada tick. Era el 24% del payload.

## Reconexión

Un corte de conexión ya no te deja afuera de la partida. Al entrar, el servidor emite un
**token** que el cliente guarda en `sessionStorage` (por pestaña, así dos pestañas en la misma
PC no se pisan). Si el socket se cae:

1. El cliente reintenta solo, con backoff creciente hasta 12 veces, mostrando un overlay.
2. El servidor **le guarda el slot 30 segundos** (`REJOIN_GRACE_MS`) con su puntaje y su lugar
   en el roster. Su muñeco se queda quieto — y por lo tanto es carne de cañón.
3. Al volver con el token recupera el mismo id y sigue jugando.
4. Si vence la gracia, ahí sí se libera el slot y el cuerpo se baja (`dropBody`).

Detalles que importan:

- El token es obligatorio: sin él, cualquiera que viera el código de sala podría robarle el
  lugar a otro en mitad de una partida.
- Se acepta la reconexión **aunque el socket viejo figure abierto**. Cuando se corta el wifi el
  servidor tarda hasta un ciclo de heartbeat en enterarse, y para entonces el jugador ya apretó
  F5. Quien presenta el token es el dueño legítimo y se echa al socket viejo.
- Al reconectar se limpian las teclas: si se cayó con "derecha" apretada, nunca llegó el keyup
  y el muñeco seguiría empujando solo.
- El heartbeat es de 10 s (antes 30). Hacen falta dos ciclos para dar a alguien por muerto, así
  que el peor caso bajó de ~60 s a ~20 s de fantasma en la ronda.

## Modos de juego (solo web)

El modo se elige **al crear la sala**, antes de que exista — no se puede cambiar después sin
crear una sala nueva. Queda fijo en `room.mode`/`room.rounds` y todos los que se unen lo ven
como un resumen de solo lectura en el lobby.

- **Por rondas** — el de siempre. El anfitrión elige 1–20 rondas; termina sola al llegar a la
  última.
- **Infinito** — ronda tras ronda sin límite. El puntaje **nunca se resetea**, acumula desde la
  ronda 1 hasta que el anfitrión corta la partida a mano (botón "Terminar partida", visible
  solo para el dueño de la sala mientras el modo es infinito y hay una partida en curso). Cada
  5 rondas (5, 10, 15…) vuelve al mapa inicial, igual que la ronda 1 — el resto son mapas
  procedurales normales.
- **Historia** — modo contra IA. Todavía no existe; el botón está en la UI pero deshabilitado
  ("Próximamente"). Se construye al final, como su propio bloque de trabajo.

Implementación: `desktop/sim.js` gana un tercer parámetro opcional en `startMatch(rounds, snail,
opts)` — `opts.mode: "infinite"` activa el modo sin límite. Sin ese parámetro (como llaman
`desktop/game.html` y `steam/game.html`, con solo 2 argumentos) el comportamiento es
**exactamente** el de siempre; los builds de escritorio y Steam no tienen ni pueden tener modo
infinito. `Sim.forceEndMatch()` es el nuevo método que corta una partida infinita ya mismo, con
el puntaje acumulado hasta la última ronda completa — el servidor lo expone solo al dueño de la
sala y solo en modo infinito (`endMatch` en `server.js`).

Un detalle de transporte: `totalRounds` viaja como `Infinity` dentro del proceso, pero
`JSON.stringify(Infinity)` da `null` — así llega al cliente, que lo interpreta como "∞" en el
cartel de ronda.

## Balance de combate (solo web)

`balance.js` ajusta el combate **únicamente de este build**. Se aplica con
`Sim.init({ attacks })` sobre los valores por defecto de `../desktop/sim.js`, que quedan
intactos: escritorio y Steam siguen jugando igual que siempre.

| | piña | patada |
|---|---|---|
| Duración | 140 ms | 280 ms |
| Cooldown | 190 ms | 380 ms |
| Daño | 8 | 15 |
| Empuje (kbX) | 0,8 | 3,6 |

Entran exactamente **dos piñas en el tiempo de una patada**. El equilibrio no está en el daño
por golpe sino en el DPS: piña 42,1/s contra patada 39,5/s. La piña gana por poco en daño
sostenido — si no, sería estrictamente peor y nadie la usaría. Lo que compra la patada no es
DPS sino **espacio**: con `kbX 3.6` y `kbY -2.5` saca al rival de la plataforma, y en este juego
caerse es morir.

Para tocar el balance no hace falta entender el servidor: es un solo archivo de constantes.

Dos optimizaciones del lado del servidor bajaron el payload ~45% sin tocar `sim.js`
(`compressSnapshot` en `server.js`):

- **Redondeo de floats.** `Sim.snapshot()` emite `"x":299.34149729142337`; a 1 decimal sobra
  para un canvas de 960x540 donde además el cliente interpola.
- **El mapa se manda una vez por ronda**, no en cada tick. Era el 24% del payload y no cambia
  en toda la ronda. El cliente cachea el último que recibió.

## Detalles que pueden sorprender

**Desconexión en medio de una partida.** No se puede usar `Sim.removePlayer()`: `sim.js` decide
el fin de ronda contando vivos *dentro* de `eliminate()`, así que sacar a un jugador vivo sin
pasar por ahí deja la ronda colgada para siempre. En vez de eso el servidor le tira el cuerpo
fuera del mapa (`dropBody`) y `stepPlayer` lo elimina por el camino normal, que sí cierra la
ronda y respeta el orden de eliminación para el puntaje.

Y como `spawnRoundPlayers()` revive a **todo** el roster al empezar cada ronda, incluidos los que
se fueron, `dropGhosts()` los vuelve a bajar en cada `roundStart`. Sin eso, la ronda siguiente a
una desconexión arranca con un fantasma parado que nadie controla y que nadie puede matar.

**`window.SNAIL_MODE`.** El cliente de este build lo setea desde el snapshot. Los builds
`desktop/` y `steam/` nunca lo setean, así que ahí el modo caracol solo apaga las partículas y
los trails de `sim.js`, pero no los efectos de `fx.js`, `world.js` ni `stickman.js`, que leen esa
variable global. Si querés emparejarlos, es una línea en `game.html`.

**`HitStop` está muerto en el build de escritorio.** `sim.js` llama a `HitStop.trigger()` en cada
golpe, pero `desktop/game.html` nunca llama a `HitStop.update()` ni chequea `active()` (el viejo
`index.html` sí lo hacía). El servidor replica el comportamiento actual a propósito, para que la
simulación sea idéntica a la que ya probaste. Si querés recuperar los freeze frames hay que
tocarlo en los dos lados a la vez, porque cambia el timing de la simulación.
