// in-memory fake of the repository port, for exchange.test.js

export function createFakeRepository({ accounts, rates }) {
  const log = [];
  const audit = [];

  function findById(accountId) {
    return accounts.find((account) => account.id == accountId);
  }

  const repository = {
    async findAccountByCurrency(currency) {
      return accounts.find((account) => account.currency == currency);
    },

    async getRates() {
      return rates;
    },

    async setRate({ baseCurrency, counterCurrency, rate }, auditEntry) {
      audit.push(auditEntry);
      rates[baseCurrency][counterCurrency] = rate;
      rates[counterCurrency][baseCurrency] = 1 / rate;
    },

    async getLog() {
      return log;
    },

    async appendLog(entry) {
      log.push(entry);
    },

    //no await between check and discount, same as the file adapter
    async reserveBalance(accountId, amount) {
      const account = findById(accountId);

      if (account.balance < amount) {
        return false;
      }

      account.balance -= amount;
      return true;
    },

    async creditBalance(accountId, amount) {
      const account = findById(accountId);

      account.balance += amount;
    },
  };

  return { repository, state: { accounts, rates, log, audit } };
}
