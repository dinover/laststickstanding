# Last Stick Standing — build de escritorio

Versión instalable de Windows: una ventana que se conecta directo al server online
(`../online`, corriendo en la VM de Oracle Cloud — ver
[`../oracle/README-oracle.md`](../oracle/README-oracle.md)). No es P2P ni Steam: es el mismo
juego que corre en `https://147-15-101-103.nip.io`, mostrado en una ventana propia en vez de un
navegador. No hay ninguna copia local de `sim.js`, `game.html` ni lógica de red — `main.js` solo
apunta la ventana a esa URL.

## Correr en desarrollo

```bash
cd games/laststickstanding/desktop
npm install
npm start
```

Para probar contra un server local (`../online/server.js`) en vez de producción:

```bash
LSS_SERVER_URL=http://localhost:8080 npm start
```

## Generar el instalador

```bash
npm run dist
```

Esto genera un instalador NSIS (`dist/Last Stick Standing Setup <version>.exe`) que instala el
juego en `%LocalAppData%\Programs\Last Stick Standing`, crea accesos directos (escritorio + menú
Inicio) y queda listado en **Configuración → Aplicaciones** de Windows para desinstalar desde
ahí. No necesita Steam ni ninguna cuenta — al abrirlo, la ventana se conecta sola al server
online.

`build/installer.nsi` es un script NSIS propio, no el que arma electron-builder por default. El
generado automáticamente (para asistido u one-click) tiene un paso interno que se auto-compila,
se auto-ejecuta para escribirse su propio desinstalador, y después lo empaqueta adentro del
instalador final — y ese paso específico no funcionó en esta máquina (probado elevado, desde
PowerShell puro, con la última versión de `electron-builder`, con oneClick tanto en true como en
false: siempre falla igual, incluso ejecutando a mano el .exe intermedio que se supone que se
autoescribe el desinstalador). `build/installer.nsi` es el patrón NSIS clásico de toda la vida en
un solo paso — instala, hace `WriteUninstaller` una vez, escribe la entrada de registro de
desinstalación — sin nada de esa maquinaria. Si algún día hace falta tocar el instalador (agregar
un ícono, un idioma, una página), es ese archivo.

## Notas

- Necesita internet (se conecta al mismo server que usa la versión web). Si falla la conexión al
  arrancar, muestra `offline.html` con un botón de reintentar en vez de la pantalla de error de
  Chromium.
- Si la IP de la VM cambia alguna vez, hay que actualizar `SERVER_URL` en `main.js` (mismo caso
  que el resto de los lugares que referencian `147-15-101-103.nip.io` — ver
  [`../oracle/README-oracle.md`](../oracle/README-oracle.md)).
- Reemplaza los builds viejos `desktop/` (PeerJS) y `steam/` (Steamworks) — ninguno de los dos
  sigue en el repo.
