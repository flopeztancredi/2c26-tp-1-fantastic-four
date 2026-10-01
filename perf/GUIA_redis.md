# Guia, estado en Redis

En el codigo recibido, `state.js` tiene cuentas, tasas y log en la memoria de la api y los
reescribe enteros en los `.json` de `app/state` cada 1 a 5 s. Eso trae tres problemas:

- El log crece en la memoria de la api y se serializa entero en cada guardado: el costo y la
  memoria crecen con la cantidad de cambios acumulados.
- Con mas de una replica, cada una tendria su propia copia del estado y ninguna veria los cambios
  de la otra.
- `exchange()` chequea el saldo de nuestra cuenta y lo descuenta recien despues de dos
  `await transfer()`. Pedidos concurrentes pasan todos el chequeo y el saldo puede quedar negativo.

La rama agrega:

- Dos adaptadores de estado con la misma forma, en `app/repository/`: `file` (igual que antes) y
  `redis`. `app.js` elige uno con `STATE_ADAPTER` (default `file`; el compose pone `redis`) y se
  lo pasa a `exchange.js`.
- El adaptador de Redis: saldos y monedas en dos hashes, tasas en otro hash y el log en un stream.
  La primera replica que arranca contra un Redis vacio lo siembra desde `app/state`.
- `reserveBalance`, que chequea y descuenta en un solo paso: en archivos es una funcion sin `await`
  en el medio, en Redis es un script Lua. Si despues falla una transferencia,
  `creditBalance` devuelve lo reservado.
- El servicio `redis` en el compose, con AOF: si se reinicia pierde como mucho 1 s de escrituras.

En contra: Redis es un punto unico de falla, y si la api muere entre la reserva y la devolucion,
lo reservado queda descontado.

## Como verlo

Los tests, sin Redis (esos se saltean) y con un Redis descartable (hacen `FLUSHDB`):

```
cd app && npm test
docker run -d --rm --name redis-tests -p 127.0.0.1:6391:6379 redis:7.4.11
REDIS_URL=redis://127.0.0.1:6391 npm test
docker stop redis-tests
```

Para medir, el mismo breakpoint y endurance de siempre en los dos modos. Antes de cada corrida con
Redis hay que vaciarlo; el script recrea la api y esta lo vuelve a sembrar:

```
STATE_ADAPTER=file bash correr-breakpoint-linux.sh -n breakpoint_file
docker compose -f ../docker-compose.yml exec redis redis-cli FLUSHALL
bash correr-breakpoint-linux.sh -n breakpoint_redis
STATE_ADAPTER=file bash correr-breakpoint-linux.sh -e exchange-performance-endurance -n endurance_file
docker compose -f ../docker-compose.yml exec redis redis-cli FLUSHALL
bash correr-breakpoint-linux.sh -e exchange-performance-endurance -n endurance_redis
```
