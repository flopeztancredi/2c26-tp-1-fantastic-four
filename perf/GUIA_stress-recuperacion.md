# Guía — Corrida 2: stress + recuperación de availability

Los fundamentos del diseño (qué se mide y por qué) están en `DISENO_availability.md`.

## Objetivo

- **Nivel 1, sobrecarga:** al superar la capacidad, ¿el sistema **degrada** (sigue atendiendo lo que puede) o **colapsa** (deja de atender, se cuelga o muere)? ¿Qué falla aparece?
- **Nivel 4, recuperación:** al retirar el estrés, ¿vuelve solo a estar disponible? ¿En cuánto tiempo? ¿Con el mismo rendimiento?

Necesita el **B del breakpoint medido en la misma máquina** (`GUIA_breakpoint.md`).

## Carga

Todas las fases corren en una sola ejecución de artillery. El timeout es de 10 s y los requests son los mismos que en el breakpoint.

| Fase | `exchange-availability-stress.yaml` | `exchange-availability-stress-b450.yaml` | Pregunta |
|---|---|---|---|
| Línea base | 0,5·B = 160 req/s, 60 s | 320 req/s, 60 s | ¿Cómo se ve el sistema sano? |
| Rampa | — | 320 → 675 req/s, 30 s | Subir de a poco hasta la sobrecarga |
| Sobrecarga | 1,5·B = 480 req/s, 60 s | 675 req/s, 60 s | ¿Degrada o colapsa? |
| Recuperación | 0,5·B = 160 req/s, 180 s | 225 req/s, 180 s | ¿Vuelve? ¿En cuánto tiempo? |
| Verificación | B = 320 req/s, 60 s | 450 req/s, 60 s | ¿Soporta B otra vez? |

- `exchange-availability-stress.yaml` usa **B = 320**, el B medido en Windows. En otro entorno hay que reemplazar los cuatro `arrivalRate` con el B de ese entorno.
- `exchange-availability-stress-b450.yaml` es una variante con **B = 450 como hipótesis**. Se agregó porque, con B = 320, la sobrecarga de 480 req/s no llegó a sobrecargar la api recién reseteada.

## Criterios

- **Ventana disponible:** % de éxito ≥ 99 % en una ventana de 10 s, con el mismo cálculo que en el breakpoint.
- **t_rec:** desde el inicio de la recuperación (t0) hasta el inicio de la primera de **3 ventanas seguidas** disponibles.
- **Tope (RTO): 180 s.** Si no aparecen esas 3 ventanas antes del fin de la recuperación, el resultado es "no se recuperó".
- **Recuperación completa:** en la verificación, ≥ 99 % de éxito y un P95 no más de un 10 % peor que el del escalón B del breakpoint.
- **Degradación o colapso:** es degradación si, durante la sobrecarga, el throughput 2xx se mantiene en al menos el 50 % de la capacity del breakpoint y la api sigue viva. Si no, es colapso.

El compose no declara `restart:`: si la api muere, no vuelve sola, y eso es un resultado.

## Correr

Desde `perf/`, con las mismas condiciones del host que en el breakpoint:

| Entorno | Comando | Prefijo en Grafana |
|---|---|---|
| Windows, B = 320 | `.\correr-breakpoint-docker.ps1 -Escenario exchange-availability-stress -Nombre stress_windows` | `artillery-exchange-stress-docker` |
| Windows, B = 450 | `.\correr-breakpoint-docker.ps1 -Escenario exchange-availability-stress-b450 -Nombre stress_b450_windows` | `artillery-exchange-stress-b450-docker` |
| Linux | `bash correr-breakpoint-linux.sh -e exchange-availability-stress -n stress_linux` (y lo mismo con `-b450`) | `artillery-exchange-stress` / `artillery-exchange-stress-b450` |

El reset de la api que hace el script es **imprescindible**. La api acumula el log de exchanges en memoria, y ese estado degrada el servicio. Sin reset, la línea base ya arranca peor y las corridas no se pueden comparar.

## Durante la corrida

- Anotar la hora del inicio de cada fase. La salida de artillery muestra `Phase started`, en UTC en Windows y en hora local en Linux.
- **Sobrecarga:** el primer error y su tipo, si el throughput 2xx se sostiene o cae, y la CPU y memoria de la api contra su límite.
- **Recuperación:** la primera ventana que vuelve a ≥ 99 %, y si la memoria baja o sigue subiendo.
- **Si la api muere:** no reiniciarla. Dejar que termine la corrida.
- Los requests lanzados al final de la sobrecarga pueden fallar por timeout ya dentro de la recuperación, en sus primeras ventanas. Es parte del efecto: no se descarta, se menciona en el informe.

## Analizar

```
python analizar-availability.py resultados/<fecha>_stress_<entorno>
```

El script da la tabla por ventana y por fase, t_rec, la primera ventana que falla con los exchanges acumulados hasta ese momento, y el OOM si lo hubo.

**Qué informar:**

- **Nivel 1:** degradación o colapso, el tipo de falla y el recurso saturado.
- **Nivel 4:** t_rec, o "no se recuperó dentro del RTO". También si la disponibilidad **se sostuvo** hasta el fin de la recuperación: una recuperación seguida de una recaída hay que informarla como tal.
- **Recuperación completa:** sí o no. Si no, buscar la causa:
  - **Memoria que no baja:** la api retiene lo acumulado en la sobrecarga.
  - **Tamaño del log:** en la verificación, la api procesó muchos más exchanges que en el breakpoint, y el log se serializa entero cada 1 s.
  - **Api muerta** (`OOMKilled=true`): un 0 % en la verificación no dice nada sobre la capacidad.
- **Validez de la medición:** confirmar que no hubo `EADDRNOTAVAIL` ni `EADDRINUSE`. Si los hubo, las ventanas afectadas fallaron por el cliente y no cuentan para t_rec.

**Reproducibilidad:** hacer al menos 2 corridas por entorno, con reset entre una y otra, e informar el t_rec de cada una.

## Retest

Probar cada táctica con **la misma corrida y los mismos valores**, para comparar antes y después:

| Problema encontrado | Táctica |
|---|---|
| La api muere | `restart: unless-stopped` |
| El estado acumulado degrada la api | Limitar o rotar el log, o persistirlo en modo append |
| nginx se queda sin conexiones o hay colapso | Rate limiting y timeouts de upstream más cortos en nginx |
