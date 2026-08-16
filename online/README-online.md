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

Test de integración con 8 clientes reales, partida completa de 3 rondas:

| | |
|---|---|
| Snapshot promedio | 2.262 bytes (máx. 3.402) |
| Bajada por cliente | ~450 kbps |
| **Subida del servidor con 8 jugadores** | **~3,6 Mbps** |
| CPU de simulación | ~16.000 ticks/s en frío (hacen falta 60) |
| Tráfico por hora de partida | ~1,6 GB |

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
