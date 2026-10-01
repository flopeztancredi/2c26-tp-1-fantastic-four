# Guia, Idempotency-Key en POST /exchange

En el codigo recibido, si el cliente no recibe la respuesta de un `POST /exchange` (timeout,
corte de red, 502 o 504) y lo vuelve a mandar, el cambio se ejecuta dos veces: dos entradas en
el log y el doble de movimiento de saldos. El cliente no tiene forma de saber si el primero se
hizo.

La rama agrega `app/idempotency.js`, un middleware para el encabezado `Idempotency-Key`:

- Sin encabezado, el pedido corre como siempre: la app tercerizada no esta obligada a mandarlo.
- Misma clave y mismo cuerpo: devuelve la respuesta guardada sin volver a ejecutar el cambio.
- Misma clave y el primer pedido todavia en curso: 409.
- Misma clave con otro cuerpo: 422.
- Clave de mas de 255 caracteres: 400.

Las claves viven en memoria, 24 h desde la respuesta y hasta 30.000 (se descarta la mas vieja).
Cada una pesa unos 1,4 KB, asi que el tope son unos 42 MB de los 512 MiB de la api.

Limites: un reinicio de la api vacia el almacen, y con varias replicas cada una tiene el suyo.
Las dos cosas se resuelven guardando las claves en Redis, que es lo que hace el integrado.

## Como medirlo

El escenario `exchange-integridad-reintentos.yaml` manda cada cambio dos veces con la misma
clave: 75 usuarios virtuales de calentamiento y 1.200 en la fase principal, 1.275 en total. Sin
la tactica el log suma 2.550 entradas; con la tactica, 1.275. Se corre igual en el caso base y
en esta rama, desde `perf/` y con la api recien creada:

```
docker compose -f ../docker-compose.yml up -d --build --force-recreate api
curl -s http://localhost:5555/log | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
npx artillery run exchange-integridad-reintentos.yaml -e api --output reporte.json
curl -s http://localhost:5555/log | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
```

En Grafana el prefijo es `artillery-exchange-reintentos`. En esta rama no deberia aparecer
ningun 409 ni 422, porque cada usuario virtual espera la primera respuesta antes de reintentar.
