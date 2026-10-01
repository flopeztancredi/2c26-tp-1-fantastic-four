import { test } from "node:test";
import assert from "node:assert/strict";

const RATES = { ARS: { USD: 0.001 }, USD: { ARS: 1000 } };
const REQUEST = { baseCurrency: "ARS", counterCurrency: "USD", baseAmount: 5000, baseAccountId: 101, counterAccountId: 102 };

let instance = 0;

//exchange.js with state.js mocked, so the tests never touch app/state
async function loadExchange(t, accounts) {
  t.mock.module("../state.js", {
    namedExports: {
      init: async () => {},
      getAccounts: () => accounts,
      getRates: () => RATES,
      getLog: () => [],
    },
  });

  const exchange = await import(`../exchange.js?instance=${instance++}`);
  await exchange.init();
  return exchange;
}

test("40 concurrent exchanges against funds for 20: 20 approved and the balance ends at 0", async (t) => {
  const usd = { id: 2, currency: "USD", balance: 100 };
  const { exchange } = await loadExchange(t, [{ id: 1, currency: "ARS", balance: 100000000 }, usd]);

  const results = await Promise.all(Array.from({ length: 40 }, () => exchange(REQUEST)));

  assert.equal(results.filter((r) => r.ok).length, 20);
  assert.equal(usd.balance, 0);
});

test("without enough funds nothing changes", async (t) => {
  const ars = { id: 1, currency: "ARS", balance: 100000000 };
  const usd = { id: 2, currency: "USD", balance: 3 };
  const { exchange } = await loadExchange(t, [ars, usd]);

  const result = await exchange(REQUEST);

  assert.equal(result.ok, false);
  assert.equal(usd.balance, 3);
  assert.equal(ars.balance, 100000000);
});
