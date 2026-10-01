// tests for the redis adapter, skipped unless REDIS_URL is set
// they run FLUSHDB: point REDIS_URL at a disposable redis, never at one with data you care about

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "redis";

import { createRedisAdapter } from "../repository/redis-adapter.js";

const skip = !process.env.REDIS_URL && "REDIS_URL is not set";

//empties redis, so the next adapter seeds it again
async function flushRedis() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  await client.flushDb();
  await client.quit();
}

async function adapterFor(t) {
  const adapter = await createRedisAdapter(process.env.REDIS_URL);
  t.after(() => adapter.stop());
  return adapter;
}

test("seeds accounts, rates and log from app/state", { skip }, async (t) => {
  await flushRedis();
  const adapter = await adapterFor(t);

  const accounts = await adapter.getAccounts();
  assert.deepEqual(accounts.map((a) => a.currency).sort(), ["ARS", "BRL", "EUR", "USD"]);

  const rates = await adapter.getRates();
  assert.equal(typeof rates.ARS.USD, "number");
  assert.equal(typeof rates.USD.ARS, "number");

  assert.deepEqual(await adapter.getLog(), []);
});

test("a second adapter does not seed again", { skip }, async (t) => {
  await flushRedis();
  const first = await adapterFor(t);

  const usd = await first.findAccountByCurrency("USD");
  await first.reserveBalance(usd.id, 1);

  const second = await adapterFor(t);
  assert.equal((await second.findAccountByCurrency("USD")).balance, usd.balance - 1);
});

test("reserveBalance discounts only when there is enough", { skip }, async (t) => {
  await flushRedis();
  const adapter = await adapterFor(t);

  const usd = await adapter.findAccountByCurrency("USD");

  assert.equal(await adapter.reserveBalance(usd.id, 100.5), true);
  assert.equal(await adapter.reserveBalance(usd.id, usd.balance * 10), false);
  assert.equal((await adapter.findAccountByCurrency("USD")).balance, usd.balance - 100.5);
});

test("creditBalance gives back a reservation", { skip }, async (t) => {
  await flushRedis();
  const adapter = await adapterFor(t);

  const eur = await adapter.findAccountByCurrency("EUR");
  await adapter.reserveBalance(eur.id, 50);
  await adapter.creditBalance(eur.id, 50);

  assert.equal((await adapter.findAccountByCurrency("EUR")).balance, eur.balance);
});

test("concurrent reservations from separate connections never go negative", { skip }, async (t) => {
  await flushRedis();
  const adapter = await adapterFor(t);

  //BRL has 60000, so only 6 of these 12 fit
  const brl = await adapter.findAccountByCurrency("BRL");

  //one adapter (one connection) per replica
  const replicas = await Promise.all(Array.from({ length: 12 }, () => adapterFor(t)));
  const results = await Promise.all(replicas.map((r) => r.reserveBalance(brl.id, 10_000)));

  assert.equal(results.filter(Boolean).length, 6);
  assert.equal((await adapter.findAccountByCurrency("BRL")).balance, 0);
});

test("appendLog and getLog keep the order", { skip }, async (t) => {
  await flushRedis();
  const adapter = await adapterFor(t);

  const entryA = { id: "a", ok: true, obs: null };
  const entryB = { id: "b", ok: false, obs: "Not enough funds on counter currency account" };

  await adapter.appendLog(entryA);
  await adapter.appendLog(entryB);

  assert.deepEqual(await adapter.getLog(), [entryA, entryB]);
});

test("setRate also sets the reciprocal rate", { skip }, async (t) => {
  await flushRedis();
  const adapter = await adapterFor(t);

  await adapter.setRate({ baseCurrency: "USD", counterCurrency: "ARS", rate: 1600 });

  const rates = await adapter.getRates();
  assert.equal(rates.USD.ARS, 1600);
  assert.equal(rates.ARS.USD, Number((1 / 1600).toFixed(5)));
});
