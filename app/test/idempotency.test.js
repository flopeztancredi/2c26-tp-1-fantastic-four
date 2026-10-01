import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createIdempotencyMiddleware, createMemoryStore } from "../idempotency.js";

//counts how many times the handler ran
function startApp(t, options, gate) {
  const app = express();
  let calls = 0;

  app.use(express.json());
  app.post("/exchange", createIdempotencyMiddleware({ store: createMemoryStore(options), ...options }), async (req, res) => {
    calls++;
    await gate;
    res.json({ calls });
  });

  const server = app.listen(0);
  t.after(() => server.close());

  const post = (key, body = { baseAmount: 1 }) =>
    fetch(`http://localhost:${server.address().port}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key && { "idempotency-key": key }) },
      body: JSON.stringify(body),
    });

  return { post, calls: () => calls };
}

test("without a key every request runs", async (t) => {
  const app = startApp(t);

  await app.post();
  await app.post();

  assert.equal(app.calls(), 2);
});

test("same key and body returns the saved response without running again", async (t) => {
  const app = startApp(t);

  const first = await app.post("k1");
  const retry = await app.post("k1");

  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), await first.json());
  assert.equal(app.calls(), 1);
});

test("same key with another body is 422", async (t) => {
  const app = startApp(t);

  await app.post("k1", { baseAmount: 1 });
  const other = await app.post("k1", { baseAmount: 2 });

  assert.equal(other.status, 422);
  assert.equal(app.calls(), 1);
});

test("same key while the first request is running is 409", async (t) => {
  let release;
  const app = startApp(t, {}, new Promise((resolve) => (release = resolve)));

  const first = app.post("k1");
  while (app.calls() == 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal((await app.post("k1")).status, 409);

  release();
  assert.equal((await first).status, 200);
});

test("an expired key runs again", async (t) => {
  const app = startApp(t, { ttlMs: 1 });

  await app.post("k1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await app.post("k1");

  assert.equal(app.calls(), 2);
});

test("over maxKeys the oldest key is forgotten", async (t) => {
  const app = startApp(t, { maxKeys: 2 });

  await app.post("k1");
  await app.post("k2");
  await app.post("k3");
  await app.post("k1");

  assert.equal(app.calls(), 4);
});

test("a key longer than 255 characters is 400", async (t) => {
  const app = startApp(t);

  assert.equal((await app.post("a".repeat(256))).status, 400);
  assert.equal(app.calls(), 0);
});

test("with redis a key reserved by one replica is seen by another", { skip: !process.env.REDIS_URL && "REDIS_URL is not set" }, async () => {
  const { createRedisStore } = await import("../idempotency.js");
  const replica1 = await createRedisStore(process.env.REDIS_URL);
  const replica2 = await createRedisStore(process.env.REDIS_URL);
  const key = `test-${process.pid}`;

  assert.equal(await replica1.reserve(key, { body: "{}" }, 1000), null);
  assert.deepEqual(await replica2.reserve(key, { body: "{}" }, 1000), { body: "{}" });

  await replica1.close();
  await replica2.close();
});
