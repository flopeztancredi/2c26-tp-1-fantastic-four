//settings read from the environment, the rest of the app only reads this object
export const config = {
  port: process.env.PORT || 3000,
  stateAdapter: process.env.STATE_ADAPTER || "file",
  stateDir: process.env.STATE_DIR || `${import.meta.dirname}/state`,
  redisUrl: process.env.REDIS_URL,
  idempotencyTtlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000),
  metricsAdapter: process.env.METRICS_ADAPTER || "null",
  statsdHost: process.env.STATSD_HOST || "graphite",
  statsdPort: Number(process.env.STATSD_PORT || 8125),
  metricsPrefix: process.env.METRICS_PREFIX || "arvault.exchange",
};
