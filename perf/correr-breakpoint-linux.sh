#!/usr/bin/env bash
# Uso y descripcion: perf/README.md
set -u
cd "$(dirname "$0")"

ESCENARIO=exchange-availability-breakpoint
NOMBRE=""
while getopts "e:n:" opt; do
  case $opt in
    e) ESCENARIO=$OPTARG ;;
    n) NOMBRE=$OPTARG ;;
    *) echo "Uso: bash $0 [-e escenario] [-n nombre]"; exit 2 ;;
  esac
done

CORTO=${ESCENARIO#exchange-availability-}
PREFIJO=artillery-exchange-$CORTO
NOMBRE=${NOMBRE:-${CORTO}_linux}
COMPOSE=../docker-compose.yml
API=http://localhost:5555
GRAPHITE=http://localhost:8090
DIR=resultados/$(date +%F)_$NOMBRE

paso() { printf '\n=== %s\n' "$1"; }
falla() { echo "ERROR: $1" >&2; exit 1; }

[ -f "$ESCENARIO.yaml" ] || falla "no existe $ESCENARIO.yaml"
[ -e "$DIR" ] && falla "ya existe $DIR. Usar -n para elegir otra carpeta."
for cmd in docker node npm curl vmstat; do command -v $cmd > /dev/null || falla "falta $cmd"; done
mkdir -p "$DIR"

paso "1/7 Instalando artillery (npm ci)"
[ "$(node -v | cut -d. -f1)" = "v24" ] || echo "Aviso: se esperaba Node 24 y hay $(node -v)"
npm ci --silent || falla "npm ci"

paso "2/7 Levantando el sistema y reseteando la api"
docker compose -f $COMPOSE up -d || falla "docker compose up"
if docker ps --format '{{.Names}}' | grep -qx exchange-api-2; then
  falla "hay mas de una replica de la api. Correr: docker compose -f $COMPOSE up -d --scale api=1"
fi
docker compose -f $COMPOSE up -d --build --force-recreate api || falla "reset de la api"
for _ in $(seq 30); do curl -sf -m 2 $API/rates > /dev/null && break; sleep 1; done
curl -sf -m 2 $API/rates > /dev/null || falla "la api no responde en $API/rates"
curl -s $API/accounts > "$DIR/cuentas-antes.json"
cp "$ESCENARIO.yaml" "$DIR/"

paso "3/7 Registrando el entorno"
{ uname -a; lscpu | grep -E 'Model name|^CPU\(s\)|Thread'; free -h; swapon --show
  docker version --format 'Engine {{.Server.Version}}'; docker compose version; node -v
  docker inspect -f 'Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}' exchange-api-1
} > "$DIR/entorno.txt" 2>&1
( cd /proc/sys/net/ipv4 && grep . ip_local_port_range tcp_tw_reuse tcp_max_tw_buckets tcp_fin_timeout ) > "$DIR/red-cliente.txt"

paso "4/7 Registros en segundo plano"
docker events --filter container=exchange-api-1 --filter container=exchange-nginx-1 \
  --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}' \
  > "$DIR/eventos-containers.txt" 2> "$DIR/eventos-containers.err.txt" &
EVENTOS=$!
( while true; do echo "### $(date +%s) $(date -u +%FT%TZ)"; cat /proc/net/sockstat; grep TcpExt: /proc/net/netstat; sleep 5; done ) \
  > "$DIR/sockstat-cliente.txt" &
SOCKSTAT=$!
vmstat -t 5 > "$DIR/vmstat-host.txt" &
VMSTAT=$!
trap 'kill $EVENTOS $SOCKSTAT $VMSTAT 2> /dev/null' EXIT

paso "5/7 Corriendo artillery"
INICIO=$(date +%s)
echo "$INICIO" > "$DIR/inicio.txt"
npx artillery run "$ESCENARIO.yaml" -e api --output "$DIR/reporte-artillery.json" 2>&1 | tee "$DIR/resultados-artillery.txt"
SALIDA=${PIPESTATUS[0]}
FIN=$(date +%s)
echo "$FIN" > "$DIR/fin.txt"
kill $EVENTOS $SOCKSTAT $VMSTAT 2> /dev/null

paso "6/7 Guardando saldos, estado y logs"
curl -sf -m 10 $API/accounts > "$DIR/cuentas-despues.json" \
  || echo "ERROR: la api no respondio a /accounts" > "$DIR/cuentas-despues.json"
ESTADO=$(docker inspect -f '{{.State.Status}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Restarts={{.RestartCount}}' exchange-api-1)
echo "$ESTADO" > "$DIR/estado-api-despues.txt"
docker logs --since "$INICIO" exchange-nginx-1 > "$DIR/nginx-access.log" 2> "$DIR/nginx-error.log"
docker logs --since "$INICIO" exchange-api-1 > "$DIR/api-stdout.log" 2> "$DIR/api-stderr.log"

paso "7/7 Exportando metricas de graphite"
sleep 15
exportar() {
  local archivo=$1 q="" t
  shift
  for t in "$@"; do q="$q&target=$t"; done
  curl -sfg "$GRAPHITE/render?from=$((INICIO - 20))&until=$((FIN + 30))&format=json$q" > "$DIR/$archivo" \
    || echo "ERROR exportando de graphite" > "$DIR/$archivo"
}
exportar datos-recursos.json \
  'stats.gauges.cadvisor.{exchange-api-1,exchange-nginx-1}.cpu_cumulative_usage' \
  'stats.gauges.cadvisor.{exchange-api-1,exchange-nginx-1}.memory_working_set'
exportar datos-artillery-graphite.json "stats.gauges.$PREFIJO.*" "stats.gauges.$PREFIJO.*.*"

paso "Listo"
[ "$SALIDA" -ne 0 ] && echo "Ojo: artillery termino con exit $SALIDA"
echo "Resultados en: perf/$DIR"
EVENTOS_TXT=$(paste -sd '|' "$DIR/eventos-containers.txt" | sed 's/|/ | /g')
echo "Eventos de containers: ${EVENTOS_TXT:-ninguno}"
echo "Estado de la api: $ESTADO"
echo "Grafana: prefijo $PREFIJO, containers exchange-api-1 / exchange-nginx-1, desde $(date -d @"$INICIO" +%H:%M) hasta $(date -d @"$FIN" +%H:%M)"
