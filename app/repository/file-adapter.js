// file adapter: state in memory and saved periodically to the json files

import path from "path";
import fs from "fs";

const ACCOUNTS = "../state/accounts.json";
const RATES = "../state/rates.json";
const LOG = "../state/log.json";

//tests pass persist false so they do not write the state files
export async function createFileAdapter({ persist = true } = {}) {
  const accounts = await load(ACCOUNTS);
  const rates = await load(RATES);
  const log = await load(LOG);

  if (persist) {
    scheduleSave(accounts, ACCOUNTS, 1000);
    scheduleSave(rates, RATES, 5000);
    scheduleSave(log, LOG, 1000);
  }

  return {
    async getAccounts() {
      return accounts;
    },

    async findAccountByCurrency(currency) {
      for (let account of accounts) {
        if (account.currency == currency) {
          return account;
        }
      }

      return null;
    },

    async setAccountBalance(accountId, balance) {
      const account = findAccountById(accounts, accountId);

      if (account != null) {
        account.balance = balance;
      }
    },

    async getRates() {
      return rates;
    },

    async setRate({ baseCurrency, counterCurrency, rate }) {
      rates[baseCurrency][counterCurrency] = rate;
      rates[counterCurrency][baseCurrency] = Number((1 / rate).toFixed(5));
    },

    async getLog() {
      return log;
    },

    async appendLog(entry) {
      log.push(entry);
    },

    //no await inside: node runs it whole, so check and discount are atomic
    async reserveBalance(accountId, amount) {
      const account = findAccountById(accounts, accountId);

      if (account.balance < amount) {
        return false;
      }

      account.balance -= amount;
      return true;
    },

    async creditBalance(accountId, amount) {
      const account = findAccountById(accounts, accountId);

      account.balance += amount;
    },
  };
}

//sync on purpose, reserveBalance cannot await in the middle
function findAccountById(accounts, id) {
  for (let account of accounts) {
    if (account.id == id) {
      return account;
    }
  }

  return null;
}

async function load(fileName) {
  const filePath = path.join(import.meta.dirname, fileName);

  try {
    await fs.promises.access(filePath);
    const raw = await fs.promises.readFile(filePath, "utf8");

    return JSON.parse(raw);
  } catch (err) {
    if (err.code == "ENOENT") {
      console.error(`${filePath} not found`);
    } else {
      console.error(`Error loading ${filePath}:`, err);
    }
  }
}

async function save(data, fileName) {
  const filePath = path.join(import.meta.dirname, fileName);
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err);
  }
}

function scheduleSave(data, fileName, period) {
  setInterval(async () => {
    await save(data, fileName);
  }, period);
}
