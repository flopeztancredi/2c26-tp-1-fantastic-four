#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

ESCENARIO="exchange-availability-failure-recovery.yaml"
COMPOSE="../docker-compose.yml"
API="http://localhost:5555"

falla() {
  echo "ERROR: $1" >&2
  exit 1
}

for cmd in docker curl npm npx; do
  command -v "$cmd" > /dev/null || falla "falta $cmd"
done

[ -f "$ESCENARIO" ] || falla "no existe $ESCENARIO"

ARTILLERY_PID=""
limpiar() {
  if [ -n "$ARTILLERY_PID" ] && kill -0 "$ARTILLERY_PID" 2> /dev/null; then
    kill "$ARTILLERY_PID" 2> /dev/null || true
  fi
}
trap limpiar INT TERM EXIT

printf '\n=== Instalando dependencias de Artillery\n'
npm ci --silent

printf '\n=== Levantando y recreando la API\n'
docker compose -f "$COMPOSE" up -d
docker compose -f "$COMPOSE" up -d --build --force-recreate api

for _ in $(seq 30); do
  if curl -sf -m 2 "$API/rates" > /dev/null; then
    break
  fi
  sleep 1
done
curl -sf -m 2 "$API/rates" > /dev/null || falla "la API no responde en $API/rates"

printf '\n=== Iniciando Artillery\n'
INICIO=$(date +%s)
npx --no-install artillery run "$ESCENARIO" -e api &
ARTILLERY_PID=$!

sleep 60
if ! kill -0 "$ARTILLERY_PID" 2> /dev/null; then
  wait "$ARTILLERY_PID" || true
  falla "Artillery termino antes de la inyeccion de la caida"
fi

printf '\n=== Inyectando caida con docker kill\n'
CAIDA=$(date +%s)
API_CONTAINER=$(docker compose -f "$COMPOSE" ps -q api)
[ -n "$API_CONTAINER" ] || falla "no se encontro el contenedor de la API"
docker kill "$API_CONTAINER"

printf '\n=== Observando la recuperacion durante 120 segundos\n'
sleep 120

if wait "$ARTILLERY_PID"; then
  SALIDA=0
else
  SALIDA=$?
fi
ARTILLERY_PID=""
FIN=$(date +%s)

printf '\n=== Listo\n'
echo "Artillery exit: $SALIDA"
echo "Inicio: $INICIO"
echo "Docker kill: $CAIDA"
echo "Fin: $FIN"

exit "$SALIDA"
