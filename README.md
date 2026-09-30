# Last Stick Standing — V2

Juego de pelea de palitos para hasta 8 jugadores, en el navegador. Online con servidor
autoritativo, local en el mismo sillón (teclados, mandos y celulares como control), práctica
contra bots y dos campañas en solitario.

Producción: <https://lss.leinonair.com> · V1 (referencia): [`legacy/`](legacy/)

## Stack

| Capa | Tecnología | Para qué |
|---|---|---|
| Lenguaje | **TypeScript** (estricto) en todo el monorepo | tipos compartidos cliente ↔ servidor |
| Monorepo | **npm workspaces**: `shared`, `server`, `client` | una sola fuente de verdad para la simulación |
| Render | **PixiJS v8** (WebGL) + **pixi-filters** | composición en GPU, bloom, ondas de choque, aberración cromática, partículas |
| Arte | Canvas 2D procedural (portado de V1) en sprites por entidad | el rig del muñeco y los accesorios, afinados a mano |
| UI | **Svelte 5** | menús, HUD, overlays, página del control del celular |
| Build | **Vite** (cliente), **esbuild** (servidor, un solo archivo) | bundles con hash, caché inmutable |
| Red | **ws** + **MessagePack** (msgpackr) | protocolo binario, snapshots cuantizados |
| Validación | **zod** (solo servidor) | cada mensaje del cliente se valida contra un esquema |
| Cuentas y récords | **Supabase** (npm) | igual que V1, mismas tablas |
| Tests | **Vitest** | simulación, bots, protocolo y el servidor de punta a punta |
| Deploy | Docker + Caddy en la VM de Oracle | igual que V1 |

## Estructura

```
packages/
  shared/   Sim (clase, sin globals), física compartida, generador de mapas, IA de bots,
            balance, protocolo binario. Sin DOM ni Node: corre igual en el navegador y en el server.
  server/   HTTP (sirve el cliente compilado + /health) y WebSocket: salas de juego a 60 Hz con
            input por jugador, snapshots a 30 Hz, salas de mandos para celulares.
  client/   Motor (loop, entrada, sesiones), renderer Pixi, audio procedural, netcode y UI Svelte.
            Dos páginas: index.html (el juego) y pad.html (el control del celular).
legacy/     V1 completa, sin tocar, como referencia.
```

## Comandos

```bash
npm install
npm run dev --workspace @lss/server   # servidor de juego en :8090 (con recarga)
npm run dev --workspace @lss/client   # cliente con HMR en :5174 (deriva /ws al :8090)
npm test                              # tests (sim, bots, protocolo, servidor)
npm run typecheck                     # tsc + svelte-check en los 3 paquetes
npm run build                         # cliente (Vite) + servidor (esbuild)
npm start                             # producción: node packages/server/dist/server.mjs
```

Para probar el netcode con latencia simulada:

```bash
npm run dev --workspace @lss/server -- --lag 120 --jitter 20
```

Con **Ajustes → Mostrar FPS** el HUD muestra además snapshots/s, profundidad del buffer de
interpolación y el error de predicción.

## Netcode

- **Input por tick.** El cliente corre su propio reloj a 60 Hz y manda un frame por tick
  (izquierda/derecha sostenidos + flancos de salto/piña/patada) con número de secuencia.
- **Un paso físico por frame.** El servidor avanza el cuerpo de cada jugador exactamente un paso
  por frame consumido: si todavía no llegó, ese jugador espera ese tick; si se atrasó, da dos
  pasos. Así la simulación del servidor y la predicción del cliente nunca se desfasan.
- **Predicción + reconciliación.** El muñeco propio se mueve al instante con el mismo integrador
  que el servidor (`shared/src/sim/physics.ts`). Con cada snapshot se toma el estado confirmado
  (`ack`), se re-simulan los frames pendientes y el residuo se corrige suavizado.
  Medido con 120 ms de ida y vuelta + jitter: error medio 0,01 px, corrección visual máxima 0,05 px.
- **Interpolación con buffer** para el resto de los jugadores (~100 ms en el pasado, entre dos
  snapshots reales, con un reloj de servidor estimado).
- **Eventos.** Golpes, KOs, aterrizajes, saltos y orbes viajan en el snapshot y se reproducen
  cuando se ven, con partículas, sacudón y sonido. En V1 los invitados no veían ningún efecto.
- **Binario.** MessagePack con jugadores como tuplas cuantizadas: un snapshot de 2 jugadores
  pesa unos cientos de bytes (V1: ~2,3 KB de JSON).

## Deploy (VM de Oracle)

La VM tiene ~500 MB de RAM real: compilar el cliente adentro de Docker ahí es muy lento. Por eso
hay dos imágenes:

- `Dockerfile` — multi-etapa, compila adentro. Para CI o una máquina con RAM.
- `Dockerfile.prebuilt` — solo copia artefactos ya compilados. **La que usa la VM.**

```bash
scripts/deploy-vm.sh     # tests + build local, sube los artefactos (~2 MB) y reinicia en la VM
```

El script deja `LSS_DOCKERFILE=Dockerfile.prebuilt` en el `.env` de la VM, así
`docker compose up -d --build` usa la imagen liviana. Detalles de la VM (firewall, TLS, swap) en
[`oracle/README-oracle.md`](oracle/README-oracle.md).

## Qué cambió respecto de V1

Ver [`docs/V2.md`](docs/V2.md).
