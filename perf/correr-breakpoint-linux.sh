#!/usr/bin/env bash
# Uso y descripcion: perf/README.md
set -u
cd "$(dirname "$0")"

ESCENARIO=exchange-availability-breakpoint
NOMBRE=""
DIR_FIJO=""
while getopts "e:n:d:" opt; do
  case $opt in
    e) ESCENARIO=$OPTARG ;;
    n) NOMBRE=$OPTARG ;;
    d) DIR_FIJO=$OPTARG ;;
    *) echo "Uso: bash $0 [-e escenario] [-n nombre] [-d carpeta-completa-de-resultados]"; exit 2 ;;
  esac
done

# CORTO es todo lo que sigue a "exchange-<categoria>-" (categoria = una palabra: availability,
# performance, metricas, integridad, etc.). Nuevas categorias andan solas, no hace falta listarlas.
CORTO=$(echo "$ESCENARIO" | sed -E 's/^exchange-[^-]+-//')
PREFIJO=artillery-exchange-$CORTO
NOMBRE=${NOMBRE:-${CORTO}_linux}
COMPOSE=../docker-compose.yml
API=http://localhost:5555
GRAPHITE=http://localhost:8090
# -d gana siempre: la usa correr-suite-linux.sh para pasar la MISMA carpeta que ya calculo ella
# (si cada script calculara la suya con date +%F por separado, una corrida que cruza la
# medianoche -entre el enfriamiento, el npm ci y el reset- terminaria con dos nombres distintos:
# el subshell de FALLA nunca veria inicio.txt, y agregar_entorno/la captura apuntarian a una
# carpeta que no existe)
DIR=${DIR_FIJO:-resultados/$(date +%F)_$NOMBRE}
API_REPLICAS=${API_REPLICAS:-1}
SECO=${SECO:-0}

paso() { printf '\n=== %s\n' "$1"; }
falla() { echo "ERROR: $1" >&2; exit 1; }
# corre un comando de verdad, o solo lo imprime si SECO=1 (para probar sin tocar Docker)
ejecutar() {
  if [ "$SECO" = 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}
# nombres de los containers de la api, sin depender de docker: exchange-api-1..N (asi los nombra
# docker compose al escalar el servicio "api"). se usa tanto para actuar sobre ellos como para
# despues VERIFICAR contra "docker ps" que arrancaron todas las replicas esperadas
replicas_api() {
  seq 1 "$API_REPLICAS" | sed 's/^/exchange-api-/'
}

[ -f "$ESCENARIO.yaml" ] || falla "no existe $ESCENARIO.yaml"
[ -e "$DIR" ] && falla "ya existe $DIR. Usar -n para elegir otra carpeta."
case "$API_REPLICAS" in ''|*[!0-9]*|0) falla "API_REPLICAS debe ser un numero mayor a 0" ;; esac
# el spike (o cualquier escenario que lea EXCHANGE_SPIKE_RATE) no tiene default: el pico tiene
# que ser 2 x el B medido en ESTA maquina, no un numero generico. si nadie la seteo, mejor
# fallar clarito que correr con una tasa que no corresponde
if grep -q '\$processEnvironment\.EXCHANGE_SPIKE_RATE' "$ESCENARIO.yaml" 2> /dev/null && [ -z "${EXCHANGE_SPIKE_RATE:-}" ]; then
  falla "este escenario necesita EXCHANGE_SPIKE_RATE=<2 x B de esta maquina> (correr el breakpoint primero y exportarla)"
fi
for cmd in docker node npm curl vmstat taskset; do command -v $cmd > /dev/null || falla "falta $cmd"; done
ejecutar mkdir -p "$DIR"

# temperatura de paquete de CPU en grados C, o "n/d" si no se encuentra la zona. preferencia:
# x86_pkg_temp (coretemp, mas estandar) y si no existe, TCPU (zona ACPI de esta maquina)
temp_cpu() {
  local zona tipo buscada archivo
  for buscada in x86_pkg_temp TCPU; do
    for zona in /sys/class/thermal/thermal_zone*; do
      [ -r "$zona/type" ] || continue
      tipo=$(cat "$zona/type" 2> /dev/null)
      if [ "$tipo" = "$buscada" ]; then
        archivo="$zona/temp"
        if [ -r "$archivo" ]; then
          awk '{printf "%.1f", $1/1000}' "$archivo"
          return
        fi
      fi
    done
  done
  echo "n/d"
}

