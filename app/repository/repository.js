/**
 * @typedef {{ id: number, currency: string, balance: number }} Account
 *
 * @typedef {object} Repository
 * @property {() => Promise<Account[]>} getAccounts
 * @property {(currency: string) => Promise<Account | undefined>} findAccountByCurrency
 * @property {(accountId: number, balance: number) => Promise<void>} setAccountBalance
 * @property {() => Promise<Record<string, Record<string, number>>>} getRates
 * @property {(rate: { baseCurrency: string, counterCurrency: string, rate: number }) => Promise<void>} setRate
 * @property {() => Promise<object[]>} getLog
 * @property {(entry: object) => Promise<void>} appendLog
 * @property {(accountId: number, amount: number) => Promise<boolean>} reserveBalance
 * @property {(accountId: number, amount: number) => Promise<void>} creditBalance
 */

export {};
