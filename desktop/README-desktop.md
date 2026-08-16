# Last Stick Standing — build de escritorio (sin Steam)

Versión instalable para jugar online entre amigos, cada uno desde su PC, **sin pasar por
Steam** (que cobra USD 100 para publicar) ni por ningún otro store. La conexión es
peer-to-peer vía WebRTC (PeerJS), igual que `index.html`, pero:

- con **paridad total** con la V2 del juego (kick separado, power-orbs elementales, modo
  caracol, audio) — el `index.html` viejo se había quedado atrás en mecánicas, esta versión no;
- empaquetada como una app instalable de Windows, no una página que hay que abrir a mano.

No modifica nada de `screen.html`, `controller.html`, `sdk.js`, `net.js` ni `index.html` — esos
siguen funcionando exactamente igual. Esta carpeta reutiliza sin tocar `../stickman.js`,
`../fx.js`, `../world.js`, `../audio.js` y **el mismo `../net.js`** (PeerJS) que ya usa
`index.html`; lo único nuevo es `sim.js` (simulación con paridad V2), `game.html` (la pantalla,
con la UI/UX de `index.html` pero al día) y el empaquetado Electron (`main.js` + `package.json`).

## Cómo funciona la conexión

Uno de los jugadores hace clic en **"Crear sala"**: eso genera un código de 4 letras (vía
PeerJS, que usa un broker gratuito público solo para el "handshake" inicial). Los demás eligen
**"Unirme a una sala"** y escriben ese código. A partir de ahí todo el tráfico del juego viaja
directo entre las PCs (WebRTC), sin pasar por ningún servidor propio. Todos necesitan internet;
no hace falta abrir puertos ni configurar router en la gran mayoría de los casos (WebRTC hace
NAT traversal solo).

## Correr en desarrollo

```bash
cd games/laststickstanding/desktop
npm install
npm start
```

## Generar el instalador

```bash
npm run dist
```

Esto genera un instalador NSIS (`dist/Last Stick Standing Setup <version>.exe`) que cualquiera
puede descargar y ejecutar en Windows — no necesita cuenta de Steam, no necesita nada instalado
de antes. Para distribuirlo: subilo a donde prefieras (Google Drive, WeTransfer, itch.io — itch
es gratis y no cobra nada por publicar, a diferencia de Steam) y compartí el link con tus
amigos.

## Notas

- Como es P2P por WebRTC, si el host tiene una conexión muy restrictiva (NAT simétrico
  corporativo, por ejemplo) puede fallar la conexión directa; para el caso normal de "amigos
  jugando desde sus casas" funciona sin configuración adicional.
- Si más adelante quieren mecánicas nuevas, tocan `sim.js` acá (y opcionalmente
  `../steam/sim.js` si mantienen las dos versiones) — `screen.html` sigue totalmente aparte.
