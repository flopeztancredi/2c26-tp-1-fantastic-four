# Guia, replicas de la api

El round robin entre `exchange-api-1`, `exchange-api-2` y `exchange-api-3` (y `-r` en
`correr-breakpoint-linux.sh` para elegir cuantas) reparte los pedidos, pero tiene dos limites:

- El upstream nombra tres containers fijos: con otra cantidad de replicas nginx no arranca, por
  eso hace falta `nginx_reverse_proxy-1.conf` para una sola.
- Cada replica tiene su propia copia del estado en memoria (ver `GUIA_redis.md`): un cambio
  hecho en una no se ve en la otra.

La rama agrega:

- En nginx, un `upstream` con `zone` y `server api:3000 resolve`: con el DNS de Docker
  (`resolver 127.0.0.11 valid=5s`) encuentra todas las replicas de `api`, sean cuantas sean, y
  las vuelve a buscar cada 5 s.
- En el compose, `depends_on` en lugar de `links`, que no funciona con `--scale`.
- Con `STATE_ADAPTER=redis` (el default del compose) las replicas comparten el estado, y el
  chequeo y descuento de saldo es atomico entre todas porque lo hace un script Lua en Redis.

## Como verlo

La prueba de consistencia, desde la raiz del repo: un cambio directo a la replica 1 (sin pasar
por nginx) y despues leer las cuentas de cada replica por separado.

```
STATE_ADAPTER=file docker compose up -d --build --force-recreate --scale api=2 api
docker compose exec --index=1 api node -e "fetch('http://localhost:3000/exchange', {
  method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({baseCurrency: 'ARS', counterCurrency: 'USD', baseAmount: 1000, baseAccountId: 101, counterAccountId: 102})
}).then(r => r.text()).then(console.log)"
docker compose exec --index=1 api node -e "fetch('http://localhost:3000/accounts').then(r => r.text()).then(console.log)"
docker compose exec --index=2 api node -e "fetch('http://localhost:3000/accounts').then(r => r.text()).then(console.log)"
```

Con `file` la replica 2 sigue con los saldos iniciales. Despues correr
`docker compose exec redis redis-cli FLUSHALL` y repetir los cuatro comandos sin
`STATE_ADAPTER=file`: las dos replicas devuelven los mismos saldos.

Para el breakpoint con 2 replicas, desde `perf/`:

```
bash correr-breakpoint-linux.sh -r 2 -n breakpoint-2-replicas
```

En Grafana, la CPU de `exchange-api-1` y `exchange-api-2` muestra si las dos se cargan parejo;
la de `exchange-redis-1` y `exchange-nginx-1`, si el limite pasa a ser alguno de ellos.
