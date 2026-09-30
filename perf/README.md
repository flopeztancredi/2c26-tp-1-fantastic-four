# perf/ — pruebas de carga de arVault

## Contenido

| Archivo | Para qué sirve |
|---|---|
| `exchange-availability-breakpoint.yaml` | Corrida 1, breakpoint: escalones de 160 a 640 req/s para encontrar el boundary B |
| `exchange-availability-stress.yaml` | Corrida 2, stress + recuperación con B = 320 |
| `exchange-availability-stress-b450.yaml` | Corrida 2, variante con B = 450 como hipótesis |
| `exchange-availability-spike.yaml` | Corrida cambiaria: pico corto a 2B, todos comprando dólares |
| `exchange-availability-calentamiento.yaml` | Calentamiento común de la suite (no se analiza) |
| `exchange-performance-representativa.yaml` | Cliente representativo, llegada constante, mezcla de pares y montos |
| `correr-breakpoint-docker.ps1` | Corre cualquiera de los YAML en **Windows** |
| `correr-breakpoint-linux.sh` | Corre cualquiera de los YAML en **Linux** |
| `correr-suite-linux.sh` | Corre una lista de escenarios, cada uno varias veces, y llama a la captura al final |
| `capturar-grafana.mjs` | Guarda un PNG por panel del dashboard para una corrida ya hecha |
| `analizar-availability.py` | Tablas por ventana y por fase, B, t_rec y OOM de una corrida |
| `dashboard.json` | Dashboard de Grafana para mirar la corrida en vivo |
| `DISENO_availability.md` | Qué se quiere probar y por qué las pruebas están armadas así: métricas, umbrales, P95 y fases |
| `GUIA_breakpoint.md`, `GUIA_stress-recuperacion.md` | Cómo correr cada corrida, qué mirar y qué informar |
| `GUIA_suite.md` | Procedimiento completo para correr la suite en una rama y comparar contra otras |
| `package.json`, `package-lock.json` | artillery 2.0.22, el plugin de statsd y puppeteer-core, con versiones fijas |
| `rates.yaml`, `run-scenario.sh` | Ejemplo original del enunciado |

## Requisitos

- **Windows:** Docker Desktop y PowerShell 5.1 o posterior. No hace falta Node.
- **Linux:** Docker Engine con `docker compose` v2 (sin `sudo`), Node 24, `curl` y `vmstat`.
- **Ambos:** Python 3.12 o posterior, para el análisis.

El sistema bajo prueba es el `docker-compose.yml` de la raíz, sin cambios: api (1 CPU, 512 MiB), nginx (0,5 CPU, 128 MiB), graphite, grafana y cadvisor. El `.env` de la raíz define el nombre del proyecto (`exchange`). Por eso los containers se llaman `exchange-api-1`, `exchange-nginx-1`, etc., que es lo que esperan nginx y los scripts.

## Qué hacen los scripts

Los dos siguen los mismos pasos y dejan todo en `resultados/<fecha>_<nombre>/`:

1. Levantan el sistema, verifican que haya una sola réplica de la api y **resetean la api**: recrean su container, así que vuelven los saldos iniciales y el log queda vacío.
2. Registran los eventos de los containers api y nginx (`die`, `oom`, `restart`) y los sockets del cliente cada 5 s.
3. Corren artillery con el YAML elegido.
4. Guardan:
   - saldos antes y después;
   - estado final de la api;
   - logs de nginx y api;
   - CPU y memoria (cadvisor) y métricas de artillery, exportadas desde graphite;
   - una copia del YAML usado y el entorno (`entorno.txt`).

| | Windows | Linux |
|---|---|---|
| Comando | `.\correr-breakpoint-docker.ps1 [-Escenario <yaml sin extensión>] [-Nombre <carpeta>]` | `bash correr-breakpoint-linux.sh [-e <yaml sin extensión>] [-n <carpeta>]` |
| Dónde corre artillery | En un container `node:24` dentro de la red de compose | En el host |
| Entorno del YAML | `docker` (target `http://nginx`) | `api` (target `http://localhost:5555`) |
| Prefijo en Grafana (`server`) | `artillery-exchange-<escenario>-docker` | `artillery-exchange-<escenario>` |

Sin parámetros, los dos scripts corren el breakpoint.

## Por qué artillery corre dentro de la red de Docker en Windows

- Cada usuario virtual abre una conexión TCP nueva y la cierra, y el puerto local queda un tiempo en TIME_WAIT. Con artillery en el host Windows, el generador se quedó sin puertos efímeros alrededor de los 320 req/s. El B medido (160 req/s) resultó ser **el límite del cliente, no del sistema** (`resultados/2026-09-25_breakpoint_artillery-en-windows/`).
- Por eso, en Windows, artillery corre como un container más de la red `exchange_default` y le pega directo a `http://nginx`. Esto tiene tres ventajas:
  - **La red del cliente se ajusta solo dentro de ese container**, sin tocar el host. Con `--sysctl`: 64.512 puertos efímeros, reuso de TIME_WAIT y un tope de 2.000 sockets en TIME_WAIT. El tope (`-MaxTimeWait`) se agregó porque, en la primera versión, el cliente volvía a quedarse sin puertos a 640 req/s (`EADDRNOTAVAIL` en `resultados/2026-09-26_breakpoint_artillery-en-docker/`).
  - **Se evita el port-forwarding de Docker Desktop** entre Windows y la VM.
  - **cadvisor mide también el consumo del generador** (container `artillery`).
