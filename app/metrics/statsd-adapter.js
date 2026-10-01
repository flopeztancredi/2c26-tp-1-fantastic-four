import StatsD from "hot-shots";

//net per currency is compras - ventas, from arVault's side
export function createStatsdMetrics({
  host,
  port,
  prefix,
  pauseMs = 10000,
  seedEveryMs = 60000,
  logger = console,
}) {
  let pausedUntil = 0;
  let dropped = 0;
  let seedTimer = null;
  let currencies = [];
  let lastLog = 0;

  const client = new StatsD({
    host,
    port,
    prefix, //hot-shots adds the dot
    protocol: "udp",
    cacheDns: true,
    //no buffer: a crash would lose what is buffered
    maxBufferSize: 0,
    aggregation: false,
    errorHandler: onSendError,
  });

  //after a send error stop sending for a while, so a dead statsd does not slow the api
  function onSendError(err) {
    if (Date.now() >= pausedUntil) {
      logger.error(`metrics: statsd send failed (${err.code ?? err.message}), pausing for ${pauseMs} ms`);
    }
    pausedUntil = Date.now() + pauseMs;
  }

  function send(increments) {
    if (Date.now() < pausedUntil) {
      dropped += increments.length;
      return;
    }
    if (pausedUntil != 0) {
      logger.error(`metrics: retrying statsd, ${dropped} increments dropped while paused`);
      pausedUntil = 0;
      dropped = 0;
    }
    for (const { name, value, timing } of increments) {
      if (timing) {
        client.timing(name, value);
      } else {
        client.increment(name, value);
      }
    }
  }

  function logLimited(message) {
    const now = Date.now();
    if (now - lastLog >= pauseMs) {
      lastLog = now;
      logger.error(message);
    }
  }

  //zeros now and then keep every currency series alive in graphite
  function seed() {
    send(seedIncrements(currencies));
  }

  return {
    start(accountCurrencies) {
      currencies = [...accountCurrencies];
      seed();
      seedTimer = setInterval(seed, seedEveryMs);
      seedTimer.unref();
    },

    close() {
      clearInterval(seedTimer);
      client.close();
    },

    exchangeCompleted(exchange) {
      let increments;
      try {
        increments = completedIncrements(exchange);
      } catch (err) {
        logLimited(`metrics: exchange not reported, ${err.message}`);
        return;
      }
      send(increments);
    },

    exchangeRejected() {
      send(rejectedIncrements());
    },

    requestFinished(request) {
      send(requestIncrements(request));
    },
  };
}

const CURRENCY = /^[A-Z]{3}$/;

export function completedIncrements({ baseCurrency, counterCurrency, baseAmount, counterAmount }) {
  checkCurrency(baseCurrency);
  checkCurrency(counterCurrency);
  checkAmount(baseAmount);
  checkAmount(counterAmount);

  return [
    { name: `compras.${baseCurrency}`, value: baseAmount },
    { name: `ventas.${counterCurrency}`, value: counterAmount },
    { name: "operaciones.ok", value: 1 },
  ];
}

export function rejectedIncrements() {
  return [{ name: "operaciones.rechazadas", value: 1 }];
}

export function seedIncrements(currencies) {
  currencies.forEach(checkCurrency);

  return [
    ...currencies.flatMap((currency) => [
      { name: `compras.${currency}`, value: 0 },
      { name: `ventas.${currency}`, value: 0 },
    ]),
    { name: "operaciones.ok", value: 0 },
    { name: "operaciones.rechazadas", value: 0 },
  ];
}

//the currency goes into the metric name, so only 3 letter codes
function checkCurrency(currency) {
  if (typeof currency != "string" || !CURRENCY.test(currency)) {
    throw new Error(`invalid currency ${JSON.stringify(currency)}`);
  }
}

function checkAmount(amount) {
  if (typeof amount != "number" || !Number.isFinite(amount)) {
    throw new Error(`invalid amount ${JSON.stringify(amount)}`);
  }
}

export function requestIncrements({ method, route, status, ms }) {
  const name = String(route ?? "otra").replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "_") || "raiz";
  const verb = /^[A-Z]{3,7}$/.test(method) ? method : "OTRO";
  const code = Number.isInteger(status) && status >= 100 && status < 600 ? status : 0;
  return [
    { name: `http.${verb}.${name}`, value: Number.isFinite(ms) ? ms : 0, timing: true },
    { name: `http.respuestas.${code}`, value: 1 },
  ];
}
