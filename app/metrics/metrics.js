//an error in the metrics adapter never reaches the exchange
export function neverThrow(adapter, onError) {
  const guard = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      try {
        onError(err);
      } catch {
      }
    }
  };

  return {
    exchangeCompleted: guard((exchange) => adapter.exchangeCompleted(exchange)),
    exchangeRejected: guard(() => adapter.exchangeRejected()),
    requestFinished: guard((request) => adapter.requestFinished?.(request)),
  };
}
