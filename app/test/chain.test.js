import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { brokenAt } from "../chain.js";
import { createFileAdapter } from "../repository/file-adapter.js";

async function adapterWithLog(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arvault-chain-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(`${import.meta.dirname}/../state`, dir, { recursive: true });

  const adapter = await createFileAdapter({ dir, persist: false });
  for (const id of ["a", "b", "c"]) {
    await adapter.appendLog({ id, ok: true });
  }

  return { adapter, logFile: path.join(dir, "log.jsonl") };
}

test("an untouched log verifies", async (t) => {
  const { adapter } = await adapterWithLog(t);

  assert.equal(brokenAt(await adapter.getLog()), -1);
});

test("editing an entry breaks the chain at that entry", async (t) => {
  const { adapter, logFile } = await adapterWithLog(t);
  const lines = (await fs.readFile(logFile, "utf8")).replace('"id":"b","ok":true', '"id":"b","ok":false');
  await fs.writeFile(logFile, lines);

  assert.equal(brokenAt(await adapter.getLog()), 1);
});
