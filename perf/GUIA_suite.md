# Guía: suite completa (comparar ramas)

Cómo correr la misma batería de escenarios en una rama para compararla contra el caso base y
contra las demás ramas con táctica. El diseño de cada escenario individual está en
`DISENO_availability.md` y en la guía de cada corrida (`GUIA_breakpoint.md`,
`GUIA_stress-recuperacion.md`, `GUIA_endurance-performance.md`); esta guía es sobre la mecánica de
correr todo junto y comparar.

## Por qué una suite y no corridas sueltas

El grupo mide el caso base y cada táctica con los mismos escenarios, para que la comparación entre
ramas sea válida. Correr cada corrida a mano, una por una, es fácil de hacer distinto entre ramas
(otro orden, no queda enfriamiento entre corridas, se pisan los nombres de carpeta).
`correr-suite-linux.sh` fija ese procedimiento en un script: mismos pasos, mismo orden, mismas R
repeticiones.

## 1. Preparar (antes de una corrida que se vaya a comparar)

- **Enchufada, no a batería.** El script aborta solo si no lo está (`FORZAR=1` para saltear).
- **Perfil de energía y governor en rendimiento**, si la máquina lo permite
  (`powerprofilesctl set performance`). El script no lo fuerza, solo lo registra en
  `entorno.txt`: revisarlo a mano antes de una corrida que se vaya a comparar contra otra.
- **Sin otras cargas.** Cerrar lo que use CPU o red: otro navegador con muchas pestañas, un build,
  otra corrida de artillery. `/tmp/arvault-midiendo.lock` existe mientras la suite corre, para que
  dos corridas con este script no se pisen.
- **Grafana con el dashboard importado** (`dashboard.json`) y el datasource `Graphite` (ver
  `GUIA_breakpoint.md`, "Antes de correr").
- **`npm ci`**, o dejar que lo haga solo `correr-breakpoint-linux.sh` en cada corrida.

## 2. Correr la suite

Desde `perf/`:

```sh
bash correr-suite-linux.sh <escenario1> [escenario2 ...]
```

Cada `<escenario>` es un YAML sin la extensión, por ejemplo `exchange-availability-breakpoint`.
Por cada uno, por defecto 3 veces: enfría (`QUIETUD` segundos, para que los paneles bajen a la
línea de base de la corrida anterior antes de resetear) y corre el escenario medido
(`correr-breakpoint-linux.sh`, que hace su propio reset de la api, réplicas, redis si corresponde
y el calentamiento embebido de cada escenario), y captura el dashboard. No hay un calentamiento
aparte de la suite: cada escenario trae el suyo si lo necesita (ver la primera fase de
`exchange-availability-breakpoint.yaml`, por ejemplo).

Opciones por variable de entorno:

| Variable | Qué hace | Default |
|---|---|---|
| `REPETICIONES` | Corridas por escenario | 3 |
| `QUIETUD` | Segundos de enfriamiento antes de resetear la api, para bajar a la línea de base | 60 |
| `API_REPLICAS` | Réplicas de la api (lo aplica y lo verifica `correr-breakpoint-linux.sh`) | 1 |
| `FALLA` | `kill`, `stop` o `crash`: induce una falla de `exchange-api-1` durante la corrida medida | (ninguna) |
| `FALLA_A` | Segundos desde el inicio de la corrida medida para la falla (obligatorio con `FALLA`) | (ninguno) |
| `FORZAR` | Corre igual si la máquina está a batería | 0 |
| `POWER_SUPPLY_DIR` | Directorio con el estado de alimentación (para probar el chequeo sin hardware real) | `/sys/class/power_supply` |
| `SECO` | Imprime los comandos en vez de correrlos | 0 |

- **`API_REPLICAS` lo maneja `correr-breakpoint-linux.sh`.** La suite solo lo valida y lo exporta;
  el reset con `--scale api=N` y la verificación de que arrancaron exactamente N réplicas viven en
  ese script (ver `GUIA_breakpoint.md`). `FALLA` siempre apunta a `exchange-api-1` (la primera
  réplica), aunque haya más de una corriendo: sirve igual para ver si esa réplica se recupera y si
  las demás cubren mientras tanto.
- **Las tres variantes de `FALLA` disparan cosas distintas en Docker:**
  - `kill` (`docker kill`, SIGKILL) y `stop` (`docker stop`, SIGTERM + 10 s de gracia): Docker las
    trata como parada manual y **no** disparan `restart: unless-stopped`.
  - `crash`: mata el proceso real de la api desde afuera de Docker (`kill -9` vía un container
    auxiliar con `--pid=host`), que Docker sí interpreta como una caída y dispara la política de
    reinicio.
