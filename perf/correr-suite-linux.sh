#!/usr/bin/env bash
# Uso y descripcion completa: GUIA_suite.md (resumen corto en README.md)
#
# Uso: bash correr-suite-linux.sh <escenario1> [escenario2 ...]
#   (cada <escenario> es un yaml de perf/ sin la extension, por ejemplo exchange-availability-breakpoint)
#
# Opciones por variable de entorno:
#   REPETICIONES=N        corridas por escenario (default 3)
#   QUIETUD=S              segundos de enfriamiento antes de resetear la api, para que los
#                          paneles bajen a la linea de base de la corrida anterior (default 60)
#   API_REPLICAS=N         replicas de la api (correr-breakpoint-linux.sh hace el --scale y
#                          verifica que arrancaron las N)
#   FALLA=kill|stop|crash   induce una falla de exchange-api-1 durante la corrida medida:
#                          kill = docker kill (SIGKILL, Docker lo trata como parada manual,
#                          no dispara restart policy); stop = docker stop (SIGTERM + 10s de
#                          gracia, tampoco dispara restart policy); crash = mata el proceso
#                          real con kill -9 desde afuera de Docker, que si dispara "restart:
#                          unless-stopped"
#   FALLA_A=S              segundos desde el inicio de la corrida medida para la falla (obligatorio con FALLA)
#   FORZAR=1               corre igual si la maquina esta a bateria
#   POWER_SUPPLY_DIR=ruta  de donde leer el estado de alimentacion (default /sys/class/power_supply)
#   SECO=1                 imprime los comandos en vez de ejecutarlos (para revisar la suite sin medir)
set -u
cd "$(dirname "$0")"

REPETICIONES=${REPETICIONES:-3}
QUIETUD=${QUIETUD:-60}
API_REPLICAS=${API_REPLICAS:-1}
FALLA=${FALLA:-}
FALLA_A=${FALLA_A:-}
FORZAR=${FORZAR:-0}
POWER_SUPPLY_DIR=${POWER_SUPPLY_DIR:-/sys/class/power_supply}
SECO=${SECO:-0}
COMPOSE=../docker-compose.yml
LOCK=/tmp/arvault-midiendo.lock

paso() { printf '\n### %s\n' "$1"; }
falla_uso() { echo "ERROR: $1" >&2; exit 1; }

# ejecuta un comando de verdad, o solo lo imprime si SECO=1 (para probar la suite sin tocar docker)
ejecutar() {
  if [ "$SECO" = 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

[ $# -ge 1 ] || falla_uso "uso: bash $0 <escenario1> [escenario2 ...]"
for esc in "$@"; do
  [ -f "$esc.yaml" ] || falla_uso "no existe $esc.yaml"
done
case "$REPETICIONES" in ''|*[!0-9]*) falla_uso "REPETICIONES debe ser un numero" ;; esac
case "$QUIETUD" in ''|*[!0-9]*) falla_uso "QUIETUD debe ser un numero" ;; esac
case "$API_REPLICAS" in ''|*[!0-9]*|0) falla_uso "API_REPLICAS debe ser un numero mayor a 0" ;; esac
if [ -n "$FALLA" ]; then
  case "$FALLA" in kill|stop|crash) ;; *) falla_uso "FALLA debe ser 'kill', 'stop' o 'crash'" ;; esac
  case "$FALLA_A" in ''|*[!0-9]*) falla_uso "FALLA necesita FALLA_A=<segundos>" ;; esac
fi
export API_REPLICAS COMPOSE

# rama, commit y working tree, para entorno.txt de cada corrida (ver "Runner de la suite")
RAMA=$(git rev-parse --abbrev-ref HEAD 2> /dev/null | tr '/' '-')
RAMA=${RAMA:-sin-git}
COMMIT=$(git rev-parse --short HEAD 2> /dev/null || echo sin-git)
CAMBIOS_SIN_COMMITEAR=$(git status --porcelain 2> /dev/null | wc -l | tr -d ' ')

