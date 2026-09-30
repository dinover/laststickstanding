# Imagen del servidor online (ver online/README-online.md).
# El contexto de build es la raíz del repo porque el servidor necesita los archivos
# compartidos del juego (stickman.js, fx.js, world.js), que viven acá arriba — se cargan
# tal cual, sin copiarlos ni portearlos. La simulación (online/sim.js) ya viaja adentro
# de online/.
FROM node:20-alpine

WORKDIR /app

# Dependencias primero, en su propia capa, para que un cambio de gameplay no invalide
# el npm install en cada deploy.
COPY online/package.json ./online/
RUN cd online && npm install --omit=dev

# Módulos compartidos que el servidor evalúa en su contexto headless (stickman/fx/world)
# y que además sirve al navegador. audio.js es solo para el cliente.
COPY stickman.js fx.js world.js audio.js ./
# Favicon + imagen de preview al compartir el link (server.js las sirve en /favicon.png y
# /og-image.png — ver la excepción correspondiente en .dockerignore, que si no se las come).
# Forma JSON (no shell-form): el parser de Dockerfile no banca comillas shell-style para
# separar varios argumentos con espacios en la misma instrucción COPY.
COPY ["LSS icon.png", "Last Stick Standing.png", "./"]

COPY online/ ./online/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "online/server.js"]
