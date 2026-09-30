"""Uso: python analizar-availability.py resultados/<carpeta>   (ver README.md, "Analizar")"""
import datetime as dt
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.stdout.reconfigure(encoding="utf-8")

D = sys.argv[1]
UMBRAL = 99.0
RTO = 180
LOC = dt.timezone(dt.timedelta(hours=-3))


def leer(nombre):
    return open(os.path.join(D, nombre), encoding="utf-8", errors="replace").read()


def hora(t):
    return dt.datetime.fromtimestamp(t, LOC).strftime("%H:%M:%S")


reporte = json.loads(leer("reporte-artillery.json"))
ventanas = {}
for it in reporte["intermediate"]:
    p = int(it["period"]) // 1000
    v = ventanas.setdefault(p, {"c": Counter(), "s": []})
    v["c"].update(it["counters"])
    s = it["summaries"].get("http.response_time.2xx")
    if s:
        v["s"].append(s)
periodos = sorted(ventanas)

txt = leer("resultados-artillery.txt")
base = dt.datetime.fromtimestamp(periodos[0], dt.timezone.utc)
fases = []
for m in re.finditer(r"Phase started: (.+?) \(index: (\d+), duration: (\d+)s\) (\d\d):(\d\d):(\d\d)\(([+-]\d{4})\)", txt):
    tz = dt.timezone(dt.timedelta(hours=int(m[7][:3]), minutes=int(m[7][0] + m[7][3:])))
    t = base.astimezone(tz).replace(hour=int(m[4]), minute=int(m[5]), second=int(m[6]), microsecond=0)
    if t.timestamp() < periodos[0] - 3600:
        t += dt.timedelta(days=1)
    fases.append((m[1], int(m[3]), int(t.timestamp())))


def fase_de(p):
    actual = fases[0]
    for f in fases:
        if p + 5 >= f[2]:
            actual = f
    return actual[0]


t0 = next((f[2] for f in fases if f[0].startswith("Recuperacion")), None)

cpu, mem = {}, {}
for serie in json.loads(leer("datos-recursos.json")):
    if "exchange-api-1" not in serie["target"]:
        continue
    pts = [(t, v) for v, t in serie["datapoints"] if v is not None]
    if "cpu" in serie["target"]:
        for (t1, v1), (t2, v2) in zip(pts, pts[1:]):
            cpu[t2] = 100.0 * (v2 - v1) / ((t2 - t1) * 1e9)
    elif "memory" in serie["target"]:
        mem.update(pts)


def maximo(d, p):
    xs = [v for t, v in d.items() if p < t <= p + 10]
    return max(xs) if xs else None


filas, acum = [], 0
for p in periodos:
    c = ventanas[p]["c"]
    codigos = {k.split(".")[-1]: v for k, v in c.items() if k.startswith("http.codes.")}
    errores = {k[len("errors."):]: v for k, v in c.items() if k.startswith("errors.")}
    # atendido = 2xx + 4xx: un 4xx es una respuesta correcta del servicio, no una falla de
    # availability (decisión del grupo, ver DISENO_availability.md secc. 2). "ok" se mantiene
    # como el conteo de 2xx solo, porque alimenta el acumulado de exchanges (N) que usa tambien
    # el analisis de endurance/performance. el 429 cuenta como atendido pero se separa aparte:
    # es carga descartada por rate limiting, no un exito del negocio. falla = 5xx, timeout o
    # error de red.
    ok = sum(v for k, v in codigos.items() if k.startswith("2"))
    atendido = sum(v for k, v in codigos.items() if k.startswith(("2", "4")))
    descartes_429 = codigos.get("429", 0)
    total = sum(codigos.values()) + sum(errores.values())
    ss = ventanas[p]["s"]
    filas.append(dict(p=p, fase=fase_de(p), ok=ok, atendido=atendido, descartes_429=descartes_429,
                      total=total, vu=c.get("vusers.created", 0),
                      pct=100.0 * atendido / total if total else None,
                      p95=max((s["p95"] for s in ss), default=None),
                      med=max((s["median"] for s in ss), default=None),
                      cpu=maximo(cpu, p), mem=maximo(mem, p),
                      fallas={k: v for k, v in codigos.items() if k.startswith("5")} | errores,
                      acum_antes=acum, acum=acum + ok))
    acum += ok

