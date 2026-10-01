//not enough funds on our counter account, answered with 422 in app.js
export class InsufficientFundsError extends Error {
  constructor(exchangeResult) {
    super(exchangeResult.obs);
    this.exchangeResult = exchangeResult;
  }
}