paso "1/7 Instalando artillery (npm ci)"
[ "$(node -v | cut -d. -f1)" = "v24" ] || echo "Aviso: se esperaba Node 24 y hay $(node -v)"
ejecutar npm ci --silent || falla "npm ci"

paso "2/7 Levantando el sistema"
ejecutar docker compose -f $COMPOSE up -d || falla "docker compose up"

# preparado para tactica/redis (otra rama): si hay un container redis CORRIENDO en el proyecto
# (no alcanza con que este declarado en el compose), se vacia antes de resetear la api, asi el
# adapter de estado arranca de nuevo sembrando desde app/state en vez de reusar lo que haya
# quedado de la corrida anterior. si no hay redis, sigue como hoy (estado en los .json de la imagen)
#
# ojo: ESTE nombre de variable, a proposito, no es STATE_ADAPTER. tactica/redis usa esa misma
# variable de entorno para que la api elija su adapter (docker compose se la pasa al container).
# si este script la reasignara aca (aunque no le ponga "export"), y alguien la corre con
# STATE_ADAPTER ya exportada en su shell (para elegir el adapter de la propia api), quedaria
# pisada con el valor que le pusieramos nosotros de aca en adelante para TODO lo que la herede
# (docker compose incluido: una asignacion sobre una variable ya exportada sigue exportada con
# el valor nuevo). probado: STATE_ADAPTER=file bash -c 'STATE_ADAPTER=archivos; sh -c "echo \$STATE_ADAPTER"'
# imprime "archivos", no "file". la etiqueta para entorno.txt/graficos usa su propio nombre
# (ESTADO_API) y el valor real se lee del container DESPUES del reset, nunca al reves
HAY_REDIS=0
if [ "$SECO" = 1 ]; then
  echo "+ (si hay un container exchange-redis-1 corriendo: docker compose -f $COMPOSE exec -T redis redis-cli FLUSHALL)"
else
  if docker ps --format '{{.Names}}' | grep -qx exchange-redis-1; then
    HAY_REDIS=1
    paso "Vaciando redis (el adapter vuelve a sembrar desde app/state)"
    docker compose -f $COMPOSE exec -T redis redis-cli FLUSHALL > /dev/null || falla "redis-cli FLUSHALL"
  fi
fi

paso "Reseteando la api ($API_REPLICAS replica(s))"
ejecutar docker compose -f $COMPOSE up -d --build --force-recreate --scale "api=$API_REPLICAS" api || falla "reset de la api"
if [ "$SECO" = 1 ]; then
  echo "+ (verificar con docker ps que corren exactamente $API_REPLICAS replicas: $(replicas_api | tr '\n' ' '))"
  ESTADO_API=archivos
else
  CORRIENDO=$(docker ps --format '{{.Names}}' | grep -c -E '^exchange-api-[0-9]+$')
  [ "$CORRIENDO" = "$API_REPLICAS" ] || falla "se esperaban $API_REPLICAS replica(s) de la api y hay $CORRIENDO corriendo"
  # valor REAL del adapter, leido del container recien recreado (no adivinado por este script)
  ESTADO_API=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' exchange-api-1 2> /dev/null \
    | sed -n 's/^STATE_ADAPTER=//p' | head -n1)
  ESTADO_API=${ESTADO_API:-archivos}
fi

if [ "$SECO" = 1 ]; then
  echo "+ (poll a $API/rates hasta 200 o timeout de 30 s)"
else
  for _ in $(seq 30); do curl -sf -m 2 $API/rates > /dev/null && break; sleep 1; done
  curl -sf -m 2 $API/rates > /dev/null || falla "la api no responde en $API/rates"
fi
ejecutar curl -s $API/accounts -o "$DIR/cuentas-antes.json"
ejecutar cp "$ESCENARIO.yaml" "$DIR/"

paso "3/7 Registrando el entorno"
TEMP_INICIO=$(temp_cpu)
if [ "$SECO" = 1 ]; then
  echo "+ (registrar uname/lscpu/free/swapon/docker version/node -v/API_REPLICAS=$API_REPLICAS/ESTADO_API=$ESTADO_API/HAY_REDIS=$HAY_REDIS/cpuset de $(replicas_api | tr '\n' ' ')exchange-nginx-1/ARTILLERY_CPUSET/EXCHANGE_SPIKE_RATE en $DIR/entorno.txt)"
  echo "+ (registrar ip_local_port_range/tcp_tw_reuse/tcp_max_tw_buckets/tcp_fin_timeout en $DIR/red-cliente.txt)"
