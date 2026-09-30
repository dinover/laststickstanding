# Last Stick Standing V2 — imagen del servidor (sirve también el cliente compilado).
#
# Dos etapas: en la primera se instala todo y se compila (Vite para el cliente, esbuild para el
# servidor); la imagen final lleva solo node + dist/server.mjs (con ws/msgpackr/zod adentro del
# bundle) + los estáticos del cliente. Sin node_modules en runtime: arranca en ~100 ms y pesa poco.
#
# La VM de Oracle tiene 1 GB de RAM: el límite de heap evita que el build de Vite se coma la
# memoria (con el swap de la VM alcanza; ver oracle/README-oracle.md).

FROM node:20-alpine AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=768
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/packages/server/dist/server.mjs ./packages/server/dist/server.mjs
COPY --from=build /app/packages/client/dist ./packages/client/dist
EXPOSE 8080
USER node
CMD ["node", "packages/server/dist/server.mjs"]
