// file adapter: accounts and rates in memory saved periodically to json, the log appended to log.jsonl

import path from "path";
import fs from "fs";

//tests pass persist false so they do not write the state files
export async function createFileAdapter({ dir, persist = true }) {
  const accountsFile = path.join(dir, "accounts.json");
  const ratesFile = path.join(dir, "rates.json");
  const logFile = path.join(dir, "log.jsonl");

  const accounts = await load(accountsFile);
  const rates = await load(ratesFile);
  await migrateLegacyLog(path.join(dir, "log.json"), logFile);

  const timers = [];
  const pendingSaves = new Set();

  function trackedSave(data, filePath) {
    const write = save(data, filePath);
    pendingSaves.add(write);
    return write.finally(() => pendingSaves.delete(write));
  }

  if (persist) {
    timers.push(setInterval(() => trackedSave(accounts, accountsFile), 1000).unref());
    timers.push(setInterval(() => trackedSave(rates, ratesFile), 5000).unref());
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
      return loadLog(logFile);
    },

    async appendLog(entry) {
      await fs.promises.appendFile(logFile, JSON.stringify(entry) + "\n");
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

    async ping() {
      return true;
    },

    async close() {
      timers.forEach(clearInterval);

      if (persist) {
        await Promise.all(pendingSaves);
        await Promise.all([save(accounts, accountsFile), save(rates, ratesFile)]);
      }
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

async function load(filePath) {
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

async function loadLog(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code != "ENOENT") {
      console.error(`Error loading ${filePath}:`, err);
    }

    return [];
  }
}

async function migrateLegacyLog(legacyPath, logPath) {
  if (fs.existsSync(logPath) || !fs.existsSync(legacyPath)) {
    return;
  }

  const entries = JSON.parse(await fs.promises.readFile(legacyPath, "utf8"));
  await fs.promises.writeFile(logPath, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
}

async function save(data, filePath) {
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err);
  }
}