- **`FALLA`/`FALLA_A` sirven para medir recuperación** sin depender de que la carga por sí sola
  alcance a tirar la api. La falla se programa desde el inicio real de la corrida medida
  (`inicio.txt`, no desde que arranca el runner) y queda registrada con hora en
  `resultados/<carpeta>/falla-inducida.txt`. Con `FALLA=crash`, la suite hace `docker pull -q
  alpine:3` una sola vez al arrancar, para no tener que bajar esa imagen justo en el instante de
  inducir la falla.
- **Si la falla no queda inducida, la suite aborta.** Si terminada la corrida no existe
  `falla-inducida.txt` (por ejemplo, `FALLA_A` más largo que la duración del escenario, o la
  corrida terminó antes de tiempo), la suite no sigue como si la falla se hubiera inducido: corta
  con un error claro. El subshell que espera para inducirla no tiene tope de tiempo propio (un
  tope competía con este chequeo: se podía "rendir" en silencio si el primer build tras cambiar
  de rama tardaba de más), la única salida temprana válida es que la corrida ya haya terminado.
- **Si `correr-breakpoint-linux.sh` falla, la suite aborta** en el acto: no toca la carpeta de esa
  corrida, corta cualquier `FALLA` pendiente y no sigue con las repeticiones ni escenarios que
  quedaban. La carpeta de resultados la calcula una sola vez la suite y se la pasa al script
  (`-d`), para que una corrida que cruce la medianoche no termine con dos nombres de carpeta
  distintos entre la suite y el script.
- **Revisar con `SECO=1` antes de una corrida larga:** imprime toda la secuencia (comandos de
  Docker, enfriamiento, nombre de cada carpeta) sin tocar Docker ni Artillery.
- **El spike necesita `EXCHANGE_SPIKE_RATE` exportada a mano, sin default.** Tiene que ser 2·B
  con el B medido en esta máquina (ver `GUIA_breakpoint.md` y `GUIA_stress-recuperacion.md`):
  `correr-breakpoint-linux.sh` falla (en `SECO=1` también, es una validación, no un comando) si
  se corre `exchange-availability-spike` sin esa variable seteada.

  ```sh
  EXCHANGE_SPIKE_RATE=960 SECO=1 bash correr-suite-linux.sh exchange-availability-breakpoint exchange-availability-spike
  ```

## 3. Capturar

La suite ya llama a `capturar-grafana.mjs` al final de cada corrida. Para una carpeta vieja, o
para repetir una captura:

```sh
node capturar-grafana.mjs resultados/<carpeta> [prefijo]
```

Sin `[prefijo]`, lo deduce del YAML copiado en la carpeta (`exchange-<categoria>-<corto>` pasa a
`artillery-exchange-<corto>`). Variables de entorno: `GRAFANA_URL` (default `http://localhost`),
`GRAFANA_USER` y `GRAFANA_PASS` (default `admin`/`admin`, los valores por defecto del proyecto).

## 4. Analizar

```sh
python analizar-availability.py resultados/<carpeta>
```

Mismo análisis que en las corridas sueltas (ver `GUIA_breakpoint.md`,
`GUIA_stress-recuperacion.md`, `GUIA_endurance-performance.md`), con 4xx contando como atendido y
el 429 mostrado aparte (ver `DISENO_availability.md`, sección 2).

## 5. Comparar ramas

- **3 corridas por escenario y por rama, como mínimo** (`REPETICIONES=3`, el default).
- **Comparar la mediana de las 3 corridas, no una corrida suelta.** Informar también la
  dispersión (mínimo y máximo de esas 3 corridas) del número que se esté comparando: B, capacity,
  P95, t_rec, etc.
- **Una diferencia menor que la dispersión entre corridas de la misma rama no cuenta como
  diferencia.** Por ejemplo: si el caso base da B entre 300 y 340 req/s en sus 3 corridas, una
  rama con táctica que da 320 no mejoró nada, porque cae adentro del rango del caso base. Para
  que la diferencia cuente, la mediana de una rama tiene que quedar afuera del rango de corridas
  de la otra.
- **Mismas condiciones de host en todas las ramas:** enchufada, mismo perfil de energía, sin
  otras cargas, mismos `REPETICIONES`/`QUIETUD`. Si cambia la máquina o el momento del día,
  repetir también el caso base ese día: no comparar una corrida vieja del caso base contra una
  nueva de la rama con táctica.
- **Mismos escenarios y mismos parámetros derivados de B en todas las ramas.** Si B cambia de
  máquina, recalcular las cargas de `exchange-availability-stress*.yaml` y el
  `EXCHANGE_SPIKE_RATE` del spike antes de comparar (ver `GUIA_stress-recuperacion.md`).
