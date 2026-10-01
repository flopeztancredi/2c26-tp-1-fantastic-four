// Processor de exchange-availability-pedido-invalido.yaml.
// Entre los segundos 60 y 70 de la corrida, una parte de los POST /exchange sale con una moneda que no existe
// (baseCurrency = "XYZ"). Lo manda artillery, así que su respuesta aparece en el dashboard como cualquier otra.
const INICIO = Date.now();
const DESDE_S = 60;
const HASTA_S = 70;
const PROPORCION = 0.125; // ~20 pedidos invalidos por segundo a 160 req/s

function inyectarPedidoInvalido(requestParams, context, ee, next) {
  const t = (Date.now() - INICIO) / 1000;
  if (t >= DESDE_S && t < HASTA_S && Math.random() < PROPORCION) {
    requestParams.json = { ...requestParams.json, baseCurrency: "XYZ" };
    ee.emit("counter", "pedidos_invalidos_enviados", 1);
  }
  return next();
}

module.exports = { inyectarPedidoInvalido };
