import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import {
  createStatsdMetrics,
  completedIncrements,
  rejectedIncrements,
  seedIncrements,
  requestIncrements,
} from "../metrics/statsd-adapter.js";

async function receiver() {
  const socket = dgram.createSocket("udp4");
  const packets = [];
  socket.on("message", (msg) => packets.push(msg.toString()));
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { socket, packets, port: socket.address().port };
}

const waitFor = async (condition, ms = 2000) => {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("sends exactly the statsd counters, and nothing about accounts or operations", async () => {
  const { socket, packets, port } = await receiver();
  const metrics = createStatsdMetrics({ host: "127.0.0.1", port, prefix: "arvault.exchange" });

  metrics.start(["ARS", "USD", "EUR", "BRL"]);
  await waitFor(() => packets.length >= 10);
  const seed = packets.splice(0);

  metrics.exchangeCompleted({
    baseCurrency: "ARS",
    counterCurrency: "USD",
    baseAmount: 1000,
    counterAmount: 0.66,
    //things the adapter must never send
    id: "op-secret-id",
    baseAccountId: "acct-4242",
  });
  metrics.exchangeRejected();
  await waitFor(() => packets.length >= 4);

  metrics.close();
  socket.close();

  assert.deepEqual(seed.sort(), [
    "arvault.exchange.compras.ARS:0|c",
    "arvault.exchange.compras.BRL:0|c",
    "arvault.exchange.compras.EUR:0|c",
    "arvault.exchange.compras.USD:0|c",
    "arvault.exchange.operaciones.ok:0|c",
    "arvault.exchange.operaciones.rechazadas:0|c",
    "arvault.exchange.ventas.ARS:0|c",
    "arvault.exchange.ventas.BRL:0|c",
    "arvault.exchange.ventas.EUR:0|c",
    "arvault.exchange.ventas.USD:0|c",
  ]);
  assert.deepEqual(packets, [
    "arvault.exchange.compras.ARS:1000|c",
    "arvault.exchange.ventas.USD:0.66|c",
    "arvault.exchange.operaciones.ok:1|c",
    "arvault.exchange.operaciones.rechazadas:1|c",
  ]);
  for (const packet of packets) {
    assert.ok(!packet.includes("secret") && !packet.includes("4242"), packet);
  }
});

test("small and precise amounts reach statsd without rounding", async () => {
  const { socket, packets, port } = await receiver();
  const metrics = createStatsdMetrics({ host: "127.0.0.1", port, prefix: "arvault.exchange" });

  const counterAmount = 3 * 0.00057;
  metrics.exchangeCompleted({ baseCurrency: "ARS", counterCurrency: "EUR", baseAmount: 3, counterAmount });
  await waitFor(() => packets.length >= 3);
  metrics.close();
  socket.close();

  const sent = packets.find((p) => p.startsWith("arvault.exchange.ventas.EUR:"));
  assert.equal(Number(sent.split(":")[1].split("|")[0]), counterAmount);
});

test("when statsd can not be reached it pauses, drops, logs once and retries later", async () => {
  const logs = [];
  const metrics = createStatsdMetrics({
    host: "statsd.invalid",
    port: 8125,
    prefix: "arvault.exchange",
    pauseMs: 300,
    logger: { error: (message) => logs.push(message) },
  });
  const exchange = { baseCurrency: "ARS", counterCurrency: "USD", baseAmount: 1, counterAmount: 1 };

  metrics.exchangeCompleted(exchange);
  await waitFor(() => logs.length >= 1, 5000);
  for (let i = 0; i < 50; i++) {
    metrics.exchangeCompleted(exchange);
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /pausing/);

  await new Promise((resolve) => setTimeout(resolve, 700));
  metrics.exchangeCompleted(exchange);
  metrics.close();

  assert.match(logs[1], /150 increments dropped/);
});

test("an exchange with an amount that is not a number is not sent, and is logged", async () => {
  const { socket, packets, port } = await receiver();
  const logs = [];
  const metrics = createStatsdMetrics({ host: "127.0.0.1", port, prefix: "arvault.exchange", logger: { error: (m) => logs.push(m) } });

  metrics.exchangeCompleted({ baseCurrency: "ARS", counterCurrency: "USD", baseAmount: "1000", counterAmount: 0.66 });
  metrics.exchangeCompleted({ baseCurrency: "ARS", counterCurrency: "USD", baseAmount: "1000", counterAmount: 0.66 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  metrics.close();
  socket.close();

  assert.deepEqual(packets, []);
  assert.equal(logs.length, 1);
});

test("each request goes as a timer by route and a counter by response code", async () => {
  const { socket, packets, port } = await receiver();
  const metrics = createStatsdMetrics({ host: "127.0.0.1", port, prefix: "arvault.exchange" });

  metrics.requestFinished({ method: "POST", route: "/exchange", status: 200, ms: 612 });
  await waitFor(() => packets.length >= 2);
  metrics.close();
  socket.close();

  assert.deepEqual(packets, ["arvault.exchange.http.POST.exchange:612|ms", "arvault.exchange.http.respuestas.200:1|c"]);
});

test("a completed exchange is a purchase of the base currency and a sale of the counter currency", () => {
  const counterAmount = 1000 * 0.00066;

  const increments = completedIncrements({
    baseCurrency: "ARS",
    counterCurrency: "USD",
    baseAmount: 1000,
    counterAmount,
  });

  assert.deepEqual(increments, [
    { name: "compras.ARS", value: 1000 },
    { name: "ventas.USD", value: counterAmount },
    { name: "operaciones.ok", value: 1 },
  ]);
});

test("a rejected exchange only counts the operation", () => {
  assert.deepEqual(rejectedIncrements(), [{ name: "operaciones.rechazadas", value: 1 }]);
});

test("the seed has a zero for every currency and operation counter", () => {
  assert.deepEqual(seedIncrements(["ARS", "USD"]), [
    { name: "compras.ARS", value: 0 },
    { name: "ventas.ARS", value: 0 },
    { name: "compras.USD", value: 0 },
    { name: "ventas.USD", value: 0 },
    { name: "operaciones.ok", value: 0 },
    { name: "operaciones.rechazadas", value: 0 },
  ]);
});

test("amounts that are not finite numbers are not turned into increments", () => {
  for (const baseAmount of ["1000", NaN, Infinity, undefined]) {
    assert.throws(
      () => completedIncrements({ baseCurrency: "ARS", counterCurrency: "USD", baseAmount, counterAmount: 1 }),
    );
  }
});

test("currencies that are not three letter codes do not become metric names", () => {
  for (const baseCurrency of ["ars", "AR.S", "ARS.x", "", undefined]) {
    assert.throws(
      () => completedIncrements({ baseCurrency, counterCurrency: "USD", baseAmount: 1, counterAmount: 1 }),
    );
  }
});

test("a request is a timing by route and a count by response code", () => {
  assert.deepEqual(requestIncrements({ method: "POST", route: "/exchange", status: 422, ms: 612.4 }), [
    { name: "http.POST.exchange", value: 612.4, timing: true },
    { name: "http.respuestas.422", value: 1 },
  ]);
  assert.equal(requestIncrements({ method: "PUT", route: "/accounts/:id/balance", status: 200, ms: 3 })[0].name, "http.PUT.accounts_id_balance");
  const [timing, count] = requestIncrements({ method: "PROPFIND!", route: undefined, status: 999, ms: NaN });
  assert.deepEqual([timing.name, timing.value, count.name], ["http.OTRO.otra", 0, "http.respuestas.0"]);
});
