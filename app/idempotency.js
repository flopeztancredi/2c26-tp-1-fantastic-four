//a retry with the same Idempotency-Key gets the saved response instead of running again

export function createIdempotencyMiddleware({ ttlMs = 24 * 60 * 60 * 1000, maxKeys = 30000 } = {}) {
  const requests = new Map();

  return (req, res, next) => {
    const key = req.get("Idempotency-Key");

    if (!key) {
      return next();
    }

    if (key.length > 255) {
      return res.status(400).json({ error: "Idempotency-Key too long" });
    }

    const body = JSON.stringify(req.body);
    const saved = requests.get(key);

    if (saved && saved.expiresAt > Date.now()) {
      if (saved.body != body) {
        return res.status(422).json({ error: "Idempotency-Key already used with another body" });
      }

      if (!saved.response) {
        return res.status(409).json({ error: "A request with this Idempotency-Key is still running" });
      }

      return res.status(saved.response.status).json(saved.response.body);
    }

    requests.delete(key);

    if (requests.size >= maxKeys) {
      requests.delete(requests.keys().next().value);
    }

    const entry = { body, response: null, expiresAt: Date.now() + ttlMs };
    requests.set(key, entry);

    const json = res.json.bind(res);
    res.json = (responseBody) => {
      entry.response = { status: res.statusCode, body: responseBody };
      entry.expiresAt = Date.now() + ttlMs;
      return json(responseBody);
    };

    res.on("close", () => {
      if (!entry.response) {
        requests.delete(key);
      }
    });

    next();
  };
}