print("| Hora | Fase | t-t0 (s) | vusers | 2xx | 429 | % éxito | P95 2xx (ms) | Mediana (ms) | CPU api % | Mem api MiB | Fallas | 2xx acum. |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for f in filas:
    print(f"| {hora(f['p'])} | {f['fase']} | {f['p'] - t0 if t0 else '-'} | {f['vu']} | {f['ok']} | {f['descartes_429']} | "
          f"{'-' if f['pct'] is None else f'{f['pct']:.2f}'} | {f['p95'] or '-'} | {f['med'] or '-'} | "
          f"{'-' if f['cpu'] is None else f'{f['cpu']:.0f}'} | {'-' if f['mem'] is None else f'{f['mem'] / 2**20:.0f}'} | "
          f"{', '.join(f'{k}: {v}' for k, v in f['fallas'].items())} | {f['acum']} |")

print("\nPor fase (todas las ventanas / sin la primera):")
por_fase = defaultdict(list)
for f in filas:
    por_fase[f["fase"]].append(f)
pct_fase = {}
for nombre, dur, inicio in fases:
    print(f"  {nombre} (inicio {hora(inicio)}, {dur} s)")
    for etiqueta, xs in (("todas", por_fase[nombre]), ("sin 1a", por_fase[nombre][1:])):
        xs = [x for x in xs if x["total"]]
        if not xs:
            continue
        ok = sum(x["ok"] for x in xs)
        atendido = sum(x["atendido"] for x in xs)
        total = sum(x["total"] for x in xs)
        descartes_429 = sum(x["descartes_429"] for x in xs)
        pct_fase[nombre] = 100 * atendido / total
        p95s = [x["p95"] for x in xs if x["p95"]]
        mems = [x["mem"] for x in xs if x["mem"]]
        cpus = [x["cpu"] for x in xs if x["cpu"] is not None]
        fallas = Counter()
        for x in xs:
            fallas.update(x["fallas"])
        print(f"    [{etiqueta}] % éxito {pct_fase[nombre]:.2f} | 2xx/s {ok / (10 * len(xs)):.0f} | 429: {descartes_429} | "
              f"P95 {min(p95s, default='-')} a {max(p95s, default='-')} ms | "
              f"CPU máx {max(cpus, default=0):.0f} % | Mem máx {max(mems, default=0) / 2**20:.0f} MiB | fallas {dict(fallas)}")

if t0:
    rec = [f for f in filas if f["fase"].startswith("Recuperacion") and f["pct"] is not None]
    t_rec = next((max(0, rec[i]["p"] - t0) for i in range(len(rec) - 2)
                  if all(rec[j]["pct"] >= UMBRAL for j in (i, i + 1, i + 2))), None)
    print(f"\nt0 (inicio de la recuperación): {hora(t0)}")
    print("t_rec:", f"{t_rec} s" if t_rec is not None else f"no se recuperó dentro del RTO de {RTO} s")
    print("Últimas 3 ventanas de la recuperación:", [round(f["pct"], 2) for f in rec if f["p"] >= t0 + RTO - 30])
else:
    sanos = []
    for nombre, _, _ in fases[1:]:
        if pct_fase.get(nombre, 0) < UMBRAL:
            break
        sanos.append(nombre)
    print(f"\nB (último escalón con >= {UMBRAL:.0f} %, sin la primera ventana):", sanos[-1] if sanos else "ninguno")

primera = next((f for f in filas if f["pct"] is not None and f["pct"] < UMBRAL and f["acum_antes"] > 5000), None)
if primera:
    print(f"\nPrimera ventana < {UMBRAL:.0f} %: {hora(primera['p'])} ({primera['fase']}, {primera['pct']:.2f} %), "
          f"{primera['acum_antes']} exchanges 2xx acumulados antes")
eventos = leer("eventos-containers.txt").split()
if "oom" in eventos:
    t_oom = int(eventos[eventos.index("oom") - 2])
    print(f"OOM de la api: {hora(t_oom)}, ~{max((f['acum'] for f in filas if f['p'] <= t_oom), default=0)} exchanges 2xx acumulados")
else:
    print("Sin OOM de la api")
if mem:
    print(f"Memoria api: pico {max(mem.values()) / 2**20:.0f} MiB, última muestra {mem[max(mem)] / 2**20:.0f} MiB")

agregado = reporte["aggregate"]["counters"]
print("Totales:", {k: v for k, v in agregado.items() if k.startswith(("http.codes", "errors", "http.requests"))})