- **Costo:** el generador comparte la VM con el sistema. Si la VM se cuelga, también se cuelga el que mide.
- En Linux los valores de red por defecto alcanzan, así que artillery corre en el host.
- Para confirmar que el límite no fue el cliente, en ninguna corrida tiene que aparecer `EADDRNOTAVAIL` ni `EADDRINUSE`.

## Replicar las corridas

Desde `perf/`, con el host enchufado, sin aplicaciones pesadas y con Grafana configurado (ver `GUIA_breakpoint.md`, "Antes de correr"):

| Corrida | Windows | Linux |
|---|---|---|
| Breakpoint | `.\correr-breakpoint-docker.ps1 -Nombre breakpoint_windows` | `bash correr-breakpoint-linux.sh -n breakpoint_linux` |
| Stress, B = 320 | `.\correr-breakpoint-docker.ps1 -Escenario exchange-availability-stress -Nombre stress_windows` | `bash correr-breakpoint-linux.sh -e exchange-availability-stress -n stress_linux` |
| Stress, B = 450 | `.\correr-breakpoint-docker.ps1 -Escenario exchange-availability-stress-b450 -Nombre stress_b450_windows` | `bash correr-breakpoint-linux.sh -e exchange-availability-stress-b450 -n stress_b450_linux` |

- **B depende del entorno.** Antes de correr el stress en otra máquina, correr el breakpoint en esa misma máquina y ajustar los `arrivalRate` del YAML de stress (ver `GUIA_stress-recuperacion.md`).
- **Duración:** unos 8 min el breakpoint y unos 6 a 7 min cada stress. En Windows se suman 1 o 2 min de `npm ci`.

## Correr la suite completa (Linux)

Para comparar ramas hay que correr los mismos escenarios, la misma cantidad de veces, en cada
una. Eso lo automatiza `correr-suite-linux.sh`: por cada escenario y cada corrida, recrea la api
con el estado inicial, calienta (`exchange-availability-calentamiento.yaml`, no se analiza),
espera una quietud para que los paneles bajen a la línea de base, corre
`correr-breakpoint-linux.sh` y al final captura el dashboard con `capturar-grafana.mjs`.
Procedimiento completo, con qué revisar antes de medir y cómo comparar ramas:
**`GUIA_suite.md`**.

```sh
bash correr-suite-linux.sh exchange-availability-breakpoint exchange-availability-spike
```

Antes de una corrida real, conviene revisar la secuencia sin tocar Docker:

```sh
SECO=1 bash correr-suite-linux.sh exchange-availability-breakpoint
```

## Capturar el dashboard

`capturar-grafana.mjs` guarda un PNG por panel del dashboard (rango: `inicio.txt`/`fin.txt` de la
corrida, con 30 s de margen) en `<carpeta>/capturas/`. La suite ya la llama al final de cada
corrida; para una carpeta vieja o para probarla contra Grafana:

```sh
node capturar-grafana.mjs resultados/<carpeta>
```

## Analizar

```
python analizar-availability.py resultados/<carpeta>
```

- En un **breakpoint** muestra el % de éxito, el throughput 2xx y el P95 por escalón, y el B.
- En un **stress** muestra lo mismo por fase y agrega t_rec.
- En ambos casos muestra la primera ventana que falla y el OOM, cada uno con los exchanges acumulados hasta ese momento.

Para comparar con los resultados de este repo, ver `resultados/CONCLUSIONES_availability.md`.

## Resultados

| Carpeta | Qué se midió |
|---|---|
| `resultados/2026-09-23_scalability/` | Scalability del caso base |
| `resultados/2026-09-25_breakpoint_artillery-en-windows/` | Breakpoint con artillery en el host Windows: limitado por el cliente |
| `resultados/2026-09-26_breakpoint_artillery-en-docker/` | Breakpoint con artillery en Docker, primera versión: B ≥ 320. A 640 req/s el cliente se queda sin puertos |
| `resultados/2026-09-26_breakpoint_windows/` | Breakpoint con el script: **B = 320** |
| `resultados/2026-09-26_stress_windows/` | Stress con B = 320 |
| `resultados/2026-09-27_stress_b450_windows/` | Stress con B = 450 |

- **Conclusiones de availability:** `resultados/CONCLUSIONES_availability.md`. Cada carpeta tiene además su `RESULTADOS_*.md`.
- **Los logs de nginx (`nginx-*.log`) no están en el repo por su tamaño**: hasta unos 20 MB por corrida. Los scripts los generan igual, y los conteos que se usaron están en los `RESULTADOS_*.md`.