else
  { uname -a; lscpu | grep -E 'Model name|^CPU\(s\)|Thread'; free -h; swapon --show
    docker version --format 'Engine {{.Server.Version}}'; docker compose version
    node -v
    echo "API_REPLICAS=$API_REPLICAS"
    echo "ESTADO_API=$ESTADO_API"
    echo "HAY_REDIS=$HAY_REDIS"
    docker inspect -f '{{.Name}}: Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} CpusetCpus={{.HostConfig.CpusetCpus}}' \
      $(replicas_api) exchange-nginx-1
    echo "ARTILLERY_CPUSET=${ARTILLERY_CPUSET:-12-15}"
    [ -n "${EXCHANGE_SPIKE_RATE:-}" ] && echo "EXCHANGE_SPIKE_RATE=$EXCHANGE_SPIKE_RATE"
  } > "$DIR/entorno.txt" 2>&1
  ( cd /proc/sys/net/ipv4 && grep . ip_local_port_range tcp_tw_reuse tcp_max_tw_buckets tcp_fin_timeout ) > "$DIR/red-cliente.txt"
fi

paso "4/7 Registros en segundo plano"
EVENTOS=""
SOCKSTAT=""
VMSTAT=""
if [ "$SECO" = 1 ]; then
  echo "+ (docker events, sockstat cada 5s y vmstat en segundo plano, para $(replicas_api | tr '\n' ' ')exchange-nginx-1)"
else
  FILTROS=()
  for c in $(replicas_api) exchange-nginx-1; do FILTROS+=(--filter "container=$c"); done
  docker events "${FILTROS[@]}" \
    --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}' \
    > "$DIR/eventos-containers.txt" 2> "$DIR/eventos-containers.err.txt" &
  EVENTOS=$!
  ( while true; do echo "### $(date +%s) $(date -u +%FT%TZ)"; cat /proc/net/sockstat; grep TcpExt: /proc/net/netstat; sleep 5; done ) \
    > "$DIR/sockstat-cliente.txt" &
  SOCKSTAT=$!
  vmstat -t 5 > "$DIR/vmstat-host.txt" &
  VMSTAT=$!
fi
trap '[ -n "$EVENTOS" ] && kill $EVENTOS 2> /dev/null; [ -n "$SOCKSTAT" ] && kill $SOCKSTAT 2> /dev/null; [ -n "$VMSTAT" ] && kill $VMSTAT 2> /dev/null' EXIT

paso "5/7 Corriendo artillery"
INICIO=$(date +%s)
if [ "$SECO" = 1 ]; then
  echo "+ (registrar inicio=$INICIO y temperatura_cpu_inicio_C=$TEMP_INICIO)"
else
  echo "$INICIO" > "$DIR/inicio.txt"
  echo "temperatura_cpu_inicio_C=$TEMP_INICIO" >> "$DIR/entorno.txt"
fi
# artillery en cores lentos (E), lejos de la api y de nginx (ver cpuset en docker-compose.yml)
if [ "$SECO" = 1 ]; then
  echo "+ taskset -c ${ARTILLERY_CPUSET:-12-15} npx artillery run $ESCENARIO.yaml -e api --output $DIR/reporte-artillery.json"
  SALIDA=0
else
  taskset -c "${ARTILLERY_CPUSET:-12-15}" npx artillery run "$ESCENARIO.yaml" -e api --output "$DIR/reporte-artillery.json" 2>&1 | tee "$DIR/resultados-artillery.txt"
  SALIDA=${PIPESTATUS[0]}
fi
FIN=$(date +%s)
TEMP_FIN=$(temp_cpu)
if [ "$SECO" = 1 ]; then
  echo "+ (registrar fin=$FIN y temperatura_cpu_fin_C=$TEMP_FIN)"
else
  echo "$FIN" > "$DIR/fin.txt"
  echo "temperatura_cpu_fin_C=$TEMP_FIN" >> "$DIR/entorno.txt"
