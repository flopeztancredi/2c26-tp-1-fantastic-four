import express from "express";

import {
  init as exchangeInit,
  getAccounts,
  setAccountBalance,
  getRates,
  setRate,
  getLog,
  exchange,
  isKnownCurrency,
  isKnownAccount,
  isSupportedPair,
} from "./exchange.js";
import { saveAll } from "./state.js";
import { InsufficientFundsError } from "./errors.js";

await exchangeInit();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// HEALTH endpoint (ping/echo): answers only while the process is serving requests and the state is loaded

app.get("/health", (req, res) => {
  const ok = getAccounts() != null && getRates() != null;
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "state not loaded", uptime: process.uptime() });
});

// VALIDATION (parameter typing / fence): se rechaza el pedido antes de ejecutar nada,
// indicando el primer campo inválido

const isPositiveNumber = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isCurrencyCode = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const isAccountId = (v) => (typeof v === "string" && v.length > 0) || Number.isInteger(v);

function validateExchange(body) {
  const { baseCurrency, counterCurrency, baseAccountId, counterAccountId, baseAmount } = body;
  if (!isCurrencyCode(baseCurrency)) return "baseCurrency must be a 3-letter currency code";
  if (!isCurrencyCode(counterCurrency)) return "counterCurrency must be a 3-letter currency code";
  if (baseCurrency === counterCurrency) return "baseCurrency and counterCurrency must be different";
  if (!isSupportedPair(baseCurrency, counterCurrency))
    return `exchange ${baseCurrency}->${counterCurrency} is not supported`;
  if (!isPositiveNumber(baseAmount)) return "baseAmount must be a positive number";
  if (!isAccountId(baseAccountId)) return "baseAccountId is required";
  if (!isAccountId(counterAccountId)) return "counterAccountId is required";
  return null;
}

function validateRate(body) {
  const { baseCurrency, counterCurrency, rate } = body;
  if (!isKnownCurrency(baseCurrency)) return "baseCurrency must be a currency with an internal account";
  if (!isKnownCurrency(counterCurrency)) return "counterCurrency must be a currency with an internal account";
  if (baseCurrency === counterCurrency) return "baseCurrency and counterCurrency must be different";
  if (!isPositiveNumber(rate)) return "rate must be a positive number";
  return null;
}

// ACCOUNT endpoints

app.get("/accounts", (req, res) => {
  res.json(getAccounts());
});

app.put("/accounts/:id/balance", (req, res) => {
  const accountId = req.params.id;
  const { balance } = req.body;

  if (!isKnownAccount(accountId)) {
    return res.status(404).json({ error: `account ${accountId} not found` });
  }
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) {
    return res.status(400).json({ error: "balance must be a non-negative number" });
  } else {
    setAccountBalance(accountId, balance);

    res.json(getAccounts());
  }
});

// RATE endpoints

app.get("/rates", (req, res) => {
  res.json(getRates());
});

app.put("/rates", (req, res) => {
  const error = validateRate(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  const newRateRequest = { ...req.body };
  setRate(newRateRequest);

  res.json(getRates());
});

// LOG endpoint

app.get("/log", async (req, res) => {
  res.json(await getLog());
});

// EXCHANGE endpoint

app.post("/exchange", async (req, res, next) => {
  const error = validateExchange(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  // EXCEPTION HANDLING: una excepción en este pedido responde error a este pedido
  // y no termina el proceso (antes, la promesa rechazada sin manejar lo mataba)
  try {
    const exchangeRequest = { ...req.body };
    const exchangeResult = await exchange(exchangeRequest);

    if (exchangeResult.ok) {
      res.status(200).json(exchangeResult);
    } else {
      res.status(500).json(exchangeResult);
    }
  } catch (err) {
    next(err);
  }
});

// errores de cualquier handler: JSON sin stack trace (el detalle queda en el log del servidor)
app.use((err, req, res, next) => {
  if (err instanceof InsufficientFundsError) {
    return res.status(422).json(err.exchangeResult);
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "body must be valid JSON" });
  }
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} failed:`, err);
  res.status(500).json({ error: "internal error" });
});

// red de seguridad: una promesa rechazada fuera de un handler se registra pero no termina el proceso
process.on("unhandledRejection", (err) => {
  console.error(`[${new Date().toISOString()}] unhandled rejection:`, err);
});

const server = app.listen(port, () => {
  console.log(`Exchange API listening on port ${server.address().port}`);
});

//graceful shutdown
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);

  await saveAll();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
export { server };
