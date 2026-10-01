# Guía: métricas de negocio (volumen y neto por moneda)

Punto obligatorio del enunciado: el volumen operado en cada moneda (compras y ventas sumadas) y el neto (compras suman, ventas restan), a lo largo del tiempo. Esta guía dice cómo verificar la implementación y qué evidencia sale para el informe.

## Qué se implementó

- **Punto de vista de arVault.** En un cambio exitoso arVault *compra* la moneda que entrega el cliente (`baseCurrency`, por `baseAmount`) y *vende* la que pide (`counterCurrency`, por `counterAmount`). El neto de una moneda es igual al cambio de saldo de la cuenta de arVault en esa moneda.
- **Ports and adapters en el borde de métricas.** El dominio (`app/exchange.js`) solo avisa `exchangeCompleted` o `exchangeRejected` a un puerto (`app/metrics/metrics.js`). No conoce StatsD. Adaptadores: StatsD (`app/metrics/statsd-adapter.js`, con hot-shots) y nulo (`app/metrics/null-adapter.js`). `app/app.js` elige el adaptador por la variable `METRICS_ADAPTER`.
- **Hechos, no derivadas.** La api envía contadores de StatsD por UDP: `arvault.exchange.compras.<MONEDA>`, `ventas.<MONEDA>`, `operaciones.ok` y `operaciones.rechazadas`. Volumen y neto se calculan en Grafana (fila "Negocio" del dashboard).
- **Configuración.** StatsD envía cada 10 s (antes 1 s, la causa del subconteo de A.11) y no borra los contadores sin tráfico. Graphite vuelve a la retención por defecto de la imagen (6 h a 10 s, 6 días a 1 min, 1800 días a 10 min). StatsD escucha solo en 127.0.0.1 hacia afuera del compose.
- **Si StatsD no responde**, el adaptador deja de enviar durante 10 s, lo deja en el log de la api y reintenta. El cambio nunca espera ni falla por las métricas.

## Antes de correr

La retención nueva solo se aplica a series nuevas, y Graphite guarda las series en un volumen anónimo que compose reusa. Hay que borrarlo una vez (se pierden las métricas guardadas hasta ahora):

```bash
docker compose rm -fsv graphite
docker compose up -d --build
```

Tests del código (no necesitan Docker): `cd app && npm ci && npm test`.

## Criterios y cómo se verifican

| CA | Qué | Cómo |
|---|---|---|
| CA1 a CA4 | Traducción a hechos, dominio con el adaptador de prueba, paquetes UDP exactos, sin ids de cuenta ni de operación | `npm test` en `app/` |
| CA5 | Signo del neto y monedas sin tráfico en 0 | `exchange-metricas-un-sentido`: en Grafana, neto de ARS positivo, de USD negativo, EUR y BRL en 0 |
| CA6, CA8 | Graphite concilia con el log y con los saldos | Endurance con `conciliar-metricas.py` (abajo) |
| CA7 | Rechazadas en Graphite = `ok: false` en el log | `exchange-metricas-rechazos` con `conciliar-metricas.py` |
| CA9 | Ya no se pierden contadores (A.11) | Abajo |
| CA10 | El costo de emitir no se nota | Endurance con `METRICS_ADAPTER=statsd` y con `null`: P95 a igual N dentro de ±10 % y CPU por request |
| CA11 | Con StatsD caído el servicio sigue igual | Durante una corrida: `docker compose stop graphite`, esperar 1 min, `docker compose start graphite`. El P95 no cambia y el log de la api muestra la pausa |
| CA12 | Dashboard | Captura de la fila "Negocio" durante la corrida de CA6 |

### Conciliación (CA6, CA7, CA8)

El script de corrida recrea la api con el estado inicial de la imagen, así que la foto se saca sobre una api recién recreada (mismos saldos) y sin carga durante al menos 10 s:

```bash
docker compose -f ../docker-compose.yml up -d --build --force-recreate api
python conciliar-metricas.py foto antes.json
.\correr-breakpoint-docker.ps1 -Escenario exchange-performance-endurance -Nombre endurance160_metricas
python conciliar-metricas.py conciliar antes.json
```

`conciliar` espera 20 s desde el último cambio (un envío de StatsD más margen) e imprime tres tablas. La cantidad de operaciones tiene que coincidir exacta: una diferencia es pérdida de UDP y se informa como tal. Los montos se comparan con tolerancia relativa 1e-9 (punto flotante). No usar `PUT /accounts/:id/balance` durante la corrida: cambia saldos por fuera del log y rompe CA8. CA8 muestra que métricas y saldos salen del mismo evento, no que no haya condición de carrera.

### CA9: repetición de A.11

```bash
for i in $(seq 599); do echo "prueba.a11:1|c" > /dev/udp/127.0.0.1/8125; sleep 0.1; done
sleep 20
curl "http://localhost:8090/render?target=stats_counts.prueba.a11&from=-3min&format=json"
```

La suma de los puntos tiene que dar 599 (antes daba 69).

### CA10: con y sin métricas

```bash
METRICS_ADAPTER=null docker compose up -d --force-recreate api
```

y correr el mismo endurance. En PowerShell: `$env:METRICS_ADAPTER="null"` antes del script, y `Remove-Item Env:METRICS_ADAPTER` después.

## Riesgos que quedan documentados

- Grafana (puerto 80) y graphite-web (8090) se leen sin autenticación, y ahora muestran volúmenes de negocio.
- La métrica sale cuando el cambio termina, antes de que el log llegue a disco. Si la api se cae en ese intervalo, las métricas quedan por encima de lo persistido.
- Un datagrama UDP perdido es un cambio sin contar: se detecta con la cantidad de operaciones.
