//a retry with the same Idempotency-Key gets the saved response instead of running again
import { createClient } from "redis";

export function createIdempotencyMiddleware({ store, ttlMs = 10 * 60 * 1000, leaseMs = 30 * 1000 }) {
  return async (req, res, next) => {
    const key = req.get("Idempotency-Key");

    if (!key) {
      return next();
    }

    if (key.length > 255) {
      return res.status(400).json({ error: "Idempotency-Key too long" });
    }

    const body = JSON.stringify(req.body);
    const saved = await store.reserve(key, { body }, leaseMs);

    if (saved) {
      if (saved.body != body) {
        return res.status(422).json({ error: "Idempotency-Key already used with another body" });
      }

      if (!saved.response) {
        return res.status(409).set("Retry-After", "1").json({ error: "A request with this Idempotency-Key is still running" });
      }

      return res.status(saved.response.status).json(saved.response.body);
    }

    const json = res.json.bind(res);
    res.json = (responseBody) => {
      store
        .complete(key, { body, response: { status: res.statusCode, body: responseBody } }, ttlMs)
        .catch((err) => console.error(`could not save Idempotency-Key ${key}:`, err))
        .finally(() => json(responseBody));
      return res;
    };

    next();
  };
}

export function createMemoryStore({ maxKeys = 30000 } = {}) {
  const requests = new Map();

  return {
    async reserve(key, entry, leaseMs) {
      const saved = requests.get(key);

      if (saved && saved.expiresAt > Date.now()) {
        return saved;
      }

      requests.delete(key);

      if (requests.size >= maxKeys) {
        requests.delete(requests.keys().next().value);
      }

      requests.set(key, { ...entry, expiresAt: Date.now() + leaseMs });
      return null;
    },

    async complete(key, entry, ttlMs) {
      requests.set(key, { ...entry, expiresAt: Date.now() + ttlMs });
    },

    async close() {},
  };
}

const RESERVE_SCRIPT = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return false
end
return redis.call("GET", KEYS[1])
`;

export async function createRedisStore(url) {
  const client = createClient({ url });
  client.on("error", (err) => console.error("Redis error:", err));
  await client.connect();

  return {
    async reserve(key, entry, leaseMs) {
      const saved = await client.eval(RESERVE_SCRIPT, {
        keys: [`idem:${key}`],
        arguments: [JSON.stringify(entry), String(leaseMs)],
      });

      return saved == null ? null : JSON.parse(saved);
    },

    async complete(key, entry, ttlMs) {
      await client.set(`idem:${key}`, JSON.stringify(entry), { PX: ttlMs });
    },

    async close() {
      await client.quit();
    },
  };
}
