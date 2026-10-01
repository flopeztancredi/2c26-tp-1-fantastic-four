"""Acompaña a exchange-availability-caida.yaml: registra, segundo a segundo, si alguien puede enterarse de una caída.

Uso: python3 monitor-salud.py <carpeta de resultados>

Espera a que correr-breakpoint-linux.sh escriba inicio.txt y, hasta que aparece fin.txt, cada 1 s:
  - hace ping/echo a GET /health a través de nginx (como lo vería un monitor externo) con 0,8 s de timeout;
  - lee con docker inspect el estado del container de la api y el resultado de su healthcheck;
y lo manda a StatsD como gauges <prefijo>.salud.* (graphite.storage-schemas.conf los guarda con resolución de 1 s):
  salud.ping    1 = /health respondió 200 | 0 = no respondió o respondió con error | -1 = /health no existe (404)
  salud.docker  2 = healthy | 1 = starting | 0 = unhealthy | -1 = running sin healthcheck | -2 = container detenido
  salud.reinicios  RestartCount del container
Deja todo en <carpeta>/salud.txt.
"""
import os, socket, subprocess, sys, time, urllib.error, urllib.request

DIR = sys.argv[1]
URL = "http://localhost:5555/health"
PREFIJO = "artillery-exchange-caida"
DOCKER = {"healthy": 2, "starting": 1, "unhealthy": 0}
statsd = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def gauge(nombre, valor):
    # un gauge con signo es un incremento en StatsD: se pone en 0 y después se aplica el valor
    statsd.sendto(f"{PREFIJO}.{nombre}:0|g\n{PREFIJO}.{nombre}:{valor}|g\n".encode(), ("127.0.0.1", 8125))


def ping():
    try:
        with urllib.request.urlopen(URL, timeout=0.8) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def docker():
    r = subprocess.run(["docker", "inspect", "-f",
                        "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.RestartCount}}",
                        "exchange-api-1"], capture_output=True, text=True)
    estado, salud, reinicios = (r.stdout.split() + ["?", "?", "0"])[:3]
    if estado != "running":
        valor = -2
    else:
        valor = DOCKER.get(salud, -1)
    return estado, salud, int(reinicios) if reinicios.isdigit() else 0, valor


while not os.path.exists(f"{DIR}/inicio.txt"):
    time.sleep(0.1)
inicio = int(open(f"{DIR}/inicio.txt").read())
salida = open(f"{DIR}/salud.txt", "w")
salida.write("hora t(s) GET/health docker_estado docker_salud reinicios\n")
seg = int(time.time()) + 1
while not os.path.exists(f"{DIR}/fin.txt"):
    time.sleep(max(0, seg + 0.05 - time.time()))
    codigo = ping()
    estado, salud, reinicios, valor = docker()
    gauge("salud.ping", 1 if codigo == 200 else -1 if codigo == 404 else 0)
    gauge("salud.docker", valor)
    gauge("salud.reinicios", reinicios)
    salida.write(f"{time.strftime('%T')} {seg - inicio} {codigo or 'sin_respuesta'} {estado} {salud} {reinicios}\n")
    salida.flush()
    seg += 1
