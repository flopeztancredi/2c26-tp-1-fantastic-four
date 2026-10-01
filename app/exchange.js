import { nanoid } from "nanoid";

import { InsufficientFundsError } from "./errors.js";

let repository;
let metrics;

export function init(stateRepository, exchangeMetrics) {
  repository = stateRepository;
  metrics = exchangeMetrics;
}

//returns all internal accounts
export async function getAccounts() {
  return repository.getAccounts();
}

//true if there is an internal account for the currency
export async function isKnownCurrency(currency) {
  return (await repository.findAccountByCurrency(currency)) != null;
}

//true if there is an internal account with that id
export async function isKnownAccount(accountId) {
  const accounts = await repository.getAccounts();
  return accounts.some((account) => account.id == accountId);
}

//true if the pair has a numeric rate and both currencies have an internal account
export async function isSupportedPair(baseCurrency, counterCurrency) {
  const rates = await repository.getRates();
  return (
    (await isKnownCurrency(baseCurrency)) &&
    (await isKnownCurrency(counterCurrency)) &&
    Number.isFinite(rates[baseCurrency]?.[counterCurrency])
  );
}

//sets balance for an account
export async function setAccountBalance(accountId, balance, actor = null) {
  const accounts = await repository.getAccounts();
  const account = accounts.find((account) => account.id == accountId);

  const audit = {
    id: nanoid(),
    ts: new Date(),
    action: "set-balance",
    actor,
    accountId: account.id,
    currency: account.currency,
    before: account.balance,
    after: balance,
  };

  await repository.setAccountBalance(accountId, balance, audit);
}

//returns all current exchange rates
export async function getRates() {
  return repository.getRates();
}

//returns the whole transaction log
export async function getLog() {
  return repository.getLog();
}

//returns who changed balances and rates, and when
export async function getAudit() {
  return repository.getAudit();
}

//sets the exchange rate for a given pair of currencies, and the reciprocal rate as well
export async function setRate(rateRequest, actor = null) {
  const { baseCurrency, counterCurrency, rate } = rateRequest;
  const rates = await repository.getRates();

  const audit = {
    id: nanoid(),
    ts: new Date(),
    action: "set-rate",
    actor,
    pair: `${baseCurrency}/${counterCurrency}`,
    before: rates[baseCurrency]?.[counterCurrency] ?? null,
    after: rate,
  };

  await repository.setRate(rateRequest, audit);
}

//executes an exchange operation
export async function exchange(exchangeRequest, actor = null) {
  const {
    baseCurrency,
    counterCurrency,
    baseAccountId: clientBaseAccountId,
    counterAccountId: clientCounterAccountId,
    baseAmount,
  } = exchangeRequest;

  //get the exchange rate and our accounts on both currencies
  const [rates, baseAccount, counterAccount] = await Promise.all([
    repository.getRates(),
    repository.findAccountByCurrency(baseCurrency),
    repository.findAccountByCurrency(counterCurrency),
  ]);
  const exchangeRate = rates[baseCurrency][counterCurrency];
  //compute the requested (counter) amount
  const counterAmount = baseAmount * exchangeRate;

  //construct the result object with defaults
  const exchangeResult = {
    id: nanoid(),
    ts: new Date(),
    ok: false,
    actor,
    request: exchangeRequest,
    exchangeRate: exchangeRate,
    counterAmount: 0.0,
    obs: null,
  };

  //check and discount funds on the counter currency account
  if (await repository.reserveBalance(counterAccount.id, counterAmount)) {
    //try to transfer from clients' base account
    if (await transfer(clientBaseAccountId, baseAccount.id, baseAmount)) {
      //try to transfer to clients' counter account
      if (
        await transfer(counterAccount.id, clientCounterAccountId, counterAmount)
      ) {
        //all good, credit our base account
        await repository.creditBalance(baseAccount.id, baseAmount);
        exchangeResult.ok = true;
        exchangeResult.counterAmount = counterAmount;
      } else {
        //could not transfer to clients' counter account, return base amount to client
        await transfer(baseAccount.id, clientBaseAccountId, baseAmount);
        //and give back what we reserved
        await repository.creditBalance(counterAccount.id, counterAmount);
        exchangeResult.obs = "Could not transfer to clients' account";
      }
    } else {
      //could not withdraw from clients' account, give back what we reserved
      await repository.creditBalance(counterAccount.id, counterAmount);
      exchangeResult.obs = "Could not withdraw from clients' account";
    }
  } else {
    //not enough funds on internal counter account
    exchangeResult.obs = "Not enough funds on counter currency account";
    await repository.appendLog(exchangeResult);
    metrics.exchangeRejected();
    throw new InsufficientFundsError(exchangeResult);
  }

  //log the transaction and return it
  await repository.appendLog(exchangeResult);

  if (exchangeResult.ok) {
    metrics.exchangeCompleted({ baseCurrency, counterCurrency, baseAmount, counterAmount });
  } else {
    metrics.exchangeRejected();
  }

  return exchangeResult;
}

// internal - call transfer service to execute transfer between accounts
async function transfer(fromAccountId, toAccountId, amount) {
  const min = 200;
  const max = 400;
  return new Promise((resolve) =>
    setTimeout(() => resolve(true), Math.random() * (max - min + 1) + min)
  );
}
