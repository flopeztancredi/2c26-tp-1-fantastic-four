# Guia, rate limiting de POST /exchange en nginx

En el codigo recibido nginx le pasa a la api todo lo que llega. Por encima de lo que la api
puede atender, los pedidos se acumulan y la latencia empeora para todos los clientes.

La rama limita `/exchange` en nginx a 720 req/s, 0,9 del B de 800 req/s medido en el caso base
con la suite de `infra/suite` (10 % de margen). Acepta picos de hasta 72 pedidos por encima de
esa tasa (`burst=72`, una decima de segundo a 720 req/s), y lo que excede recibe 429 al instante
(`nodelay`) en vez de esperar en la cola. El resto de las rutas (`/rates`, `/accounts`, `/log`)
queda sin limite.

- El limite es global y no por cliente: en esta capa no hay identidad de cliente, y en las
  pruebas Artillery manda todo desde una sola IP.
- La clave de `limit_req_zone` es el literal `global`, asi todos los pedidos suman al mismo
  contador.
- La tasa esta fija en el archivo: si cambia B (por ejemplo con mas replicas), hay que
  actualizarla a mano.

## Como verlo

Con curl no se llega a 720 req/s, porque cada cambio tarda entre 400 y 800 ms. Para ver el
limite, bajar a mano la tasa a `rate=5r/s` y el burst a `burst=2`, recrear nginx
(`docker compose up -d --force-recreate nginx`) y mandar 40 cambios en paralelo:

```
seq 1 40 | xargs -P 40 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:5555/exchange -H 'Content-Type: application/json' \
  -d '{"baseCurrency":"ARS","counterCurrency":"USD","baseAmount":1,"baseAccountId":101,"counterAccountId":102}' \
  | sort | uniq -c
```

Unos pocos dan 200 y el resto 429. Las otras rutas no se limitan: 40 pedidos a `/rates` dan
todos 200.

```
seq 1 40 | xargs -P 40 -I{} curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5555/rates | sort | uniq -c
```

Despues volver a 720 y 72 y recrear nginx de nuevo.

## Como medirlo

Se mide con la suite de `infra/suite`, como en la rama `medir/rate-limiting`: el breakpoint de
esta base llega a 640 req/s y nunca supera el limite. En la suite el 429 cuenta como atendido,
asi que el B sube aunque la api no atienda mas cambios: lo que muestra la tactica es que lo que
pasa de 720 req/s recibe 429 en vez de timeouts y 502. En el spike, con 720 req/s, se rechazo el
28,7 % de los pedidos.
