"""Acompaña a exchange-availability-carrera-saldo.yaml: repone la cuenta USD de arVault y mide el efecto de la carrera.

Uso: python3 reponer-saldo-carrera.py <carpeta de resultados> [periodo s=10] [saldo USD=1000] [monto USD por cambio=99.99]

Espera a que correr-breakpoint-linux.sh escriba inicio.txt y deja la cuenta USD (id 2) en 0,01 USD, antes de que artillery
mande pedidos, para que no se usen los 60.000 USD iniciales de accounts.json y todos los ciclos con fondos sean completos
(la api rechaza un saldo 0 como pedido mal formado). Después, hasta que aparece fin.txt:
  - repone la cuenta a <saldo> al principio de cada ciclo; los ciclos caen en múltiplos de <periodo> s del reloj,
    igual que las ventanas de 10 s de Graphite;
  - cada 1 s lee el saldo y lo manda a StatsD como gauge <prefijo>.saldo.USD (graphite.storage-schemas.conf
    guarda estas series con resolución de 1 s);
  - en el anteúltimo segundo de cada ciclo cuenta en GET /log los cambios aprobados que empezaron en el ciclo y manda
    <prefijo>.ciclo.aprobados y <prefijo>.ciclo.pagables (cuántos cambios de <monto> se pueden pagar con <saldo>).
    Se manda un segundo antes del final porque StatsD lo entrega en el flush siguiente y Graphite lo guardaría en la
    ventana del ciclo que viene. Los cambios se aprueban en el primer segundo del ciclo, así que el conteo no cambia.
Deja todo en <carpeta>/saldos.txt y <carpeta>/ciclos.txt.
"""
import json, math, os, socket, sys, time, urllib.request
from datetime import datetime

DIR = sys.argv[1]
PERIODO = int(sys.argv[2]) if len(sys.argv) > 2 else 10
SALDO = float(sys.argv[3]) if len(sys.argv) > 3 else 1000
MONTO = float(sys.argv[4]) if len(sys.argv) > 4 else 99.99
PAGABLES = math.floor(SALDO / MONTO + 1e-9)
API = "http://localhost:5555"
PREFIJO = "artillery-exchange-carrera-saldo"
statsd = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def pedir(metodo, ruta, cuerpo=None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(API + ruta, data=datos, method=metodo, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=2) as r:
        return json.load(r)


def gauge(nombre, valor):
    # un gauge con signo es un incremento en StatsD: se pone en 0 y después se aplica el valor
    statsd.sendto(f"{PREFIJO}.{nombre}:0|g\n{PREFIJO}.{nombre}:{valor}|g\n".encode(), ("127.0.0.1", 8125))


def reponer(saldo=SALDO):
    pedir("PUT", "/accounts/2/balance", {"balance": saldo})


def aprobados_entre(desde, hasta):
    return sum(1 for e in pedir("GET", "/log")
               if e["ok"] and desde <= datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp() < hasta)


while not os.path.exists(f"{DIR}/inicio.txt"):
    time.sleep(0.1)
inicio = int(open(f"{DIR}/inicio.txt").read())
reponer(0.01)
ciclo = time.time()
saldos = open(f"{DIR}/saldos.txt", "w")
ciclos = open(f"{DIR}/ciclos.txt", "w")
saldos.write("hora t(s) saldo_USD accion\n")
ciclos.write(f"desde hasta aprobados pagables(con {SALDO:.0f} USD y cambios de {MONTO} USD)\n")
saldos.write(f"{time.strftime('%T')} {ciclo - inicio:.1f} 0.01 vacia la cuenta\n")

seg = math.floor(time.time()) + 1
while not os.path.exists(f"{DIR}/fin.txt"):
    time.sleep(max(0, seg + 0.05 - time.time()))
    accion = ""
    if seg % PERIODO == 0:
        reponer()
        ciclo, accion = seg, "repone"
    try:
        s = next(a["balance"] for a in pedir("GET", "/accounts") if a["id"] == 2)
        gauge("saldo.USD", s)
    except Exception:
        s = "sin_respuesta"
    saldos.write(f"{time.strftime('%T')} {seg - inicio} {s} {accion}\n")
    if seg % PERIODO == PERIODO - 2:
        n = aprobados_entre(ciclo, seg + 1)
        gauge("ciclo.aprobados", n)
        gauge("ciclo.pagables", PAGABLES)
        ciclos.write(f"{time.strftime('%T', time.localtime(ciclo))} {time.strftime('%T', time.localtime(seg + 1))} {n} {PAGABLES}\n")
    saldos.flush(); ciclos.flush()
    seg += 1