fi
[ -n "$EVENTOS" ] && kill $EVENTOS 2> /dev/null
[ -n "$SOCKSTAT" ] && kill $SOCKSTAT 2> /dev/null
[ -n "$VMSTAT" ] && kill $VMSTAT 2> /dev/null

paso "6/7 Guardando saldos, estado y logs"
if [ "$SECO" = 1 ]; then
  echo "+ (guardar cuentas-despues.json, estado y logs de $(replicas_api | tr '\n' ' ')y de exchange-nginx-1)"
  ESTADO="(SECO: no inspeccionado)"
else
  curl -sf -m 10 $API/accounts > "$DIR/cuentas-despues.json" \
    || echo "ERROR: la api no respondio a /accounts" > "$DIR/cuentas-despues.json"
  : > "$DIR/estado-api-despues.txt"
  for c in $(replicas_api); do
    docker inspect -f '{{.Name}} {{.State.Status}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Restarts={{.RestartCount}}' "$c" \
      >> "$DIR/estado-api-despues.txt"
  done
  # tr '\n' ' | ' NO hace lo que parece: tr mapea caracter a caracter, y con un set2 de 3
  # caracteres solo usa el primero (' '), asi que " | " se perdia en silencio. mismo patron que
  # ya se usaba abajo para EVENTOS_TXT
  ESTADO=$(paste -sd '|' "$DIR/estado-api-despues.txt" | sed 's/|/ | /g')
  docker logs --since "$INICIO" exchange-nginx-1 > "$DIR/nginx-access.log" 2> "$DIR/nginx-error.log"
  : > "$DIR/api-stdout.log"; : > "$DIR/api-stderr.log"
  for c in $(replicas_api); do
    docker logs --since "$INICIO" "$c" >> "$DIR/api-stdout.log" 2>> "$DIR/api-stderr.log"
  done
fi

paso "7/7 Exportando metricas de graphite"
ejecutar sleep 15
exportar() {
  local archivo=$1 q="" t
  shift
  for t in "$@"; do q="$q&target=$t"; done
  if [ "$SECO" = 1 ]; then
    echo "+ curl $GRAPHITE/render?from=$((INICIO - 20))&until=$((FIN + 30))&format=json$q -> $DIR/$archivo"
    return
  fi
  curl -sfg "$GRAPHITE/render?from=$((INICIO - 20))&until=$((FIN + 30))&format=json$q" > "$DIR/$archivo" \
    || echo "ERROR exportando de graphite" > "$DIR/$archivo"
}
# con 1 replica, el patron es igual al de siempre (exchange-api-1); con mas de 1, comodin
PATRON_API=exchange-api-1
[ "$API_REPLICAS" -gt 1 ] && PATRON_API='exchange-api-*'
CONTAINERS_RECURSOS="$PATRON_API,exchange-nginx-1"
# con redis, tambien su cpu/memoria: la guia de la tactica compara ese costo contra el caso base
[ "$HAY_REDIS" = 1 ] && CONTAINERS_RECURSOS="$CONTAINERS_RECURSOS,exchange-redis-1"
exportar datos-recursos.json \
  "stats.gauges.cadvisor.{$CONTAINERS_RECURSOS}.cpu_cumulative_usage" \
  "stats.gauges.cadvisor.{$CONTAINERS_RECURSOS}.memory_working_set"
exportar datos-artillery-graphite.json "stats.gauges.$PREFIJO.*" "stats.gauges.$PREFIJO.*.*"

paso "Listo"
[ "$SALIDA" -ne 0 ] && echo "Ojo: artillery termino con exit $SALIDA"
echo "Resultados en: perf/$DIR"
if [ "$SECO" != 1 ]; then
  EVENTOS_TXT=$(paste -sd '|' "$DIR/eventos-containers.txt" | sed 's/|/ | /g')
  echo "Eventos de containers: ${EVENTOS_TXT:-ninguno}"
fi
echo "Estado de la api: $ESTADO"
echo "Grafana: prefijo $PREFIJO, containers $(replicas_api | tr '\n' ' ')/ exchange-nginx-1, desde $(date -d @"$INICIO" +%H:%M) hasta $(date -d @"$FIN" +%H:%M)"
echo "Temperatura CPU: inicio ${TEMP_INICIO} C, fin ${TEMP_FIN} C"
