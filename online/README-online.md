# Last Stick Standing — build online (servidor autoritativo en Oracle Cloud)

Versión web con **servidor dedicado**: el juego se simula en una VM del Always Free tier de
Oracle Cloud (región São Paulo) y los jugadores solo entran con un link. Nadie instala nada y
nadie hostea. Ver [`oracle/README-oracle.md`](../oracle/README-oracle.md) para el deploy completo
(creación de la VM, firewall, TLS).

Historial: corrió antes en Fly.io (`gru`, misma latencia que Oracle ahora) y brevemente en Render
(free tier, pero sin región en Sudamérica — ver el comentario que queda más abajo en la sección
vieja de deploy, dejado como referencia).

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

## Deploy en Render (histórico — se migró a Oracle Cloud, ver arriba)

`render.yaml` y `Dockerfile` viven en la **raíz del repo** (no acá), porque el servidor necesita
`stickman.js`, `fx.js`, `world.js` y `desktop/sim.js`, que están un nivel más arriba. Render lee
el mismo `Dockerfile` que se usaba para Fly sin cambios: el server ya escucha en
`process.env.PORT` sobre `0.0.0.0`, que es lo único que Render exige.

Pasos (Blueprint, usa el `render.yaml` del repo):

1. En el dashboard de Render: **New → Blueprint**, conectá el repo `dinover/laststickstanding`.
2. Render detecta `render.yaml` solo. Confirmá el plan **Free** y creá el servicio.
3. Cuando termina el build, la URL queda tipo `https://laststickstanding.onrender.com`.
4. Verificá `/<url>/health` para ver salas y jugadores conectados, igual que en local.

**Advertencia de latencia (importante, decisión consciente):** Render no tiene región en
Sudamérica. La más cercana es Ohio (`us-east`), ~120-150 ms desde Buenos Aires contra los ~30 ms
que daba Fly en `gru` (São Paulo). En un juego de pelea con cooldowns de 190-380 ms esa diferencia
se siente. Se eligió Render igual por el free tier; si en algún momento la latencia molesta más
que el costo, la salida es volver a Fly con un plan pago mínimo (`shared-cpu-1x` sale unos pocos
dólares/mes sin el free tier) o probar Koyeb/otro proveedor con región en Sudamérica.

### Una sola instancia (no hay que forzarlo)

Las salas viven en la memoria del proceso: si hubiera dos instancias corriendo, dos jugadores con
el mismo código de sala podrían caer en máquinas distintas y no verse nunca. En Fly había que
acordarse de `fly scale count 1`; en Render el plan **Free** no escala instancias, así que esto ya
viene garantizado sin tocar nada. Si en el futuro se pasa a un plan pago con autoscaling, hay que
fijar el número de instancias en 1 a mano (o mover el estado de salas a Redis con sticky sessions,
que no vale la pena para partidas de pocos amigos).

### Arranque en frío (peor que Fly)

El plan Free de Render apaga la instancia tras **15 minutos sin tráfico HTTP entrante** y tarda
entre **30 y 60 segundos** en volver a arrancar con el próximo pedido — mucho más lento que el
`suspend` de Fly (~1 s). El primer jugador que entra después de un rato de inactividad ve una
pantalla en blanco/cargando durante ese arranque; conviene avisar en la UI o poner un mensaje de
"despertando servidor..." si esto genera confusión. No hay forma de evitarlo en el plan Free sin
pagar (el plan Starter, ~7 USD/mes, no duerme).

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

- **Por rondas** — el de siempre. El anfitrión elige 1–20 rondas al crear la sala, y **puede
  seguir ajustándolo mientras espera en el lobby** (mensaje `setRounds`, solo antes de
  arrancar): cada cambio se sincroniza en vivo a todos los que ya están adentro, no solo al
  dueño. Termina sola al llegar a la última ronda.
