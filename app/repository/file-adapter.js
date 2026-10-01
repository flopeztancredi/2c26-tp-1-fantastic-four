// file adapter: accounts and rates in memory saved periodically to json, the log appended to log.jsonl

import path from "path";
import fs from "fs";

import { assertReciprocal } from "../rates.js";
import { linkHash } from "../chain.js";

//tests pass persist false so they do not write the state files
export async function createFileAdapter({ dir, persist = true }) {
  const accountsFile = path.join(dir, "accounts.json");
  const ratesFile = path.join(dir, "rates.json");
  const logFile = path.join(dir, "log.jsonl");
  const auditFile = path.join(dir, "audit.jsonl");

  const accounts = await load(accountsFile);
  const rates = await load(ratesFile);
  assertReciprocal(rates, ratesFile);
  await migrateLegacyLog(path.join(dir, "log.json"), logFile);

  const lastHash = {
    [logFile]: (await loadLog(logFile)).at(-1)?.hash ?? "",
    [auditFile]: (await loadLog(auditFile)).at(-1)?.hash ?? "",
  };

  //sync, so the lines stay in the order of their hashes
  function appendChained(filePath, entry) {
    const prev = lastHash[filePath];
    const hash = linkHash(prev, entry);

    fs.appendFileSync(filePath, JSON.stringify({ ...entry, prev, hash }) + "\n");
    lastHash[filePath] = hash;
  }

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

    //the audit entry is written first: without it there is no change
    async setAccountBalance(accountId, balance, audit) {
      appendChained(auditFile, audit);
      findAccountById(accounts, accountId).balance = balance;
    },

    async getRates() {
      return rates;
    },

    async setRate({ baseCurrency, counterCurrency, rate }, audit) {
      appendChained(auditFile, audit);
      rates[baseCurrency][counterCurrency] = rate;
      rates[counterCurrency][baseCurrency] = 1 / rate;
    },

    async getLog() {
      return loadLog(logFile);
    },

    async appendLog(entry) {
      appendChained(logFile, entry);
    },

    async getAudit() {
      return loadLog(auditFile);
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

//an unreadable state file stops the api: better than serving without it
async function load(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (err) {
    throw new Error(`cannot load ${filePath}: ${err.message}`);
  }
}

//a line cut by a crash is skipped with a warning instead of losing the whole log
async function loadLog(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const entries = [];

  for (const line of (await fs.promises.readFile(filePath, "utf8")).split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      console.error(`${filePath}: skipped an unreadable line`);
    }
  }

  return entries;
}

async function migrateLegacyLog(legacyPath, logPath) {
  if (fs.existsSync(logPath) || !fs.existsSync(legacyPath)) {
    return;
  }

  const entries = JSON.parse(await fs.promises.readFile(legacyPath, "utf8"));
  await fs.promises.writeFile(logPath, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
}

//writes a temp file and renames it, so a crash never leaves a half written file
async function save(data, filePath) {
  try {
    await fs.promises.writeFile(`${filePath}.tmp`, JSON.stringify(data, null, 2));
    await fs.promises.rename(`${filePath}.tmp`, filePath);
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err);
  }
}
