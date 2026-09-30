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
#   FALLA_A=S              segundos desde el inicio de la corrida medida para la falla (obligatorio
#                          con FALLA). Si no queda falla-inducida.txt en la carpeta de resultados
#                          (FALLA_A mas largo que el escenario, por ejemplo), la suite aborta:
#                          nunca sigue como si la falla se hubiera inducido sin inducirla
#   FORZAR=1               corre igual si la maquina esta a bateria
#   POWER_SUPPLY_DIR=ruta  de donde leer el estado de alimentacion (default /sys/class/power_supply)
#   SECO=1                 imprime los comandos en vez de ejecutarlos (para revisar la suite sin medir)
#   DESPUES_DE_CORRIDA=cmd  comando que se corre al final de cada corrida, con la carpeta de
#                          resultados como $1, antes del reset de la siguiente (la api sigue viva):
#                          sirve para guardar lo que la suite no guarda, como GET /log
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
DESPUES_DE_CORRIDA=${DESPUES_DE_CORRIDA:-}
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

# prefetch de la imagen que usa FALLA=crash: si se bajara recien en el instante de inducir la
# falla, esa demora se suma al momento en que se supone que la api ya deberia estar cayendo
if [ "$FALLA" = crash ]; then
  paso "Prefetching alpine:3 (para FALLA=crash)"
  ejecutar docker pull -q alpine:3
fi

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
          # espera a que exista inicio.txt (lo escribe correr-breakpoint-linux.sh justo antes de
          # arrancar artillery). SIN tope de tiempo: un tope aca competiria con el chequeo de
          # SALIDA de mas abajo, que ya mata este subshell si correr-breakpoint-linux.sh termina
          # mal. con un tope, este subshell se "rendia" en silencio (exit 0, sin avisar a nadie)
          # si el script tardaba de mas en arrancar la medicion (el primer build tras cambiar de
          # rama, por ejemplo), y la corrida seguia midiendo tranquila sin la falla. la unica
          # salida temprana valida es que la corrida ya haya terminado sin haber llegado a medir
          while [ ! -f "$RESULT_DIR/inicio.txt" ]; do
            [ -f "$RESULT_DIR/fin.txt" ] && exit 0
            sleep 0.5
          done

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
    # (replicas, redis, EXCHANGE_SPIKE_RATE), no solo esta linea como un comando opaco.
    # -d "$RESULT_DIR": le pasamos LA MISMA carpeta que ya calculamos aca arriba, para que
    # no la recalcule con su propio date +%F. si la corrida cruza la medianoche (enfriamiento +
    # npm ci + reset pueden tardar), recalcularla adentro daria un nombre de carpeta distinto:
    # el subshell de FALLA nunca veria inicio.txt y agregar_entorno/la captura apuntarian a una
    # carpeta que no existe
    bash correr-breakpoint-linux.sh -e "$ESCENARIO" -n "$NOMBRE" -d "$RESULT_DIR"
    SALIDA=$?

    if [ "$SALIDA" -ne 0 ]; then
      if [ -n "$FALLA_PID" ]; then kill "$FALLA_PID" 2> /dev/null; wait "$FALLA_PID" 2> /dev/null; fi
      falla_uso "correr-breakpoint-linux.sh termino con exit $SALIDA en $ESCENARIO corrida $i/$REPETICIONES. Aborto la suite, no toco $RESULT_DIR."
    fi
    [ -n "$FALLA_PID" ] && wait "$FALLA_PID" 2> /dev/null

    # si se pidio FALLA y no quedo falla-inducida.txt, paso en silencio: FALLA_A mas largo que
    # la corrida, el escenario termino antes de tiempo, etc. no seguir como si la falla se
    # hubiera inducido: mejor un aborto ruidoso que un resultado de recuperacion que no mide nada
    if [ -n "$FALLA" ] && [ "$SECO" != 1 ] && [ ! -f "$RESULT_DIR/falla-inducida.txt" ]; then
      falla_uso "la falla no se indujo en $RESULT_DIR (revisar FALLA_A=$FALLA_A contra la duracion de $ESCENARIO). Aborto la suite."
    fi

    if [ "$SECO" = 1 ]; then
      echo "+ (agregar rama/commit/cambios sin commitear y enchufado/perfil/governor a $RESULT_DIR/entorno.txt)"
    else
      agregar_entorno "$RESULT_DIR" "$ENCHUFADO"
    fi

    paso "Capturando el dashboard de Grafana"
    ejecutar node capturar-grafana.mjs "$RESULT_DIR"

    # el comando del usuario no corta la suite si falla: lo que guarda es un agregado a la corrida
    if [ -n "$DESPUES_DE_CORRIDA" ]; then
      paso "Despues de la corrida: $DESPUES_DE_CORRIDA"
      ejecutar bash -c "$DESPUES_DE_CORRIDA" despues-de-corrida "$RESULT_DIR" \
        || echo "aviso: DESPUES_DE_CORRIDA termino con error en $RESULT_DIR" >&2
    fi
  done
done

paso "Suite terminada"
