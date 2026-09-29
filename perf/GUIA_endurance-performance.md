# Guía — Performance: endurance a carga constante

Test de **Performance** (y de su subítem **Efficiency**). Sigue los 7 pasos de la guía del equipo. Reusa el escenario, el script de Windows y el análisis de las corridas de availability; lo que no se repite acá está en `GUIA_breakpoint.md`, "Antes de correr".

**Regla del equipo:** todo percentil que se informe (mediana, P95, P99, máx) va con el **% de éxito de la misma ventana**. Los requests cortados por timeout no tienen response time y no entran en el percentil, así que un P95 sin tasa de éxito puede engañar.

## Qué se quiere demostrar

Según la clase, performance es la *habilidad del sistema para reaccionar ante ciertos eventos en un determinado tiempo*. Acá los eventos son pedidos de usuario (`POST /exchange`).

La idea del equipo: **el response time no depende solo de la carga (req/s) sino de la degradación acumulada**. Con la tasa fija, el tiempo de respuesta empeora a medida que la api acumula exchanges. La variable que se analiza es **N = exchanges acumulados**, no el tiempo.

**Por qué pasa (evidencia en el código, antes de la táctica):**

- `app/exchange.js`: cada exchange hace `log.push`. El log vive en memoria y nunca se achica.
- `app/state.js`: cada 1 s serializa el log **entero** (`JSON.stringify` + `writeFile`). `JSON.stringify` es sincrónico y bloquea el event loop de Node (un solo hilo) durante un tiempo que crece con N. Los requests que llegan mientras tanto esperan.
- En términos de la clase: **demanda de recursos** (el consumo por evento crece) y **bloqueo** por disputa de un recurso compartido (el event loop).

## Hipótesis

| | Hipótesis | Cómo se ve si se cumple |
|---|---|---|
| **H1** | Con la tasa constante, P95, P99 y máx crecen con N; la mediana empieza a crecer después | Curvas crecientes con ≈ 100 % de éxito |
| **H2** | La degradación depende de N y no solo de la tasa: a 320 req/s la curva también crece con N | Comparar P95 a igual N entre 160 y 320 req/s |
| **H3** | La CPU y la memoria por request crecen con N: baja la eficiencia | Paneles "Efficiency" del dashboard |
| **H0** (nula) | El P95 se mantiene dentro de ±10 % de su línea base | Curva plana. Es lo esperado **después** de aplicar una táctica sobre el log |

## 1. Entorno

Igual que las corridas de availability (`resultados/*/entorno.txt`): Windows, Docker Desktop (WSL2), artillery en Docker dentro de la red de compose, api con 1 CPU y 512 MiB, nginx con 0,5 CPU y 128 MiB, 1 réplica. El script registra el entorno en `entorno.txt`.

## 2. Criterios de aceptación

- **Línea base P95₀:** mediana de los P95 de las ventanas con N entre ~3.000 y ~10.000. Coincide con el piso que ponen las dos `transfer()` seguidas de 200–400 ms del código.
- **Tramo analizado:** desde el inicio hasta la primera ventana con éxito < 99 % (con N > 5.000) o el OOM, lo que pase primero.
- **H1 se cumple** si hay al menos 3 ventanas seguidas con P95 > 1,10 · P95₀ y la tendencia es creciente (P95 en N ≈ 40.000 > P95 en N ≈ 20.000 > P95₀).
- **H0 se mantiene** si todas las ventanas del tramo quedan dentro de ±10 % de P95₀.

## 3. Diseño

| | Corrida principal | Corrida de contraste |
|---|---|---|
| YAML | `exchange-performance-endurance.yaml` | `exchange-performance-endurance-320.yaml` |
| Carga | 160 req/s constante | 320 req/s constante |
| Duración | 10 min | 3 min |
| Prefijo en Grafana | `artillery-exchange-endurance-docker` | `artillery-exchange-endurance-320-docker` |

- **Mismo escenario que el breakpoint y los stress:** un `POST /exchange` por usuario virtual, alternando ARS→USD y USD→ARS con montos chicos. Los saldos alcanzan para ~470.000 exchanges, así que no aparece "Not enough funds", que respondería más rápido y falsearía la latencia.
- **Sin calentamiento aparte:** la línea base sale de las primeras ventanas. Arrancar con otra tasa sumaría N.
- **160 req/s durante 10 min** cubre la degradación esperada según los umbrales de availability. **320 req/s durante 3 min** es la tasa B del breakpoint y llega a un rango de N parecido.
- **Métricas por ventana de 10 s:** N, % de éxito, mediana, P95, P99, máx, 2xx/s, CPU y memoria de la api.
- **N** = suma de 2xx de artillery hasta esa ventana. Alcanza porque la api arranca con `log = []` y cada exchange agrega una entrada. Deja de valer cuando aparecen timeouts, que es donde se corta el análisis. No se usa `GET /log` para contar, porque serializa todo y perturba la medición.

## 4. Preparar y 5. Artefactos