# alimentacion: aborta si esta a bateria, salvo FORZAR=1. se chequea en cada corrida (no solo al
# arrancar) para no dejar mediciones a mitad de camino si alguien desenchufa la notebook.
# ojo con esta funcion llamada como ENCHUFADO=$(chequear_alimentacion): el exit adentro de
# falla_uso corta el SUBSHELL de la sustitucion de comandos, no el script. bash si propaga ese
# codigo de salida como el $? de la linea de asignacion (probado mas abajo), asi que el punto de
# llamada tiene que chequearlo con "|| exit 1": sin eso el script seguia de largo con bateria
chequear_alimentacion() {
  local enchufado=0 f
  for f in "$POWER_SUPPLY_DIR"/*/online; do
    [ -r "$f" ] || continue
    [ "$(cat "$f" 2> /dev/null)" = "1" ] && enchufado=1
  done
  if [ "$enchufado" -eq 0 ] && [ "$FORZAR" != 1 ]; then
    falla_uso "la maquina esta a bateria (revisado en $POWER_SUPPLY_DIR). Enchufala o corre con FORZAR=1 para medir igual"
  fi
  echo "$enchufado"
}

# agrega a entorno.txt lo que correr-breakpoint-linux.sh no sabe: rama/commit/working tree y
# alimentacion/perfil/governor. se hace despues porque ese archivo lo crea correr-breakpoint-linux.sh
agregar_entorno() {
  local dir=$1 enchufado=$2 perfil=n/d governor=n/d
  if command -v powerprofilesctl > /dev/null 2>&1; then
    perfil=$(powerprofilesctl get 2> /dev/null || echo n/d)
  fi
  governor=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2> /dev/null || echo n/d)
  {
    echo "rama=$RAMA commit=$COMMIT cambios_sin_commitear=$CAMBIOS_SIN_COMMITEAR"
    echo "enchufado=$([ "$enchufado" = 1 ] && echo si || echo no) perfil_energia=$perfil governor_cpu_cpu0=$governor"
  } >> "$dir/entorno.txt"
}

if [ "$SECO" = 1 ]; then
  echo "+ (crear $LOCK si no existe, o abortar si ya hay uno)"
else
  [ -e "$LOCK" ] && falla_uso "ya hay una medicion en curso ($LOCK). Si quedo de una corrida vieja, borralo a mano"
  : > "$LOCK"
  trap 'rm -f "$LOCK"' EXIT
fi

for ESCENARIO in "$@"; do
  # mismo CORTO que correr-breakpoint-linux.sh, para que el nombre de carpeta y el prefijo de
  # statsd de esa corrida sean consistentes entre si
  CORTO=$(echo "$ESCENARIO" | sed -E 's/^exchange-[^-]+-//')

  for i in $(seq 1 "$REPETICIONES"); do
    paso "$ESCENARIO, corrida $i/$REPETICIONES"
    ENCHUFADO=$(chequear_alimentacion) || exit 1

    NOMBRE="${RAMA}_${CORTO}_corrida${i}"
    RESULT_DIR="resultados/$(date +%F)_$NOMBRE"
    [ -e "$RESULT_DIR" ] && falla_uso "ya existe $RESULT_DIR de una corrida anterior. Elegi otro nombre, cambia REPETICIONES o borrala a mano"

    paso "Enfriamiento de ${QUIETUD}s antes de resetear, para que los paneles bajen a la linea de base"
    ejecutar sleep "$QUIETUD"

    FALLA_PID=""
    if [ -n "$FALLA" ]; then
      if [ "$SECO" = 1 ]; then
        echo "+ (a los ${FALLA_A}s de iniciada la corrida medida: falla '$FALLA' sobre exchange-api-1," \
             "registrado con hora en $RESULT_DIR/falla-inducida.txt)"
      else
        (
          # espera acotada a que exista inicio.txt (lo escribe correr-breakpoint-linux.sh justo
          # antes de arrancar artillery). si ese script no llega a arrancar la medicion (falta
          # espacio, la api no responde, npm ci lento, etc.) este subshell no se puede quedar
          # esperando para siempre: corta a los 180s o antes si aparece fin.txt (corrida ya
          # termino sin haber llegado a medir)
          LLEGO=0
          for _ in $(seq 360); do
            [ -f "$RESULT_DIR/inicio.txt" ] && { LLEGO=1; break; }
            [ -f "$RESULT_DIR/fin.txt" ] && break
            sleep 0.5
          done
          [ "$LLEGO" = 1 ] || exit 0

          INICIO_REAL=$(cat "$RESULT_DIR/inicio.txt")
          OBJETIVO=$((INICIO_REAL + FALLA_A))
          while [ "$(date +%s)" -lt "$OBJETIVO" ]; do
            [ -f "$RESULT_DIR/fin.txt" ] && exit 0
            sleep 1
          done
          [ -f "$RESULT_DIR/fin.txt" ] && exit 0

          case "$FALLA" in
            kill) docker kill exchange-api-1 > /dev/null 2>&1 ;;
            stop) docker stop exchange-api-1 > /dev/null 2>&1 ;;
            crash)
              # kill -9 desde afuera de docker: a diferencia de "docker kill"/"docker stop" (que
              # docker registra como parada manual), esto si dispara "restart: unless-stopped"
              PID_API=$(docker inspect -f '{{.State.Pid}}' exchange-api-1 2> /dev/null)
              [ -n "$PID_API" ] && docker run --rm --pid=host alpine:3 kill -9 "$PID_API" > /dev/null 2>&1
              ;;
          esac
          echo "$(date +%s) $(date -u +%FT%TZ) falla=$FALLA exchange-api-1" >> "$RESULT_DIR/falla-inducida.txt"
        ) &
        FALLA_PID=$!
      fi
    fi

    paso "Corriendo el escenario medido (correr-breakpoint-linux.sh)"
    # esta llamada NO pasa por ejecutar(): correr-breakpoint-linux.sh ya respeta su propio SECO
    # (heredado del entorno) y con el dry run entero se ve tambien su secuencia interna
    # (replicas, redis, EXCHANGE_SPIKE_RATE), no solo esta linea como un comando opaco
    bash correr-breakpoint-linux.sh -e "$ESCENARIO" -n "$NOMBRE"
    SALIDA=$?

    if [ "$SALIDA" -ne 0 ]; then
      if [ -n "$FALLA_PID" ]; then kill "$FALLA_PID" 2> /dev/null; wait "$FALLA_PID" 2> /dev/null; fi
      falla_uso "correr-breakpoint-linux.sh termino con exit $SALIDA en $ESCENARIO corrida $i/$REPETICIONES. Aborto la suite, no toco $RESULT_DIR."
    fi
    [ -n "$FALLA_PID" ] && wait "$FALLA_PID" 2> /dev/null

    if [ "$SECO" = 1 ]; then
      echo "+ (agregar rama/commit/cambios sin commitear y enchufado/perfil/governor a $RESULT_DIR/entorno.txt)"
    else
      agregar_entorno "$RESULT_DIR" "$ENCHUFADO"
    fi

    paso "Capturando el dashboard de Grafana"
    ejecutar node capturar-grafana.mjs "$RESULT_DIR"
  done
done

paso "Suite terminada"
