# Last Stick Standing — deploy en Oracle Cloud (Always Free)

Servidor autoritativo corriendo en una VM propia del **Always Free tier** de Oracle Cloud
Infrastructure (OCI), en vez de Fly.io o Render. Ventaja sobre Render: OCI tiene región en
**São Paulo** (`sa-saopaulo-1`), la misma que usaba Fly en `gru` — ~25-40 ms desde Buenos Aires,
en vez de los ~120-150 ms de Render.

Esta VM quedó como **Oracle Linux, shape `VM.Standard.E2.1.Micro`** (1 OCPU AMD, 1 GB RAM) — es
lo que el flujo rápido de "Create Instance" preseleccionó. Todo lo de acá está armado para esa
combinación puntual (usuario SSH `opc`, `dnf`/`firewalld`, swap de colchón por la RAM ajustada).

> Si en el futuro creás en cambio una VM Ampere (`VM.Standard.A1.Flex`, hasta 4 OCPU/24 GB, misma
> cuota Always Free pero separada de la AMD Micro), va a ser Ubuntu por default y estos scripts
> no aplican tal cual — avisame y te preparo la variante Ubuntu/apt/iptables/usuario `ubuntu`.

Contras a tener en cuenta con esta shape en particular:

- **1 GB de RAM es justo.** El server corría con 512 MB en Fly, así que el proceso Node en sí
  entra sin problema, pero acá además corre Docker y Caddy encima. Por eso el bootstrap agrega
  2 GB de swap como colchón — evita un OOM-kill en un pico, no lo evita bajo carga sostenida. Si
  en algún momento ves reinicios raros del contenedor, `docker stats` para confirmar memoria antes
  de sospechar de otra cosa.
- **No hay "congelar cuando no hay nadie".** A diferencia de Fly (`auto_stop_machines`), acá la VM
  queda prendida 24/7. Es gratis igual (Always Free no cobra por horas de VM).
- **El mantenimiento es tuyo.** Actualizaciones de SO, Docker, certificados — Fly y Render lo
  manejaban por vos. Acá hay una VM real que administrar (el bootstrap deja esto casi en cero,
  pero no es magia).

## Paso 1 — Crear la VM (consola de OCI, lo hacés vos)

Ya hecho: Oracle Linux, `VM.Standard.E2.1.Micro`, con IP pública asignada. Si todavía no la
reservaste como fija: **Networking → Reserved Public IPs**, para que no cambie si reiniciás la VM.

## Paso 2 — Abrir los puertos en el Security List (consola de OCI, lo hacés vos)

Por defecto solo el 22 (SSH) está abierto. Sin esto el tráfico ni siquiera llega a la VM:

1. **Networking → Virtual Cloud Networks** → tu VCN → **Security Lists** → la lista default.
2. **Add Ingress Rules**, dos veces:
   - Source CIDR `0.0.0.0/0`, protocolo TCP, destination port `80`.
   - Source CIDR `0.0.0.0/0`, protocolo TCP, destination port `443`.

Esto abre el paso a nivel de la nube. Todavía falta abrirlo *adentro* de la VM (firewalld) — eso
lo hace el bootstrap del paso 4, pero si algo no conecta y ya revisaste esto, es lo primero a
mirar.

## Paso 3 — Conseguir un dominio para HTTPS

Caddy (ya configurado en el repo) pide el certificado TLS solo, pero necesita un nombre de
dominio que resuelva a la IP de la VM — no alcanza con la IP sola.

- **Tenés un dominio propio**: creá un registro `A` apuntando a la IP pública de la VM.
- **No tenés dominio**: usá [nip.io](https://nip.io), gratis y sin registro. Si la IP de tu VM es
  `140.238.12.34`, el dominio `140-238-12-34.nip.io` ya resuelve solo a esa IP. Anotalo, lo usás
  en el paso siguiente.

## Paso 4 — Bootstrap de la VM (por SSH, esto sí te lo dejo armado)

El usuario SSH de las imágenes Oracle Linux en OCI es **`opc`**, no `ubuntu`:

```bash
ssh opc@<IP_DE_LA_VM>
curl -fsSL https://raw.githubusercontent.com/dinover/laststickstanding/main/oracle/bootstrap.sh -o bootstrap.sh
bash bootstrap.sh
```

La primera corrida instala Docker (vía el repo oficial de Docker para el ecosistema RHEL/dnf, ya
que Oracle Linux no trae `docker-ce` por defecto), abre 80/443 en `firewalld`, agrega 2 GB de
swap, clona el repo, y se corta pidiéndote completar `.env`. Después de eso corré `bootstrap.sh`
**una segunda vez** — la primera corrida solo agrega tu usuario al grupo `docker` y hace falta
reabrir la sesión SSH (o `newgrp docker`) para que tome efecto:

```bash
cd ~/laststickstanding
nano .env        # DOMAIN=140-238-12-34.nip.io  (o tu dominio propio)
# salir y volver a entrar por SSH, o: newgrp docker
docker compose up -d --build
```

Verificá:

```bash
curl https://<tu-dominio>/health
```

Debería devolver el JSON con salas/jugadores conectados (0 al principio).

## Actualizar tras un cambio de gameplay

```bash
ssh opc@<IP_DE_LA_VM>
cd ~/laststickstanding && git pull && docker compose up -d --build
```

O simplemente volvé a correr `bootstrap.sh` — es idempotente.

## Una sola instancia (igual que en Fly)

Las salas viven en la memoria del proceso Node. `docker-compose.yml` levanta un único contenedor
`app`; no escales esto a más de una réplica sin mover el estado de salas a Redis primero.

## Logs y diagnóstico

```bash
docker compose logs -f app     # logs del servidor de juego
docker compose ps              # estado de los contenedores
docker compose restart app     # reiniciar solo el juego sin tocar Caddy/certificados
free -h                        # confirmar que la RAM+swap no está al límite
```
