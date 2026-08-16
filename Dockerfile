# Imagen del servidor online (ver online/README-online.md).
# El contexto de build es la raíz del repo porque el servidor necesita los archivos
# compartidos del juego (stickman.js, fx.js, world.js) y desktop/sim.js, que viven acá
# arriba — se cargan tal cual, sin copiarlos ni portearlos.
FROM node:20-alpine

WORKDIR /app

# Dependencias primero, en su propia capa, para que un cambio de gameplay no invalide
# el npm install en cada deploy.
COPY online/package.json ./online/
RUN cd online && npm install --omit=dev

# Módulos compartidos que el servidor evalúa en su contexto headless (stickman/fx/world)
# y que además sirve al navegador. audio.js es solo para el cliente.
COPY stickman.js fx.js world.js audio.js ./
COPY desktop/sim.js ./desktop/

COPY online/ ./online/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "online/server.js"]