- **Infinito** — ronda tras ronda sin límite. El puntaje **nunca se resetea**, acumula desde la
  ronda 1 hasta que el anfitrión corta la partida a mano (botón "Terminar partida", visible
  solo para el dueño de la sala mientras el modo es infinito y hay una partida en curso). Cada
  5 rondas (5, 10, 15…) vuelve al mapa inicial, igual que la ronda 1 — el resto son mapas
  procedurales normales. En ese momento aparece un ticker grande, integrado arriba de la
  pantalla de juego (anclado al canvas, no al viewport — ver nota de posicionamiento más
  abajo): los puntajes se tipean letra por letra, jugador por jugador, cada uno con su color y
  un glow a juego (`text-shadow: currentColor`). Siempre en el mismo orden — por id de
  jugador, no por puesto — para que el mismo color caiga siempre en el mismo lugar entre una
  revelación y la siguiente. Al terminar, tipea una segunda línea con un dato random ("Amigo
  tiró más patadas (12)", "Vos te caíste más veces (4)"...) sorteado entre patadas/piñas
  tiradas, caídas, y golpes dados/recibidos — con eso solo, se salta si nadie hizo nada
  todavía. Todo el tipeo es real (un `setTimeout` por caracter, no una animación CSS), así que
  `hideScoreReveal()` puede cortarlo en cualquier punto sin dejar timers sueltos.

  Los contadores (`matchStats`) viven en `desktop/sim.js`, mismo patrón aditivo que `ATTACKS`:
  se incrementan en los mismos puntos donde ya pasan las cosas que cuentan (tirar un ataque,
  conectarlo, `eliminate()`), sin rama especial, así que escritorio y Steam los llevan también
  aunque no los usen para nada. Viajan en el broadcast `"round"` (una vez por ronda, no en cada
  snapshot) — el cliente NO puede leerlos de `Sim.getMatchStats()` local, porque ese Sim del
  navegador nunca simula nada y siempre da cero; tienen que llegar por red desde el servidor.

  **Nota de posicionamiento:** `#wrap` centra el canvas (960×540 fijo) con flexbox en un
  contenedor de 100vw/100vh. Un `top: Npx` viewport-relative (lo que ya usaba `#roundBanner`)
  solo cae dentro del canvas cuando la ventana mide cerca de 960×540 — en cualquier ventana más
  alta flota en el espacio vacío arriba del canvas, no sobre la escena. `#scoreReveal` usa
  `top:50%` + `transform: translateY(-230px)` en cambio, anclado al centro real del canvas, así
  que queda "sobre la pantalla de juego" sin importar el tamaño de ventana.
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

## Salir de una sala ya creada

Antes solo se podía volver atrás ANTES de crear la sala (desde `modeCard`/`joinCard`). Ahora el
mismo link `‹ volver` sigue visible una vez dentro del lobby (`roomCard`) y funciona como "salir
de la sala": manda `{t:"leave"}` al servidor (reusa la misma `leaveRoom()` que ya disparaba un
corte de conexión) pero **sin cerrar el socket** — así el mismo cliente puede crear o unirse a
otra sala al toque, sin recargar la página. Si eras el dueño, la sala le pasa la posta al
próximo conectado; si eras el último, la sala queda con gracia de 60s por si alguien vuelve a
entrar con el código (mismo comportamiento que ya existía para una desconexión).

## Efectos visuales (stickman.js / fx.js — compartido, no solo web)

Estos tres viven en los archivos compartidos, así que escritorio y Steam los reciben gratis —
son mejoras puramente cosméticas, sin ningún cambio de comportamiento de juego.

- **Quemado.** Antes: un óvalo naranja plano con blend aditivo, encima del cuerpo sin recolorear,
  parpadeando 220ms cada medio segundo y sin nada visible el resto del tiempo. Ahora: la víctima
  (no solo quien tiene el orbe) dispara el mismo aura de llamas por hueso que ya usaba el
  poseedor del poder (`beginPowerAura` chequea `p.burnT > 0` además de `p.power`), más el cuerpo
  recolor a naranja con el glow (`shadowBlur`) que ya se aplicaba a todos los trazos — eso es el
  "borde exterior" que ardía. El flash puntual de cada tick de daño pasó de una elipse a un
  puñado de chispas que suben y se apagan (`drawBurnFlash`), determinísticas por jugador así no
  titilan en una posición nueva cada frame.
- **Aura de tierra (resistencia).** De 2 nubs de piedra por hueso a 5, más grandes (alternando
  tamaño para que lea rocoso, no uniforme) — antes apenas se notaba.
