//settings read from the environment, the rest of the app only reads this object
export const config = {
  port: process.env.PORT || 3000,
  stateAdapter: process.env.STATE_ADAPTER || "file",
  stateDir: process.env.STATE_DIR || `${import.meta.dirname}/state`,
  redisUrl: process.env.REDIS_URL,
};
