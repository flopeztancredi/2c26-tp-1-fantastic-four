#!/usr/bin/env bash
# Uso y descripcion: perf/README.md
set -u
cd "$(dirname "$0")"

ESCENARIO=exchange-availability-breakpoint
NOMBRE=""
REPLICAS=1
while getopts "e:n:r:" opt; do
  case $opt in
    e) ESCENARIO=$OPTARG ;;
    n) NOMBRE=$OPTARG ;;
    r) REPLICAS=$OPTARG ;;
    *) echo "Uso: bash $0 [-e escenario] [-n nombre] [-r replicas]"; exit 2 ;;
  esac
done

CORTO=${ESCENARIO#exchange-availability-}
PREFIJO=artillery-exchange-$CORTO
NOMBRE=${NOMBRE:-${CORTO}_linux}
COMPOSE=../docker-compose.yml
API=http://localhost:5555
GRAPHITE=http://localhost:8090
DIR=resultados/$(date +%F)_$NOMBRE

if [ "$REPLICAS" -eq 1 ]; then
  export NGINX_CONFIG=./nginx_reverse_proxy-1.conf
else
  export NGINX_CONFIG=./nginx_reverse_proxy.conf
fi

paso() { printf '\n=== %s\n' "$1"; }
falla() { echo "ERROR: $1" >&2; exit 1; }

[ -f "$ESCENARIO.yaml" ] || falla "no existe $ESCENARIO.yaml"
[ -e "$DIR" ] && falla "ya existe $DIR. Usar -n para elegir otra carpeta."
[[ "$REPLICAS" =~ ^[1-3]$ ]] || falla "las replicas deben ser 1, 2 o 3"
for cmd in docker node npm curl vmstat; do command -v $cmd > /dev/null || falla "falta $cmd"; done
mkdir -p "$DIR"

paso "1/7 Instalando artillery (npm ci)"
[ "$(node -v | cut -d. -f1)" = "v24" ] || echo "Aviso: se esperaba Node 24 y hay $(node -v)"
npm ci --silent || falla "npm ci"

paso "2/7 Levantando el sistema y reseteando la api"
docker compose -f $COMPOSE up -d --scale api="$REPLICAS" || falla "docker compose up"
docker compose -f $COMPOSE up -d --build --force-recreate --scale api="$REPLICAS" api nginx || falla "reset de la api"
ACTUALES=$(docker ps --filter label=com.docker.compose.service=api --format '{{.Names}}' | grep -c '^exchange-api-[0-9][0-9]*$' || true)
[ "$ACTUALES" -eq "$REPLICAS" ] || falla "se esperaban $REPLICAS replicas y hay $ACTUALES"
for _ in $(seq 30); do curl -sf -m 2 $API/rates > /dev/null && break; sleep 1; done
curl -sf -m 2 $API/rates > /dev/null || falla "la api no responde en $API/rates"
curl -s $API/accounts > "$DIR/cuentas-antes.json"
cp "$ESCENARIO.yaml" "$DIR/"

paso "3/7 Registrando el entorno"
{ uname -a; lscpu | grep -E 'Model name|^CPU\(s\)|Thread'; free -h; swapon --show
  docker version --format 'Engine {{.Server.Version}}'; docker compose version; node -v
  for replica in $(seq "$REPLICAS"); do
    docker inspect -f "{{.Name}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}" "exchange-api-$replica"
  done
} > "$DIR/entorno.txt" 2>&1
( cd /proc/sys/net/ipv4 && grep . ip_local_port_range tcp_tw_reuse tcp_max_tw_buckets tcp_fin_timeout ) > "$DIR/red-cliente.txt"

paso "4/7 Registros en segundo plano"
FILTROS=(--filter container=exchange-nginx-1)
for replica in $(seq "$REPLICAS"); do FILTROS+=(--filter "container=exchange-api-$replica"); done
docker events "${FILTROS[@]}" \
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
docker logs --since "$INICIO" exchange-nginx-1 > "$DIR/nginx-access.log" 2> "$DIR/nginx-error.log"
: > "$DIR/requests-por-replica.txt"
for replica in $(seq "$REPLICAS"); do
  IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "exchange-api-$replica")
  REQUESTS=$(grep -c "upstream=$IP:" "$DIR/nginx-access.log" || true)
  echo "$REQUESTS exchange-api-$replica ($IP)" >> "$DIR/requests-por-replica.txt"
  ESTADO=$(docker inspect -f '{{.State.Status}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Restarts={{.RestartCount}}' "exchange-api-$replica")
  echo "exchange-api-$replica: $ESTADO" >> "$DIR/estado-api-despues.txt"
  docker logs --since "$INICIO" "exchange-api-$replica" > "$DIR/api-$replica-stdout.log" 2> "$DIR/api-$replica-stderr.log"
done

paso "7/7 Exportando metricas de graphite"
sleep 15
API_IDS=$(seq -s, "$REPLICAS")
exportar() {
  local archivo=$1 q="" t
  shift
  for t in "$@"; do q="$q&target=$t"; done
  curl -sfg "$GRAPHITE/render?from=$((INICIO - 20))&until=$((FIN + 30))&format=json$q" > "$DIR/$archivo" \
    || echo "ERROR exportando de graphite" > "$DIR/$archivo"
}
exportar datos-recursos.json \
  "stats.gauges.cadvisor.{exchange-api-{$API_IDS},exchange-nginx-1}.cpu_cumulative_usage" \
  "stats.gauges.cadvisor.{exchange-api-{$API_IDS},exchange-nginx-1}.memory_working_set"
exportar datos-artillery-graphite.json "stats.gauges.$PREFIJO.*" "stats.gauges.$PREFIJO.*.*"

paso "Listo"
[ "$SALIDA" -ne 0 ] && echo "Ojo: artillery termino con exit $SALIDA"
echo "Resultados en: perf/$DIR"
EVENTOS_TXT=$(paste -sd '|' "$DIR/eventos-containers.txt" | sed 's/|/ | /g')
echo "Eventos de containers: ${EVENTOS_TXT:-ninguno}"
echo "Requests por replica: $(tr '\n' ';' < "$DIR/requests-por-replica.txt")"
echo "Grafana: prefijo $PREFIJO, containers exchange-api-1..$REPLICAS / exchange-nginx-1, desde $(date -d @"$INICIO" +%H:%M) hasta $(date -d @"$FIN" +%H:%M)"