- Host en las mismas condiciones que en availability, una sola réplica de la api y Grafana con el datasource `Graphite`.
- La api tiene que arrancar con el log vacío. El Dockerfile copia `app/state` dentro de la imagen, así que un `docker restart` no resetea: el script recrea el container.
- Artefactos: los dos YAML de esta carpeta, `correr-breakpoint-docker.ps1` (mismo script de availability, con una línea cambiada para aceptar escenarios `exchange-performance-*`) y `dashboard.json` con la fila nueva "Performance vs N": tiempo de respuesta vs N (mediana, P95, P99, máx y % de éxito), CPU y memoria de la api vs N, y N acumulado vs tiempo.

## 6. Correr

Desde `perf/`, en Windows:

```powershell
.\correr-breakpoint-docker.ps1 -Escenario exchange-performance-endurance -Nombre endurance160_windows
.\correr-breakpoint-docker.ps1 -Escenario exchange-performance-endurance-320 -Nombre endurance320_windows
```

Cada corrida resetea la api antes de empezar. Duran unos 12 y 5 min con el `npm ci`. Si la api muere por OOM, no reiniciarla: es un resultado. En Grafana, `server` = el prefijo de la tabla y el rango = "desde/hasta" que imprime el script.

## 7. Analizar e informar

```powershell
python analizar-availability.py resultados/<fecha>_endurance160_windows
python analizar-availability.py resultados/<fecha>_endurance320_windows
```

Da la tabla por ventana con `2xx acum.` (= N), la primera ventana < 99 % y el OOM si lo hubo. La línea "B" no aplica a este test. P99 y máx salen de Grafana o de `reporte-artillery.json`.

**Qué informar:**

1. Tabla de performance vs N (160 req/s) por tramos de N, con % de éxito, mediana, P95, P99, máx, 2xx/s, CPU y memoria en cada fila.
2. Veredicto de H1 contra el criterio del paso 2, y en qué N la cola se separa de la mediana.
3. H2: P95 y factor P95/P95₀ de las dos tasas a igual N.
4. Efficiency (H3): req/s por core = 2xx/s ÷ (CPU / 100), al inicio y en el corte; y la pendiente de memoria en MiB cada 1.000 exchanges.
5. Limitación: los `ETIMEDOUT` no tienen response time, así que cuando aparecen el P95 de los 2xx subestima la latencia.

## Resultados obtenidos (código previo a la táctica)

| | 160 req/s, corrida 1 | 160 req/s, corrida 2 | 320 req/s |
|---|---|---|---|
| P95₀ | 743 ms | 743 ms | 758 ms |
| P95 al final del tramo (factor sobre P95₀) | 1.620 ms en N = 70.093 (2,18) | 2.671 ms en N = 94.954 (3,59) | 1.620 ms en N ≈ 51.000 (2,14) |
| Cola separada de la mediana | N ≈ 22.000 | N ≈ 17.000–20.000 | N ≈ 10.000–13.000 |
| OOM | No | No | No |

- **H1 se cumple** en las tres corridas y H0 no se mantiene. **H3 se cumple:** con 160 req/s, los req/s por core caen de ~760 a ~220 entre N = 0 y N = 70.000.
- **H2 se cumple con un matiz:** la curva crece con N a las dos tasas, pero a igual N el factor es mayor a 320 req/s (1,93 contra 1,20–1,52 en N ≈ 40.000). N y tasa se potencian.
- **Desvío:** no hubo OOM en 10 min, aunque la memoria llegó a 511 MiB unos segundos en la corrida 1. Con `MemorySwap` de 1 GiB el container puede usar swap, y cadvisor no lo mide.
- Datos completos en `resultados/2026-09-27_endurance160_windows*/` y `resultados/2026-09-28_endurance320_windows/`, cada una con su `RESULTADOS_endurance.md`.

## Tácticas para evaluar

Todas atacan la causa que el test pone en evidencia. Para evaluarlas se aplica la táctica, se verifica el reset y se vuelve a correr exactamente el mismo YAML, comparando con la base a igual N.

| # | Táctica | Categoría (clase) | Qué se espera en este test |
|---|---|---|---|
| T1 | Persistir el log en modo append (**implementada** en `fix/perfomance-append`) | Performance: reducir el consumo de recursos | P95 y CPU vs N planos (H0). La memoria sigue creciendo |
| T2 | Acotar o rotar el log en memoria | Performance: reducir el consumo de recursos | Memoria vs N plana, sin OOM |
| T3 | Serializar sin bloquear el event loop | Performance: gestión de recursos (concurrencia) | P95 más plano, CPU total sigue creciendo |
| T4 | Guardar con menos frecuencia | Performance: reducir la cantidad de eventos | Picos más espaciados pero más largos |
| T5 | Externalizar el estado a una base | Performance y Scalability | P95 y memoria planos, más latencia de red |
| T6 | Reinicio preventivo y `restart: unless-stopped` | Availability | Ataca el síntoma, no la causa |

**Trade-off de T1:** gana performance (el costo por request pasa de O(N) a O(1)) y pierde durabilidad e integridad del log (una caída puede dejar una línea truncada y el append sin `await` puede perder las últimas entradas). Además cambia el formato (JSON Lines), el archivo crece sin límite y no se ordenan las escrituras concurrentes.
