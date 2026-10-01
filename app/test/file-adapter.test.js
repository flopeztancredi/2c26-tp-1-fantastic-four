// tests for the file adapter, on the state files without saving them

import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "fs/promises";
import os from "os";
import path from "path";

import { createFileAdapter } from "../repository/file-adapter.js";

test("loads accounts, rates and log", async () => {
  const adapter = await createFileAdapter({ dir: `${import.meta.dirname}/../state`, persist: false });

  const accounts = await adapter.getAccounts();
  assert.deepEqual(accounts.map((a) => a.currency).sort(), ["ARS", "BRL", "EUR", "USD"]);

  const rates = await adapter.getRates();
  assert.equal(typeof rates.ARS.USD, "number");

  assert.deepEqual(await adapter.getLog(), []);
});

test("reserveBalance discounts when there is enough", async () => {
  const adapter = await createFileAdapter({ dir: `${import.meta.dirname}/../state`, persist: false });

  //the adapter returns the live account, so keep its balance before changing it
  const usd = await adapter.findAccountByCurrency("USD");
  const originalBalance = usd.balance;
  assert.equal(await adapter.reserveBalance(usd.id, 100), true);
  assert.equal(usd.balance, originalBalance - 100);
});

test("reserveBalance changes nothing when there is not enough", async () => {
  const adapter = await createFileAdapter({ dir: `${import.meta.dirname}/../state`, persist: false });

  const usd = await adapter.findAccountByCurrency("USD");
  const originalBalance = usd.balance;
  assert.equal(await adapter.reserveBalance(usd.id, originalBalance + 1), false);
  assert.equal(usd.balance, originalBalance);
});

test("creditBalance increases the balance", async () => {
  const adapter = await createFileAdapter({ dir: `${import.meta.dirname}/../state`, persist: false });

  const eur = await adapter.findAccountByCurrency("EUR");
  const originalBalance = eur.balance;
  await adapter.creditBalance(eur.id, 50);

  assert.equal(eur.balance, originalBalance + 50);
});

test("concurrent reservations never go negative", async () => {
  const adapter = await createFileAdapter({ dir: `${import.meta.dirname}/../state`, persist: false });

  //BRL has 60000, so only 6 of these 12 fit
  const brl = await adapter.findAccountByCurrency("BRL");
  const results = await Promise.all(
    Array.from({ length: 12 }, () => adapter.reserveBalance(brl.id, 10_000))
  );

  assert.equal(results.filter(Boolean).length, 6);
  assert.equal(brl.balance, 0);
});

test("an unreadable state file stops the adapter", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arvault-broken-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(`${import.meta.dirname}/../state`, dir, { recursive: true });
  await fs.writeFile(path.join(dir, "accounts.json"), "[{");

  await assert.rejects(createFileAdapter({ dir, persist: false }));
});

test("rates that are not reciprocal stop the adapter", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arvault-rates-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(`${import.meta.dirname}/../state`, dir, { recursive: true });
  await fs.writeFile(path.join(dir, "rates.json"), JSON.stringify({ ARS: { USD: 0.001 }, USD: { ARS: 900 } }));

  await assert.rejects(createFileAdapter({ dir, persist: false }));
});
