"""Concilia las metricas de negocio de Graphite contra el log y los saldos de la api.

Uso (ver GUIA_metricas-negocio.md):
  python conciliar-metricas.py foto antes.json          sin carga, justo antes de la corrida
  ... correr la carga y esperar 20 s ...
  python conciliar-metricas.py conciliar antes.json     imprime CA6, CA7 y CA8

Opciones: --api http://localhost:5555  --graphite http://localhost:8090  --prefijo arvault.exchange
"""
import argparse
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")

TOLERANCIA = 1e-9  # relativa al volumen de la moneda: error de punto flotante, no perdida
ESPERA = 20  # s desde el ultimo cambio: un envio de statsd (10 s) mas margen


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read())


def foto(args):
    cuentas = get(f"{args.api}/accounts")
    json.dump({"ts": time.time(), "cuentas": cuentas}, open(args.archivo, "w"), indent=2)
    print(f"Foto guardada en {args.archivo}: " + ", ".join(f"{c['currency']} {c['balance']}" for c in cuentas))
    print("Tiene que haber pasado al menos 10 s sin carga antes de esta foto.")


def graphite(args, patron, desde, hasta):
    """Suma de todos los puntos de cada serie, sin maxDataPoints (datos crudos)."""
    # Graphite devuelve los puntos posteriores al intervalo de 10 s que contiene "from": si la foto cae en
    # un borde, el intervalo de la foto queda afuera (924 cambios en el stress del 01/10). Se pide desde 10 s
    # antes; no suma cambios ajenos porque la foto exige 10 s sin carga antes (ver foto())
    q = urllib.parse.urlencode({"target": f"stats_counts.{args.prefijo}.{patron}",
                                "from": int(desde) - 10, "until": int(hasta), "format": "json"})
    series = get(f"{args.graphite}/render?{q}")
    return {s["target"].split(".")[-1]: sum(v for v, _ in s["datapoints"] if v is not None) for s in series}


def iguales(a, b, escala):
    return abs(a - b) <= TOLERANCIA * max(abs(escala), 1.0)


def conciliar(args):
    antes = json.load(open(args.archivo))
    desde = antes["ts"]
    cuentas = get(f"{args.api}/accounts")
    log = [e for e in get(f"{args.api}/log")
           if dt.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp() >= desde]
    if not log:
        sys.exit("El log no tiene cambios posteriores a la foto.")

    ultimo = max(dt.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp() for e in log)
    if time.time() - ultimo < ESPERA:
        espera = ESPERA - (time.time() - ultimo)
        print(f"Esperando {espera:.0f} s a que statsd envie el ultimo intervalo...")
        time.sleep(espera)
    hasta = time.time()

    # lo que dice el log, desde el punto de vista de arVault
    ok = [e for e in log if e["ok"]]
    compras_log, ventas_log = defaultdict(float), defaultdict(float)
    for e in ok:
        compras_log[e["request"]["baseCurrency"]] += e["request"]["baseAmount"]
        ventas_log[e["request"]["counterCurrency"]] += e["counterAmount"]

    # lo que dice Graphite
    ops = graphite(args, "operaciones.*", desde, hasta)
    compras_g = graphite(args, "compras.*", desde, hasta)
    ventas_g = graphite(args, "ventas.*", desde, hasta)

    print(f"\nVentana: {dt.datetime.fromtimestamp(desde):%H:%M:%S} a {dt.datetime.fromtimestamp(hasta):%H:%M:%S}, "
          f"{len(log)} cambios en el log\n")

    fallas = 0

    def fila(nombre, log_v, g_v, escala=None, exacto=False, fuente="log"):
        nonlocal fallas
        bien = log_v == g_v if exacto else iguales(log_v, g_v, escala if escala is not None else log_v)
        fallas += not bien
        print(f"  {nombre:<24} {fuente:>5} {log_v:>20.6f}   graphite {g_v:>20.6f}   dif {g_v - log_v:>+14.6g}   {'OK' if bien else 'FALLA'}")

    print("CA6: cantidad de operaciones exitosas (exacta; una diferencia es perdida de UDP)")
    fila("operaciones.ok", len(ok), ops.get("ok", 0), exacto=True)
    print("CA7: cantidad de rechazadas (exacta)")
    fila("operaciones.rechazadas", len(log) - len(ok), ops.get("rechazadas", 0), exacto=True)

    monedas = sorted({c["currency"] for c in cuentas})
    print(f"CA6: montos por moneda (tolerancia relativa {TOLERANCIA:g})")
    for m in monedas:
        volumen = compras_log[m] + ventas_log[m]
        fila(f"compras.{m}", compras_log[m], compras_g.get(m, 0.0), volumen)
        fila(f"ventas.{m}", ventas_log[m], ventas_g.get(m, 0.0), volumen)

    print("CA8: neto en Graphite contra saldo final menos saldo inicial de la cuenta de arVault")
    saldo_antes = {c["currency"]: c["balance"] for c in antes["cuentas"]}
    for c in cuentas:
        m = c["currency"]
        neto = compras_g.get(m, 0.0) - ventas_g.get(m, 0.0)
        fila(f"neto.{m}", c["balance"] - saldo_antes[m], neto, compras_log[m] + ventas_log[m], fuente="saldo")

    print(f"\n{'Todo concilia.' if not fallas else f'{fallas} diferencias.'} "
          "CA8 muestra que metricas y saldos salen del mismo evento; no detecta la condicion de carrera.")
    sys.exit(1 if fallas else 0)


p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument("accion", choices=["foto", "conciliar"])
p.add_argument("archivo")
p.add_argument("--api", default="http://localhost:5555")
p.add_argument("--graphite", default="http://localhost:8090")
p.add_argument("--prefijo", default="arvault.exchange")
a = p.parse_args()
foto(a) if a.accion == "foto" else conciliar(a)
