#!/usr/bin/env bash
# Uso y descripcion completa: GUIA_suite.md (resumen corto en README.md)
#
# Uso: bash correr-suite-linux.sh <escenario1> [escenario2 ...]
#   (cada <escenario> es un yaml de perf/ sin la extension, por ejemplo exchange-availability-breakpoint)
#
# Opciones por variable de entorno:
#   REPETICIONES=N   corridas por escenario (default 3)
#   QUIETUD=S        segundos de descanso entre el calentamiento y la corrida medida (default 60)
#   API_REPLICAS=N   replicas de la api (pasa --scale api=N). ver aviso al final del script:
#                    hoy correr-breakpoint-linux.sh no soporta mas de 1
#   FALLA=kill|stop  induce una falla de la api durante la corrida medida (docker kill / stop)
#   FALLA_A=S        segundos desde el inicio de la corrida medida para la falla (obligatorio con FALLA)
#   FORZAR=1         corre igual si la maquina esta a bateria
#   POWER_SUPPLY_DIR=ruta  de donde leer el estado de alimentacion (default /sys/class/power_supply)
#   SECO=1           imprime los comandos en vez de ejecutarlos (para revisar la suite sin medir)
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
API=http://localhost:5555
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
case "$API_REPLICAS" in ''|*[!0-9]*) falla_uso "API_REPLICAS debe ser un numero" ;; esac
if [ -n "$FALLA" ]; then
  case "$FALLA" in kill|stop) ;; *) falla_uso "FALLA debe ser 'kill' o 'stop'" ;; esac
  case "$FALLA_A" in ''|*[!0-9]*) falla_uso "FALLA necesita FALLA_A=<segundos>" ;; esac
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
# codigo de salida como el $? de la linea de asignacion (probado), asi que el punto de llamada
# tiene que chequearlo con "|| exit 1": sin eso el script seguia de largo con bateria
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

    paso "Recreando la api con el estado inicial de la imagen"
    ejecutar docker compose -f "$COMPOSE" up -d
    ejecutar docker compose -f "$COMPOSE" up -d --build --force-recreate --scale "api=$API_REPLICAS" api

    paso "Esperando a que la api responda por nginx"
    if [ "$SECO" = 1 ]; then
      echo "+ (poll a $API/rates hasta 200 o timeout de 30 s)"
    else
      LISTA=0
      for _ in $(seq 30); do
        curl -sf -m 2 "$API/rates" > /dev/null && { LISTA=1; break; }
        sleep 1
      done
      [ "$LISTA" = 1 ] || falla_uso "la api no responde en $API/rates"
    fi

    paso "Calentamiento (no se analiza)"
    ejecutar npx artillery run exchange-availability-calentamiento.yaml -e api

    paso "Quietud de ${QUIETUD}s antes de medir, para que los paneles bajen a la linea de base"
    ejecutar sleep "$QUIETUD"

    NOMBRE="${RAMA}_${CORTO}_corrida${i}"
    RESULT_DIR="resultados/$(date +%F)_$NOMBRE"

    FALLA_PID=""
    if [ -n "$FALLA" ]; then
      if [ "$SECO" = 1 ]; then
        echo "+ (a los ${FALLA_A}s de iniciada la corrida medida: docker $FALLA exchange-api-1," \
             "registrado con hora en $RESULT_DIR/falla-inducida.txt)"
      else
        (
          # espera a que exista inicio.txt (lo escribe correr-breakpoint-linux.sh justo antes de
          # arrancar artillery) y programa la falla desde ESE instante, no desde el arranque del runner
          while [ ! -f "$RESULT_DIR/inicio.txt" ]; do sleep 0.5; done
          INICIO_REAL=$(cat "$RESULT_DIR/inicio.txt")
          OBJETIVO=$((INICIO_REAL + FALLA_A))
          while [ "$(date +%s)" -lt "$OBJETIVO" ]; do sleep 1; done
          docker "$FALLA" exchange-api-1 > /dev/null 2>&1
          echo "$(date +%s) $(date -u +%FT%TZ) docker $FALLA exchange-api-1" >> "$RESULT_DIR/falla-inducida.txt"
        ) &
        FALLA_PID=$!
      fi
    fi

    paso "Corriendo el escenario medido (correr-breakpoint-linux.sh)"
    ejecutar bash correr-breakpoint-linux.sh -e "$ESCENARIO" -n "$NOMBRE"

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
if [ "$API_REPLICAS" != 1 ]; then
  echo "Aviso: con API_REPLICAS=$API_REPLICAS, correr-breakpoint-linux.sh va a abortar (hoy" \
       "rechaza mas de una replica de la api) y ademas su propio reset no repite --scale, asi" \
       "que si llegara a pasar ese chequeo la volveria a bajar a 1. Hace falta extender ese" \
       "script para soportar N replicas antes de usar esta opcion de verdad."
fi
