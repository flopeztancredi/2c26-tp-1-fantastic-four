// redis adapter: balances and currencies in two hashes, rates in a hash, log in a stream

import { createClient } from "redis";
import path from "path";
import fs from "fs";

const RESERVE_SCRIPT = `
local balance = tonumber(redis.call("HGET", KEYS[1], ARGV[1]))

if balance < tonumber(ARGV[2]) then
  return 0
end

redis.call("HINCRBYFLOAT", KEYS[1], ARGV[1], "-" .. ARGV[2])
return 1
`;

export async function createRedisAdapter(url) {
  const client = createClient({ url });
  client.on("error", (err) => console.error("Redis error:", err));

  await client.connect();
  await seed(client);

  async function getAccounts() {
    const [balances, currencies] = await Promise.all([
      client.hGetAll("balances"),
      client.hGetAll("currencies"),
    ]);

    return Object.keys(currencies).map((id) => ({
      id: Number(id),
      currency: currencies[id],
      balance: Number(balances[id]),
    }));
  }

  return {
    getAccounts,

    async findAccountByCurrency(currency) {
      const accounts = await getAccounts();
      return accounts.find((account) => account.currency == currency);
    },

    async setAccountBalance(accountId, balance, audit) {
      await client
        .multi()
        .hSet("balances", String(accountId), String(balance))
        .xAdd("audit", "*", { data: JSON.stringify(audit) })
        .exec();
    },

    async getRates() {
      const pairs = await client.hGetAll("rates");
      const rates = {};

      for (const [pair, rate] of Object.entries(pairs)) {
        const [base, counter] = pair.split(":");
        rates[base] ??= {};
        rates[base][counter] = Number(rate);
      }

      return rates;
    },

    async setRate({ baseCurrency, counterCurrency, rate }, audit) {
      await client
        .multi()
        .hSet("rates", {
          [`${baseCurrency}:${counterCurrency}`]: String(rate),
          [`${counterCurrency}:${baseCurrency}`]: String(Number((1 / rate).toFixed(5))),
        })
        .xAdd("audit", "*", { data: JSON.stringify(audit) })
        .exec();
    },

    async getLog() {
      const entries = await client.xRange("log", "-", "+");
      return entries.map((entry) => JSON.parse(entry.message.data));
    },

    async getAudit() {
      const entries = await client.xRange("audit", "-", "+");
      return entries.map((entry) => JSON.parse(entry.message.data));
    },

    async appendLog(entry) {
      await client.xAdd("log", "*", { data: JSON.stringify(entry) });
    },

    async reserveBalance(accountId, amount) {
      const reserved = await client.eval(RESERVE_SCRIPT, {
        keys: ["balances"],
        arguments: [String(accountId), String(amount)],
      });

      return reserved == 1;
    },

    async creditBalance(accountId, amount) {
      await client.hIncrByFloat("balances", String(accountId), amount);
    },

    async ping() {
      return (await client.ping()) == "PONG";
    },

    async close() {
      await client.quit();
    },
  };
}

//loads accounts and rates from app/state into redis the first time, SET NX so only one replica does it
async function seed(client) {
  if (!(await client.set("seeded", "1", { NX: true }))) {
    return;
  }

  const accounts = readState("accounts.json");
  const rates = readState("rates.json");
  const multi = client.multi();

  for (const account of accounts) {
    multi.hSet("balances", String(account.id), String(account.balance));
    multi.hSet("currencies", String(account.id), account.currency);
  }

  for (const base in rates) {
    for (const counter in rates[base]) {
      multi.hSet("rates", `${base}:${counter}`, String(rates[base][counter]));
    }
  }

  await multi.exec();
}

function readState(fileName) {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../state", fileName), "utf8"));
}
