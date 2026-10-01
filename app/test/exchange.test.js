// unit tests for exchange.js, with the repository replaced by an in-memory fake

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeRepository } from "./helpers/fake-repository.js";

import * as exchange from "../exchange.js";
import { InsufficientFundsError } from "../errors.js";

//initializes exchange.js with a fresh in-memory repository
function loadExchange() {
  const { repository, state } = createFakeRepository({
    accounts: [
      { id: 1, currency: "ARS", balance: 1_000_000 },
      { id: 2, currency: "USD", balance: 500 },
      { id: 3, currency: "EUR", balance: 500 },
      { id: 4, currency: "BRL", balance: 500 },
    ],
    //1:1 rates, so counterAmount equals baseAmount
    rates: {
      ARS: { USD: 1, EUR: 1, BRL: 1 },
      USD: { ARS: 1 },
      EUR: { ARS: 1 },
      BRL: { ARS: 1 },
    },
  });

  exchange.init(repository, { exchangeCompleted() {}, exchangeRejected() {} });

  return { exchange, state };
}

function balanceOf(state, currency) {
  return state.accounts.find((account) => account.currency == currency).balance;
}

test("exchange updates both balances and logs it", async (t) => {
  const { exchange, state } = loadExchange();

  const result = await exchange.exchange({
    baseCurrency: "ARS",
    counterCurrency: "USD",
    baseAccountId: 111,
    counterAccountId: 222,
    baseAmount: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.counterAmount, 100);
  assert.equal(result.obs, null);
  assert.equal(balanceOf(state, "ARS"), 1_000_100);
  assert.equal(balanceOf(state, "USD"), 400);

  const log = await exchange.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].id, result.id);
});

test("exchange without enough funds changes nothing", async (t) => {
  const { exchange, state } = loadExchange();

  await assert.rejects(
    exchange.exchange({
      baseCurrency: "ARS",
      counterCurrency: "USD",
      baseAccountId: 111,
      counterAccountId: 222,
      baseAmount: 1000,
    }),
    InsufficientFundsError
  );
  assert.equal(balanceOf(state, "ARS"), 1_000_000);
  assert.equal(balanceOf(state, "USD"), 500);
});

test("concurrent exchanges never overdraw an account", async (t) => {
  const { exchange, state } = loadExchange();

  //USD has 500, so only 5 of these 10 fit
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      exchange.exchange({
        baseCurrency: "ARS",
        counterCurrency: "USD",
        baseAccountId: 1000 + i,
        counterAccountId: 2000 + i,
        baseAmount: 100,
      })
    )
  );

  assert.equal(results.filter((result) => result.status == "fulfilled").length, 5);
  assert.equal(balanceOf(state, "USD"), 0);
});

test("setRate also sets the reciprocal rate", async (t) => {
  const { exchange, state } = loadExchange();

  await exchange.setRate({ baseCurrency: "USD", counterCurrency: "ARS", rate: 1500 });

  assert.equal(state.rates.USD.ARS, 1500);
  assert.equal(state.rates.ARS.USD, 1 / 1500);
});
