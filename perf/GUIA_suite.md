# Guía: suite completa (comparar ramas)

Cómo correr la misma batería de escenarios en una rama para compararla contra el caso base y
contra las demás ramas con táctica. El diseño de cada escenario individual está en
`DISENO_availability.md` y en la guía de cada corrida (`GUIA_breakpoint.md`,
`GUIA_stress-recuperacion.md`, `GUIA_endurance-performance.md`); esta guía es sobre la mecánica de
correr todo junto y comparar.

## Por qué una suite y no corridas sueltas

El grupo mide el caso base y cada táctica con los mismos escenarios, para que la comparación entre
ramas sea válida. Correr cada corrida a mano, una por una, es fácil de hacer distinto entre ramas
(otro orden, se olvida el calentamiento, no queda tiempo entre corridas). `correr-suite-linux.sh`
fija ese procedimiento en un script: mismos pasos, mismo orden, mismas R repeticiones.

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
Por cada uno, por defecto 3 veces: recrea la api con el estado inicial de la imagen, espera a que
responda por nginx, corre el calentamiento (`exchange-availability-calentamiento.yaml`, no se
analiza), espera una quietud para que los paneles bajen a la línea de base, corre el escenario
medido (`correr-breakpoint-linux.sh`) y captura el dashboard.

Opciones por variable de entorno:

| Variable | Qué hace | Default |
|---|---|---|
| `REPETICIONES` | Corridas por escenario | 3 |
| `QUIETUD` | Segundos de descanso entre el calentamiento y la corrida medida | 60 |
| `API_REPLICAS` | Réplicas de la api (pasa `--scale api=N`) | 1 |
| `FALLA` | `kill` o `stop`: induce una falla de la api durante la corrida medida | (ninguna) |
| `FALLA_A` | Segundos desde el inicio de la corrida medida para la falla (obligatorio con `FALLA`) | (ninguno) |
| `FORZAR` | Corre igual si la máquina está a batería | 0 |
| `SECO` | Imprime los comandos en vez de correrlos | 0 |

- **`API_REPLICAS` mayor a 1 no anda hoy.** `correr-breakpoint-linux.sh` rechaza más de una
  réplica de la api, y su propio reset tampoco repite `--scale` (la volvería a bajar a 1 aunque
  pasara ese chequeo). La opción queda lista para cuando ese script soporte varias réplicas;
  hasta entonces, dejar el default.
- **`FALLA`/`FALLA_A` sirven para medir recuperación** sin depender de que la carga por sí sola
  alcance a tirar la api. La falla se programa desde el inicio real de la corrida medida
  (`inicio.txt`, no desde que arranca el runner) y queda registrada con hora en
  `resultados/<carpeta>/falla-inducida.txt`.
- **Revisar con `SECO=1` antes de una corrida larga:** imprime toda la secuencia (comandos de
  Docker, calentamiento, quietud, nombre de cada carpeta) sin tocar Docker ni Artillery.

  ```sh
  SECO=1 bash correr-suite-linux.sh exchange-availability-breakpoint exchange-availability-spike
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
