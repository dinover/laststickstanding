# Last Stick Standing — build de Steam

Versión de escritorio (Electron) del juego, para que los jugadores se conecten entre sí por
**Steam Networking** (lobbies + P2P) en vez de celulares/FreeConsole. No modifica nada de
`screen.html`, `controller.html`, `sdk.js`, `net.js` ni `index.html` — esos siguen siendo el
juego original tal cual.

## Cómo está armado

- `sim.js` — toda la simulación V2 (rondas, mapas, punch/kick, power-orbs, modo caracol),
  portada de `screen.html` pero sin nada de FreeConsole. Corre solo en la máquina del host.
- `net-steam.js` — mismo "shape" de API que `net.js` (`NetHost`/`NetGuest`), pero hablando con
  Steam en vez de PeerJS, a través de `window.steamBridge`.
- `preload.js` / `main.js` — el proceso de Electron que realmente llama a Steamworks
  (`steamworks.js`): crear/unirse a lobby, mandar paquetes P2P, abrir el overlay de invitación.
- `game.html` — la pantalla del juego (host y guest en un solo archivo, como ya hacía
  `index.html`), reutilizando sin tocar `../stickman.js`, `../fx.js`, `../world.js`, `../audio.js`.

## Correr en desarrollo

Requiere tener **Steam abierto y con sesión iniciada**.

```bash
cd games/laststickstanding/steam
npm install
npm start
```

`steam_appid.txt` trae el App ID de prueba de Valve (480, Spacewar) para poder probar sin tener
todavía un App ID propio asignado en Steamworks. **Antes de publicar, reemplazar ese 480 por el
App ID real del juego** (y volver a generar el build).

Para probar con dos jugadores hacen falta dos cuentas de Steam distintas (o dos máquinas); Steam
no deja correr dos sesiones del mismo usuario a la vez.

## Generar el build

```bash
npm run dist
```

Esto genera una carpeta ejecutable sin instalador (target `dir` en `package.json` → `build.win`)
lista para empaquetar como depot de Steam. Ajustar `build.win.target` a `nsis` si en cambio se
quiere un instalador tradicional.

## Subir a Steamworks (steamcmd)

1. En el panel de Steamworks, crear la app y anotar el **App ID real**; reemplazá el `480` de
   `steam_appid.txt` por ese valor.
2. Crear un depot y anotar el **Depot ID**.
3. Escribir un `depot_build.vdf` apuntando a la carpeta generada por `npm run dist`, por ejemplo:
   ```vdf
   "DepotBuildConfig"
   {
     "DepotID" "TU_DEPOT_ID"
     "ContentRoot" "dist/win-unpacked"
     "FileMapping"
     {
       "LocalPath" "*"
       "DepotPath" "."
       "recursive" "1"
     }
   }
   ```
4. Escribir un `app_build.vdf` que referencie ese depot:
   ```vdf
   "AppBuild"
   {
     "AppID" "TU_APP_ID"
     "Desc" "Build inicial Steam"
     "ContentRoot" "."
     "BuildOutput" "steamcmd_output/"
     "Depots"
     {
       "TU_DEPOT_ID" "depot_build.vdf"
     }
   }
   ```
5. Subir con `steamcmd`:
   ```bash
   steamcmd +login <usuario> +run_app_build ../app_build.vdf +quit
   ```
6. Desde el panel de Steamworks, publicar el build subido en la rama (`default`/`beta`) deseada.
