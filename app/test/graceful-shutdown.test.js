import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "..");
const SOURCE_STATE_DIR = path.join(APP_DIR, "state");

async function makeTempStateDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "arvault-state-"));
  await cp(SOURCE_STATE_DIR, dir, { recursive: true });
  return dir;
}

function startApp(stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["app.js"], {
      cwd: APP_DIR,
      env: { ...process.env, STATE_DIR: stateDir, PORT: "0" },
    });

    let stdout = "";

    const bootTimeout = setTimeout(() => {
      cleanup();
      reject(new Error(`app.js did not report it was listening in time. stdout so far:\n${stdout}`));
    }, 5000);

    function cleanup() {
      clearTimeout(bootTimeout);
      child.stdout.off("data", onStdout);
    }

    function onStdout(chunk) {
      stdout += chunk.toString();
      const match = stdout.match(/listening on port (\d+)/);
      if (match) {
        cleanup();
        resolve({ child, port: Number(match[1]) });
      }
    }

    child.stdout.on("data", onStdout);
    child.once("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

test(
  "SIGTERM during a request: it completes, the process exits 0 and the change is saved",
  { timeout: 15000 },
  async () => {
    const stateDir = await makeTempStateDir();
    const { child, port } = await startApp(stateDir);

    try {
      const exitPromise = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

      //10 USD to ARS at 1513
      const requestPromise = fetch(`http://127.0.0.1:${port}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseCurrency: "USD",
          counterCurrency: "ARS",
          baseAmount: 10,
          baseAccountId: 999,
          counterAccountId: 888,
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      child.kill("SIGTERM");

      const response = await requestPromise;
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.counterAmount, 15130);

      const exitCode = await exitPromise;
      assert.equal(exitCode, 0);

      const accounts = JSON.parse(await readFile(path.join(stateDir, "accounts.json"), "utf8"));
      const usdAccount = accounts.find((a) => a.id === 2);
      const arsAccount = accounts.find((a) => a.id === 1);

      assert.equal(usdAccount.balance, 60010);
      assert.equal(arsAccount.balance, 119984870);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await rm(stateDir, { recursive: true, force: true });
    }
  }
);
