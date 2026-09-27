# Diseño de las pruebas de availability

Por qué las pruebas de `perf/` están armadas como están: qué se quería probar, qué mide cada métrica y cómo cada corrida responde una parte de la pregunta. Cómo correrlas está en `README.md` y en las guías; qué salió, en `resultados/CONCLUSIONES_availability.md`.

## 1. Qué se quiere probar

En el caso base, availability está perjudicada por la arquitectura:

- **Una sola instancia de la api**, y nginx apunta a un único upstream fijo (`exchange-api-1:3000`). No hay redundancia, health check ni failover.
- **No hay política de reinicio** (`restart:`): si la api muere, no vuelve sola.
- **La api es un único proceso Node, con 1 CPU y 512 MiB.** El estado (saldos y log de exchanges) vive en memoria, y el log se serializa entero a disco cada 1 s.
- **Cada `POST /exchange` tarda entre 400 y 800 ms por diseño**, por dos transferencias simuladas de 200 a 400 ms cada una.

**Pregunta:** con carga creciente y con sobrecarga, ¿hasta dónde sigue atendiendo el servicio?, ¿cómo falla cuando deja de hacerlo? y, al retirar la sobrecarga, ¿vuelve solo y con el mismo rendimiento?

**Por qué la falla se provoca con carga y no a mano.** Matar el container con `docker kill` solo muestra lo obvio: sin réplica ni reinicio, el servicio queda caído. Provocarla con carga permite medir además **en qué punto** empieza a fallar, **de qué forma** falla y **si se recupera** sin intervención. Esas tres cosas son las que después orientan las tácticas.

La pregunta se descompone en cinco niveles. Cada corrida cubre algunos:

| Nivel | Pregunta | Corrida |
|---|---|---|
| 0 | ¿Hasta qué carga atiende bien? (boundary B) | 1, breakpoint |
| 1 | Al superar la capacidad, ¿degrada o colapsa? | 2, stress |
| 2 | ¿No responde o responde lento? | 1 y 2 |
| 3 | ¿Qué tipo de falla aparece y qué recurso se agota? | 1 y 2 |
| 4 | Al retirar el estrés, ¿vuelve? ¿En cuánto tiempo? ¿Con el mismo rendimiento? | 2, stress |

