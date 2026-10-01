export function createNullMetrics() {
  return {
    start() {},
    close() {},
    exchangeCompleted() {},
    exchangeRejected() {},
    requestFinished() {},
  };
}
