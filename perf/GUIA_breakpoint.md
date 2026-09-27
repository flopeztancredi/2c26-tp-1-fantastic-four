# Guía — Corrida 1: breakpoint de availability

Los fundamentos del diseño (qué se mide y por qué) están en `DISENO_availability.md`.

## Objetivo

- **Nivel 0:** hasta qué carga el sistema atiende bien. Da el **boundary B**: el arrivalRate del último escalón con % de éxito ≥ 99 %.
- **Nivel 2:** separar "no responde" de "responde lento" (P95 por escalón).
- **Nivel 3:** qué tipo de falla aparece (timing, omission, crash o response) y qué recurso llega a su límite.

**Criterio:** % de éxito por escalón = 2xx / (todas las respuestas HTTP + errores de red), con umbral de 99 %. El P95 se informa aparte, sin umbral. **B vale solo para el entorno donde se midió**: Windows y Linux tienen cada uno el suyo.

## Carga (`exchange-availability-breakpoint.yaml`)

| Fase | Carga | Duración |
|---|---|---|
| Calentamiento (no se analiza) | 80 req/s | 30 s |
| Escalones | 160, 240, 320, 400, 480, 560 y 640 req/s | 60 s cada uno |

- Cada usuario virtual hace un solo `POST /exchange`, así que arrivalRate ≈ req/s.
- Los requests alternan ARS→USD y USD→ARS con montos chicos, para que los saldos no se agoten. Un saldo insuficiente daría HTTP 500 por regla de negocio, no por falta de disponibilidad.
- El timeout es de 10 s. Un request más lento se corta y cuenta como `ETIMEDOUT`.
- La carga dura 7,5 min. En Windows se suman 1 o 2 min de `npm ci`.

## Antes de correr

1. **Host en las mismas condiciones en cada corrida:** notebook enchufada y en alto rendimiento, sin aplicaciones pesadas abiertas y sin otra corrida en curso. Si quedó un container colgado, borrarlo con `docker rm -f artillery`.
2. **Una sola réplica de la api.** `docker compose -f ../docker-compose.yml ps` no tiene que mostrar `exchange-api-2`. Si aparece, correr `docker compose -f ../docker-compose.yml up -d --scale api=1`. El script también lo verifica.
3. **Grafana** (`http://localhost`, `admin`/`admin`), la primera vez:
   - crear un datasource Graphite llamado exactamente `Graphite`, con URL `http://graphite:80`;
   - importar `perf/dashboard.json`.
   - En cada corrida, elegir en `server` el prefijo del entorno y en `container` `exchange-api-1` y `exchange-nginx-1` (en Windows, también `artillery`).

## Correr

Desde `perf/`:

| Entorno | Comando | Prefijo en Grafana |
|---|---|---|
| Windows | `.\correr-breakpoint-docker.ps1 -Nombre breakpoint_windows` | `artillery-exchange-breakpoint-docker` |
| Linux | `bash correr-breakpoint-linux.sh -n breakpoint_linux` | `artillery-exchange-breakpoint` |

- El script resetea la api antes de empezar: recrea el container, así que vuelven los saldos originales y el log queda vacío.
- Si la corrida se repite en el mismo día, usar otro nombre, por ejemplo `breakpoint_windows_2`: el script no pisa una carpeta que ya existe.

## Durante la corrida

- **Qué mirar en Grafana:**
  - % de éxito por ventana, contra la línea de 99 %;
  - carga ofrecida contra throughput 2xx: donde se separan, se alcanzó la capacity;
  - CPU y memoria contra el límite (api: 1 CPU y 512 MiB; nginx: 0,5 CPU y 128 MiB).
- Anotar la hora de cualquier cosa rara: el primer error, un salto de latencia, un container que desaparece.
- **Si la api muere:** no reiniciarla. Dejar que la corrida termine: el crash es un resultado.
- **Si artillery deja de imprimir reportes durante más de 60 s:** el sistema se colgó.
  1. Guardar la salida de `docker stats --no-stream` y `docker inspect` en `estado-durante-cuelgue.txt`, con la hora.
  2. Esperar hasta 5 min y anotar si vuelve.
  3. Cortar el generador: en Windows con `docker rm -f artillery` (el script sigue con la recolección); en Linux con `Ctrl+C`.

## Analizar

```
python analizar-availability.py resultados/<fecha>_breakpoint_<entorno>
```

El script da la tabla por ventana y por escalón (descartando la primera ventana de cada escalón), B, la primera ventana que falla y, si lo hubo, el OOM.

**Qué informar:**

| Resultado | Qué es |
|---|---|
| B | Último escalón con ≥ 99 % |
| Punto de ruptura | Primer escalón con menos de 99 % |
| Capacity | Mayor throughput 2xx sostenido en un escalón |
| P95 del escalón B | Referencia para la corrida 2 |
| Recurso limitante | CPU o memoria que llega a su límite |
| Tipo de falla | Timing (P95 alto, `ETIMEDOUT`), omission (`ECONNRESET`, sin respuesta), crash (`oom` o `die` en `eventos-containers.txt`, 502) o response (500) |
| Estado final de la api | `estado-api-despues.txt` |

**Casos especiales:**

- **`EADDRNOTAVAIL` o `EADDRINUSE`:** el límite de ese escalón fue el cliente, no el sistema, y esos escalones no cuentan para B. En Linux, aplicar en el host los valores de `--sysctl` del script de Windows y repetir la corrida.
- **HTTP 500:** comparar `cuentas-antes.json` con `cuentas-despues.json` para descartar "Not enough funds".
- **No hay ruptura ni a 640 req/s:** B queda indefinido y hay que agregar escalones más altos.

**Reproducibilidad:** hacer al menos 2 corridas por entorno, con reset entre una y otra. Si B difiere, informar el rango.

## Siguiente paso

Con el B de este entorno, calcular los valores de la corrida 2 (`GUIA_stress-recuperacion.md`): 0,5·B / 1,5·B / 0,5·B / B.
