#!/usr/bin/env bash
# Bootstrap de la VM Oracle Cloud — Oracle Linux, shape VM.Standard.E2.1.Micro (Always Free).
# Correr UNA vez por SSH en la VM recién creada, como el usuario "opc" (usuario SSH por
# defecto de las imágenes Oracle Linux en OCI — no es "ubuntu"):
#
#   curl -fsSL https://raw.githubusercontent.com/dinover/laststickstanding/main/oracle/bootstrap.sh -o bootstrap.sh
#   bash bootstrap.sh
#
# Es idempotente: correrlo de nuevo (por ejemplo tras "git pull") no rompe nada.
set -euo pipefail

REPO_URL="https://github.com/dinover/laststickstanding.git"
APP_DIR="$HOME/laststickstanding"

echo "== 1/5: Swap (colchón de seguridad — la VM tiene ~500 MB de RAM real) =="
# Va PRIMERO a propósito: con tan poca RAM, hasta "dnf install" de los paquetes de Docker
# puede quedarse sin memoria y el kernel lo mata (OOM-kill) antes de terminar.
#
# Las imágenes Oracle Linux de OCI ya traen un swap propio por default (/.swapfile,
# manejado por cloud-init, del mismo tamaño que la RAM — o sea, insuficiente él solo). NO
# se toca ese archivo: se agrega uno adicional, en un path distinto, para no pisar lo que
# cloud-init espera encontrar. Se chequea por NUESTRO archivo puntual, no por "hay swap o
# no" en general, porque esa condición ya daba falso positivo con el swap default.
if ! swapon --show | grep -q '/swapfile-extra'; then
  sudo fallocate -l 4G /swapfile-extra
  sudo chmod 600 /swapfile-extra
  sudo mkswap /swapfile-extra
  sudo swapon /swapfile-extra
  echo '/swapfile-extra none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== 2/5: Docker =="
if ! command -v docker &>/dev/null; then
  sudo dnf install -y dnf-utils
  sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER"
  NEEDS_RELOGIN=1
fi

echo "== 3/5: Firewall del sistema operativo (firewalld) =="
# Las imágenes Oracle Linux de OCI traen firewalld activo con solo el 22 abierto.
# Sin esto, aunque el Security List de la consola OCI esté bien configurado, el
# tráfico igual se cae adentro de la VM — es el paso que más se olvida en OCI.
if command -v firewall-cmd &>/dev/null && sudo systemctl is-active --quiet firewalld; then
  sudo firewall-cmd --permanent --add-port=80/tcp
  sudo firewall-cmd --permanent --add-port=443/tcp
  sudo firewall-cmd --reload
fi

echo "== 4/5: Clonar / actualizar el repo =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  sudo dnf install -y git
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "!! Falta configurar DOMAIN en $APP_DIR/.env antes de levantar el servicio."
  echo "!! Editalo (nano .env) y después corré: cd $APP_DIR && docker compose up -d --build"
  exit 0
fi

if [ "${NEEDS_RELOGIN:-0}" = "1" ]; then
  echo ""
  echo "!! Docker se acaba de instalar y tu usuario se agregó al grupo 'docker' recién ahora."
  echo "!! Cerrá la sesión SSH y volvé a entrar (o corré 'newgrp docker') antes de continuar,"
  echo "!! si no 'docker compose' de más abajo va a fallar por permisos."
  exit 0
fi

echo "== 5/5: Levantar el servicio =="
docker compose up -d --build
echo ""
echo "Listo. Revisá 'docker compose logs -f app' y https://\$DOMAIN/health"