Cada informe recorre los 7 pasos del *performance testing process*: entorno, criterios, diseño, configuración, implementación, ejecución y análisis ([fuente](https://www.softwaretestingclass.com/what-is-performance-testing/)).

## 2. Cómo se mide "disponible"

Se mide **desde el cliente**, que es lo que ve un usuario: un request sirve si vuelve con 2xx a tiempo.

- **% de éxito = 2xx / (todas las respuestas HTTP + todos los errores de red).**
  - Los errores de red (`ETIMEDOUT`, `ECONNRESET`) **cuentan como no disponibles**. Cuando el sistema se satura o la api muere, la mayoría de las fallas le llegan al cliente así, sin código HTTP. Contar solo códigos HTTP sobreestimaría mucho la disponibilidad.
  - Solo cuenta 2xx. Un 5xx es un request no atendido. Los 500 por "Not enough funds" se evitan desde el escenario (sección 4), porque son una regla de negocio y no falta de disponibilidad.
- **Umbral: 99 %, por ventana o por escalón.** Es un umbral por requests, no el "99 %" de un SLA anual. Tolera un error aislado, como un 502 suelto, y detecta una falla sistemática.
- **Ventanas de 10 s.** Es la granularidad con la que reporta artillery y la resolución de graphite. Un agregado de toda la corrida escondería cuándo empieza la falla, cuánto dura y si hay rebotes.
- **Timeout del cliente: 10 s.** Un request más lento se corta y cuenta como `ETIMEDOUT`: para un cliente, una respuesta que no llega en 10 s es un servicio no disponible.
  - Es la frontera entre "lento" y "no responde".
  - Se mantiene fijo en todas las corridas. Cambiarlo cambia qué cuenta como éxito y, con eso, B.
  - Un timeout más largo también deja más conexiones abiertas a la vez, y nginx se queda sin conexiones antes.

## 3. Por qué el P95

La latencia no forma parte de la definición de disponible, pero es la que responde el nivel 2 y avisa antes de que la falla aparezca.

- **Se mira el P95 porque es la experiencia del 5 % más lento de los usuarios.**
  - El promedio esconde esa cola.
  - El máximo depende de un solo request atípico.
  - La mediana muestra el caso típico y se informa junto al P95.
- **Es un aviso temprano.** Cuando la api se acerca a su capacidad, los requests se encolan y el P95 sube **antes** que la tasa de error. Por ejemplo, en el escalón de 320 req/s del breakpoint el éxito fue del 100 %, pero el P95 creció de 1,8 a 5,9 s: la ruptura llegó en el escalón siguiente.
- **Hay una referencia teórica:** el servicio no puede responder en menos de 400–800 ms. Un P95 cerca de ~750 ms es el sistema sano; todo lo que esté por encima es cola o degradación.
- **Se calcula solo sobre las respuestas 2xx** (`http.response_time.2xx`), para que las fallas rápidas, como un 502 inmediato, no hagan parecer que el sistema es más rápido.
- **Se informa sin umbral**, porque no hay un requerimiento de latencia. Se usa para comparar: la verificación contra la línea base o contra el escalón B (tolerancia de +10 %), y para clasificar una falla como de timing.

## 4. Decisiones comunes a las dos corridas

| Decisión | Por qué |
|---|---|
| Solo `POST /exchange` | Es la operación central del negocio y la que ejercita todo el camino: las dos transferencias, los saldos y el crecimiento del log. `GET /rates` no representa la carga real |
| ARS→USD y USD→ARS alternados, con montos chicos | Los saldos no se agotan durante la corrida, así que no aparecen 500 por "Not enough funds" |
| 1 request por usuario virtual | Así `arrivalRate` ≈ req/s y cada request es un cliente independiente, con conexión propia |
| Reset de la api antes de cada corrida | La api acumula estado (el log) y ese estado la degrada. Sin reset, las corridas no son comparables |
| Una sola réplica y el compose sin cambios | Es el sistema que se evalúa. Otra topología es otro experimento |
| Mismas condiciones del host y registro del entorno | El generador y el sistema comparten la máquina. La swap cambia cómo falla la api por memoria: puede hacer swap o morir |
| Verificación de que el cliente no es el límite | Si aparecen `EADDRNOTAVAIL` o `EADDRINUSE`, las fallas son del generador. Por eso, en Windows, artillery corre dentro de la red de Docker (ver `README.md`) |
| CPU y memoria de la api y de nginx contra sus límites (cadvisor) | Identifican el recurso que se agota (nivel 3) |
| Registro de eventos de los containers (`oom`, `die`) | Separa un crash de una omission. Del lado del cliente pueden verse iguales |
| Al menos 2 corridas por entorno | Una sola corrida es un solo punto |

**Tipos de falla** (nivel 3), según la taxonomía de availability de la materia. Importa distinguirlos porque cada uno se ataca con una táctica distinta:

| Tipo | Cómo se reconoce |
|---|---|
| Timing | Responde bien pero tarde: 2xx con P95 alto |
| Omission | No responde: `ETIMEDOUT` o `ECONNRESET` |
| Crash | El proceso muere: `oom` o `die` en los eventos, 502 o `Connection refused` |
| Response | Responde mal: 5xx de la aplicación |

## 5. Corrida 1: breakpoint (niveles 0, 2 y 3)

**Qué responde:** hasta qué carga el sistema atiende bien (B), cuál es su capacity, cómo empeora la latencia antes de fallar, qué falla aparece y qué recurso se agota.

| Decisión | Por qué |
|---|---|
| Escalones de carga constante, de 60 s | Seis ventanas por escalón: alcanza para que la cola se estabilice y para tener varias muestras. Con carga constante, cada escalón responde "¿aguanta X req/s?" |
| Escalones de a 80 req/s, de 160 a 640 | Las primeras corridas (5 → 640 duplicando) ubicaron el límite entre 320 y 640. Con pasos de 80, B se ubica con más precisión |
| Calentamiento de 30 s a 80 req/s, que no se analiza | La api recién recreada compila en caliente (JIT), graphite crea las series y la latencia base se estabiliza |
| Se descarta la primera ventana de cada escalón | Mezcla la transición desde el escalón anterior |
| B = último escalón con ≥ 99 % | Es la mayor carga que se atiende bien de forma sostenida, y la referencia para diseñar la corrida 2 |
| Capacity = mayor throughput 2xx sostenido | Separa la carga ofrecida de la atendida. Donde se separan, el sistema está saturado |

**Qué no mide:** la recuperación. Después de la ruptura la carga sigue subiendo.

## 6. Corrida 2: stress + recuperación (niveles 1 y 4)

**Qué responde:** qué pasa cuando se supera la capacidad (¿degrada o colapsa?), y si al volver a una carga sana el sistema vuelve solo, en cuánto tiempo y con qué rendimiento.

Las fases se definen en función de B, así el mismo diseño vale en cualquier entorno:

| Fase | Carga | Por qué |
|---|---|---|
| Línea base, 60 s | 0,5·B | Carga sana con margen. Es la referencia de esta misma corrida, medida en las mismas condiciones |
| Sobrecarga, 60 s | 1,5·B | Claramente por encima de la capacidad. Alcanza para saturar colas y conexiones sin llevar la corrida a un estado del que ya no se sale |
| Recuperación, 180 s | 0,5·B | Se retira el estrés pero se sigue midiendo con carga, porque la recuperación solo se ve si hay tráfico. 180 s es el RTO elegido: 18 ventanas, tiempo de sobra para que se vacíen las colas y el TIME_WAIT |
| Verificación, 60 s | B | La misma carga del escalón B del breakpoint: la comparación es directa |

| Criterio | Por qué |
|---|---|
| t_rec = hasta la primera de 3 ventanas seguidas con ≥ 99 % | Una sola ventana buena puede ser un rebote. Con tres, la recuperación queda confirmada. La resolución es de 10 s |
| "No se recuperó" si no ocurre antes de los 180 s | Es el RTO del experimento: con más tiempo, ya no es autorrecuperación |
| Degradación = throughput 2xx ≥ 50 % de la capacity y la api viva | Un sistema que degrada sigue entregando una parte útil de lo que puede. Uno que colapsa deja de atender casi todo, o muere |
| Recuperación completa = verificación con ≥ 99 % y P95 no más de un 10 % peor que el escalón B | Volver a estar disponible no alcanza. También tiene que volver al mismo rendimiento |

**Variante con B = 450.** Con B = 320, la sobrecarga de 480 req/s no superó la capacidad de la api recién reseteada, así que el nivel 1 no se pudo evaluar. La variante toma B = 450 como hipótesis:
- línea base a 320, el B medido;
- rampa de 30 s hasta 675 req/s, para llegar a la sobrecarga sin un salto brusco;
- resto de las fases y criterios, iguales.

**Qué no mide:**
- no da "nueves" ni MTBF;
- el tiempo de recuperación es solo **sin intervención humana**. Si la api muere, no hay `restart:` y el resultado es "no se recuperó": eso es justamente lo que se quiere mostrar.

## 7. Cómo se conectan las corridas

1. El breakpoint da **B, la capacity y el P95 del escalón B** de un entorno.
2. El stress usa esos tres valores:
   - **B** fija las cargas;
   - **la capacity** es la referencia de degradación contra colapso;
   - **el P95** es la referencia de recuperación completa.
3. Con los hallazgos se eligen tácticas: reinicio automático, acotar el costo del log, y rate limiting y timeouts en nginx. Cada táctica se retestea con **las mismas corridas y los mismos valores**, para comparar antes y después.
