export const config = {
  stateAdapter: process.env.STATE_ADAPTER || "file",
  redisUrl: process.env.REDIS_URL,
};
