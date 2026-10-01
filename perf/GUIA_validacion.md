# Guia, validacion de entrada y manejo de errores

En el codigo recibido, un pedido con una moneda que no existe hace tirar un TypeError dentro de
un handler async. Express 4 no lo atrapa, Node termina el proceso y la api queda caida para
todos: el pedido recibe 502 de nginx y los siguientes tambien, porque no hay restart.

La tactica valida la entrada de `POST /exchange`, `PUT /rates` y `PUT /accounts/:id/balance`
en `app/app.js`, antes de llegar al dominio, y responde 400 con el campo que falla (404 si la
cuenta no existe). Los errores que pasen la validacion van a un middleware que responde 500 sin
tirar el proceso. La falta de fondos responde 422 en lugar de 500, porque es un rechazo del
negocio y no una falla de la api.

## Como verlo

Con la api levantada (`docker compose up -d --build`):

```
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:5555/exchange \
  -H 'content-type: application/json' \
  -d '{"baseCurrency":"GBP","counterCurrency":"ARS","baseAmount":100,"baseAccountId":1,"counterAccountId":2}'
```

Con el codigo recibido el curl no responde y `docker ps` ya no muestra `exchange-api-1`. Con
la tactica responde 400 y la api sigue arriba.

## Como medirlo

El escenario `exchange-availability-validacion.yaml` mezcla cambios validos con un 10 % de
pedidos con moneda inexistente. Se corre igual que el breakpoint, antes (codigo recibido) y
despues (esta rama):

```
bash correr-breakpoint-linux.sh -e exchange-availability-validacion -n validacion_antes
bash correr-breakpoint-linux.sh -e exchange-availability-validacion -n validacion_despues
python analizar-availability.py resultados/<carpeta>
```

Un 400 cuenta como pedido atendido. Antes, el % atendido cae a casi 0 desde el primer pedido
malformado y no vuelve. Despues tiene que quedar cerca de 100 %.