- **Estela de aire (velocidad).** `Trails` (antes solo usado para el trail de golpe) ahora acepta
  `opts.key`/`opts.maxGhosts`/`opts.minIntervalMs`/`opts.baseAlpha`/`opts.alphaSpread`, así puede
  llevar dos canales de fantasmas independientes por jugador sin pisarse (golpe vs. velocidad).
  Mientras el orbe de aire está activo, deja una estela bastante más exagerada que la de golpe —
  el doble de fantasmas, capturados el doble de seguido, mucho más visibles.
- **Aura de hielo.** Mismo problema que el fuego: solo salía para quien sostenía el orbe, nunca
  para la víctima ralentizada (`slowT`). Ahora `beginPowerAura` también la activa con `slowT > 0`.
  De paso, de 3 cristales a 4 (alternando de lado, no todos apilados en el mismo borde del hueso)
  y un poco más brillantes — a la intensidad original ("deliberately dimmer than fire") ni
  siquiera el que tenía el orbe lo notaba bien.

Prototipados y comparados lado a lado (actual vs. propuesta) con el código real —no un mockup—
en un harness aislado antes de aplicarlos, y verificados después contra 22+ rondas de partida
real sin errores de consola.

**Por qué no se veían en el juego real pese a esa verificación:** dos bugs de sincronización de
red que el harness aislado (jugadores creados a mano, sin pasar por el servidor) no podía
detectar.

1. `Sim.snapshot()` nunca incluía `burnT` — solo `burnFlashT`. El aura de fuego para víctimas
   que acabo de agregar depende de `p.burnT > 0`, así que nunca se activaba en una partida real:
   el dato ni siquiera viajaba del servidor al cliente. Agregado a `snapshot()` y a
   `resyncGuestPlayer()`.
2. **El bug más importante, y preexistente** (no lo introduje yo, solo lo hizo evidente): en
   `guestFrame()`, `players[id]` se reconstruye con `Object.assign({}, lp, {x,y})` en **cada
   frame** — necesario para poder interpolar posición sin mutar el estado persistente. Pero
   `Trails.push()`/`clear()` escriben el array de fantasmas sobre el objeto que reciben, y como
   ese objeto es nuevo cada frame, el array creado ahí se perdía apenas terminaba el frame:
   nunca acumulaba más de un fantasma. Esto ya afectaba en silencio al trail de golpe original
   (sutil, 3 fantasmas, nadie lo notó); mi estela de aire, pensada para ser bien visible, lo
   hizo evidente de inmediato. Los builds de escritorio/Steam nunca tuvieron este problema
   porque ahí el host simula localmente y `players` nunca se reconstruye — es el mismo objeto
   mutado en el tiempo, no uno nuevo por frame.

   Arreglado sembrando los arrays (`lp._trail`/`lp._airTrail`) sobre `lp` (el objeto
   *persistente* en `guestLocal`, no la copia efímera) antes del `Object.assign` — así la copia
   de cada frame hereda la MISMA referencia de array, y los `push()` de frames sucesivos sí se
   acumulan en el array real.

Verificado con un test que reproduce el viaje completo servidor→red (JSON real, no paso por
referencia)→cliente→múltiples frames: falla sin el fix (`_airTrail` nunca pasa de largo 1),
pasa con el fix (llega al tope de 6 fantasmas tras 15 frames a 50fps).

## Balance de combate (solo web)

`balance.js` ajusta el combate **únicamente de este build**. Se aplica con
`Sim.init({ attacks })` sobre los valores por defecto de `../desktop/sim.js`, que quedan
intactos: escritorio y Steam siguen jugando igual que siempre.

| | piña | patada |
|---|---|---|
| Duración | 140 ms | 280 ms |
| Cooldown | 190 ms | 380 ms |
| Daño | 9 | 15 |
| Empuje (kbX) | 0,8 | 4,2 |

Entran exactamente **dos piñas en el tiempo de una patada**. El equilibrio no está en el daño
por golpe sino en el DPS: piña 47,4/s contra patada 39,5/s. La piña gana en daño sostenido — si
no, sería estrictamente peor y nadie la usaría. Lo que compra la patada no es DPS sino
**espacio**: con `kbX 4.2` y `kbY -3.0` saca al rival de la plataforma, y en este juego caerse
es morir.

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
