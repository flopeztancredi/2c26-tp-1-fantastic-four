import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let server;
let baseUrl;
let stateDir;

before(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "arvault-validation-"));
  await cp(path.join(import.meta.dirname, "../state"), stateDir, { recursive: true });
  process.env.STATE_DIR = stateDir;
  process.env.PORT = "0";

  ({ server } = await import("../app.js"));
  if (!server.listening) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(stateDir, { recursive: true, force: true });
});

function send(method, path, body) {
  return fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body == "string" ? body : JSON.stringify(body),
  });
}

const exchangeRequest = (changes) => ({
  baseCurrency: "ARS",
  counterCurrency: "USD",
  baseAmount: 1000,
  baseAccountId: 101,
  counterAccountId: 102,
  ...changes,
});

test("an unknown currency is 400 and the api keeps answering", async () => {
  assert.equal((await send("POST", "/exchange", exchangeRequest({ baseCurrency: "GBP" }))).status, 400);
  assert.equal((await send("GET", "/rates")).status, 200);
});

test("a negative or non numeric amount is 400", async () => {
  assert.equal((await send("POST", "/exchange", exchangeRequest({ baseAmount: -5 }))).status, 400);
  assert.equal((await send("POST", "/exchange", exchangeRequest({ baseAmount: "100" }))).status, 400);
});

test("not enough funds is 422", async () => {
  assert.equal((await send("POST", "/exchange", exchangeRequest({ baseAmount: 1e12 }))).status, 422);
});

test("a rate for an unknown currency is 400", async () => {
  assert.equal((await send("PUT", "/rates", { baseCurrency: "XYZ", counterCurrency: "ARS", rate: 2 })).status, 400);
  assert.equal((await (await send("GET", "/rates")).json()).XYZ, undefined);
});

test("an unknown account is 404", async () => {
  assert.equal((await send("PUT", "/accounts/99/balance", { balance: 5 })).status, 404);
});

test("malformed json is 400", async () => {
  assert.equal((await send("POST", "/exchange", "{")).status, 400);
});
