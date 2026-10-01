# Guia, microcache de GET /rates en nginx

En el codigo recibido cada `GET /rates` llega a la api, que es un solo proceso de Node con un
core. Las lecturas de tasas compiten por ese hilo con los `POST /exchange`, que son lo que le
importa al negocio.

La rama agrega en nginx una cache de 1 s para `GET /rates` (`location = /rates`):

- `proxy_cache_valid 200 1s`: guarda solo respuestas 200, durante 1 s.
- `proxy_cache_lock` y `proxy_cache_use_stale updating`: cuando la copia vence, un solo pedido
  va a la api y el resto espera o recibe la copia vieja, asi que a la api llega como mucho una
  lectura de tasas por segundo.
- `X-Cache-Status` en la respuesta dice si vino de la cache (`HIT`) o de la api (`MISS`,
  `EXPIRED`).
- Los `PUT /rates` no se cachean y siempre llegan a la api. `/accounts`, `/log` y `/exchange`
  no pasan por este location.

El costo es que un cliente puede ver una tasa de hasta 1 s de antiguedad. El cambio en si usa
siempre la tasa vigente, porque `POST /exchange` no pasa por la cache.

## Como verlo

Con el sistema levantado:

```
for i in 1 2 3; do curl -s -o /dev/null -D - http://localhost:5555/rates | grep X-Cache; done
curl -s -X PUT http://localhost:5555/rates -H 'Content-Type: application/json' \
  -d '{"baseCurrency":"USD","counterCurrency":"ARS","rate":1234}' > /dev/null
curl -s http://localhost:5555/rates; sleep 1.5; curl -s http://localhost:5555/rates
```

La primera lectura da `MISS` y las siguientes `HIT`. Despues del `PUT`, la lectura inmediata
todavia muestra la tasa vieja y la de 1,5 s despues ya muestra 1234.

## Como medirlo

El escenario `exchange-performance-lectura-tasas.yaml` manda 800 req/s (el B del caso base), 80 %
`GET /rates` y 20 % `POST /exchange`, durante 2 minutos. Se corre con la suite de `infra/suite`
en el caso base y en esta rama, como en `medir/cache-tasas`. En Grafana se compara la CPU de
`exchange-api-1` y la latencia de `GET /rates`. El P95 de `POST /exchange` no deberia cambiar,
porque lo fijan las dos transferencias simuladas.
