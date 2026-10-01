# Guia, reserva de fondos contra la carrera de saldos

En el codigo recibido, `exchange()` chequea el saldo de la cuenta contraparte y lo descuenta
recien despues de las dos transferencias simuladas, entre 400 y 800 ms mas tarde. En ese lapso,
otros cambios sobre la misma cuenta leen el mismo saldo sin descontar y tambien pasan el chequeo:
con 100 USD y 40 cambios de 5 USD a la vez se aprueban los 40 y la cuenta queda en -100.

La reserva descuenta el monto en el mismo paso que el chequeo, antes del primer `await`, y lo
devuelve si falla alguna transferencia. Node no interrumpe codigo sincronico, asi que ningun otro
cambio puede leer el saldo en el medio. El costo es que, si el saldo no alcanza para todos, el
orden de llegada decide quien se aprueba.

## Como verlo

`app/test/exchange-fund-reservation.test.js` dispara los 40 cambios contra 100 USD:

```
cd app && npm test
```

Con la reserva pasan los dos tests. Con el `exchange.js` del codigo recibido
(`git checkout 1068ed5 -- app/exchange.js`), el primero falla porque se aprueban 40.

## Como medirlo

El escenario `exchange-integridad-carrera.yaml` deja la cuenta USD en 100, fija 5000 ARS = 5 USD
y manda 40 cambios en el mismo segundo. Desde `perf/`, en el caso base y en esta rama:

```
curl -s http://localhost:5555/accounts
bash correr-breakpoint-linux.sh -e exchange-integridad-carrera -n carrera
curl -s http://localhost:5555/accounts
```

Lo que importa es el saldo final de la cuenta 2: -100 en el caso base y 0 con la reserva, con 20
cambios aprobados y 20 rechazados. La rafaga dura 1 s, menos que la ventana de 10 s del
dashboard, asi que el detalle se lee en `reporte-artillery.json` y no en Grafana.
