#!/usr/bin/env bash
# Deploy de V2 a la VM de Oracle: compila acá, sube solo los artefactos y levanta la imagen de
# runtime (Dockerfile.prebuilt). En la VM no se instala ni compila nada con npm.
#
# Uso (desde Git Bash, en la raíz del repo):
#   scripts/deploy-vm.sh            # rama actual
#   LSS_HOST=opc@1.2.3.4 scripts/deploy-vm.sh
#
# Requiere que el repo de la VM (~/laststickstanding) esté en la misma rama que se despliega.
set -euo pipefail

KEY="${LSS_SSH_KEY:-C:/Users/Dan/Downloads/ssh-key-2026-08-17.key}"
HOST="${LSS_HOST:-opc@147.15.101.103}"
DOMAIN="${LSS_DOMAIN:-lss.leinonair.com}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i "$KEY" "$HOST")

echo "→ tests + build ($BRANCH)"
npm test --silent
npm run build --silent

echo "→ empaquetando artefactos"
TMP="$(mktemp -d)"
tar czf "$TMP/lss-dist.tgz" --exclude="*.map" packages/server/dist/server.mjs packages/client/dist
du -h "$TMP/lss-dist.tgz"

echo "→ subiendo"
scp -o StrictHostKeyChecking=accept-new -i "$KEY" "$TMP/lss-dist.tgz" "$HOST:~/lss-dist.tgz"

echo "→ actualizando la VM"
"${SSH[@]}" "set -e
  cd ~/laststickstanding
  git fetch --quiet origin
  git checkout --quiet $BRANCH
  git pull --quiet --ff-only origin $BRANCH
  rm -rf prebuilt && mkdir -p prebuilt && tar xzf ~/lss-dist.tgz -C prebuilt
  grep -q '^LSS_DOCKERFILE=' .env || echo 'LSS_DOCKERFILE=Dockerfile.prebuilt' >> .env
  docker compose up -d --build
  docker image prune -f >/dev/null"

echo "→ verificando"
sleep 4
curl -s -m 15 "https://$DOMAIN/health" || curl -s -m 15 --resolve "$DOMAIN:443:${HOST#*@}" "https://$DOMAIN/health"
echo
rm -rf "$TMP"
