# Guia, apagado ordenado y timeouts

Con el reinicio automatico y el healthcheck, la api vuelve sola despues de una caida. Quedan
dos problemas:

- `app.js` no atiende SIGTERM. Con `docker stop`, Docker espera 10 s y la mata con SIGKILL,
  cortando los pedidos en curso y lo que `state.js` no habia guardado.
- nginx no tiene timeouts propios: si la api no responde, el cliente espera hasta su propio
  limite.

La rama agrega:

- Apagado ordenado en `app.js`: ante SIGTERM deja de aceptar pedidos, espera hasta 8 s a los
  que estan en curso, guarda el estado y sale con 0.
- Timeouts en nginx (8 s de lectura) y un reintento solo si la conexion falla, por ejemplo
  mientras la api reinicia. Nunca en un timeout, para no duplicar un cambio.
- nginx espera a que la api este sana para arrancar.

## Como medirlo

Con el stress de `exchange-availability-stress.yaml` y una falla a los 60 s, cuando empieza la
sobrecarga:

```
FALLA=crash FALLA_A=60 bash correr-suite-linux.sh exchange-availability-stress
FALLA=stop  FALLA_A=60 bash correr-suite-linux.sh exchange-availability-stress
```

El crash mata el proceso con `kill -9` desde afuera de Docker, que si dispara el reinicio
(`docker kill` y `docker stop` son paradas manuales y Docker no las reinicia). El stop compara
el apagado: sin la rama la api sale con 137 (SIGKILL), con la rama sale con 0.
