import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let server;
let baseUrl;
let stateDir;

before(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "arvault-audit-"));
  await cp(path.join(import.meta.dirname, "../state"), stateDir, { recursive: true });
  process.env.STATE_DIR = stateDir;
  process.env.PORT = "0";

  ({ server } = await import("../app.js"));
  if (!server.listening) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(stateDir, { recursive: true, force: true });
});

function put(path, body, user) {
  return fetch(baseUrl + path, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-authenticated-user": user },
    body: JSON.stringify(body),
  });
}

test("each balance and rate change records the actor, the previous value and the new one", async () => {
  await put("/accounts/2/balance", { balance: 1234 }, "admin-fran");
  await put("/rates", { baseCurrency: "USD", counterCurrency: "ARS", rate: 1600 }, "admin-leti");

  const audit = await (await fetch(`${baseUrl}/audit`)).json();

  assert.equal(audit.length, 2);
  assert.equal(audit[0].actor, "admin-fran");
  assert.equal(audit[0].after, 1234);
  assert.equal(audit[1].actor, "admin-leti");
  assert.equal(audit[1].pair, "USD/ARS");
  assert.equal(audit[1].after, 1600);
});
