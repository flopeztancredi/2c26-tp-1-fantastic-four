// Processor de exchange-availability-caida.yaml.
// Provoca una caída real del proceso de la api: a los 60 s y a los 120 s de la corrida manda UN solo POST /exchange
// con una moneda que no existe (baseCurrency = "XYZ"). En el código base ese pedido lanza un TypeError que nadie
// atrapa y Node termina con código 1 (A.3). A diferencia de docker kill, que Docker toma como una detención manual,
// una salida así es la que una política de reinicio del container tiene que levantar.
// Artillery reparte la carga entre varios workers, cada uno con su copia de este archivo; para que el pedido se mande
// una sola vez en total, el primer worker que llega crea un archivo de marca (los workers comparten el proceso padre).
const fs = require("fs");
const os = require("os");
const path = require("path");
const INICIO = Date.now();
const CAIDAS_S = [60, 120];
const enviadas = new Set();

function soyElPrimero(s) {
  try {
    fs.closeSync(fs.openSync(path.join(os.tmpdir(), `caida-${process.ppid}-${s}`), "wx"));
    return true;
  } catch {
    return false;
  }
}

function provocarCaida(requestParams, context, ee, next) {
  const t = (Date.now() - INICIO) / 1000;
  const caida = CAIDAS_S.find((s) => t >= s && !enviadas.has(s));
  if (caida !== undefined) {
    enviadas.add(caida);
    if (!soyElPrimero(caida)) return next();
    requestParams.json = { ...requestParams.json, baseCurrency: "XYZ" };
    ee.emit("counter", "caidas_provocadas", 1);
    console.log(`caida provocada a los ${t.toFixed(1)} s`);
  }
  return next();
}

module.exports = { provocarCaida };
