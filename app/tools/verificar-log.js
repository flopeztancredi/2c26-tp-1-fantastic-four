//checks the log and audit chains, exits 1 if one is broken
import { createFileAdapter } from "../repository/file-adapter.js";
import { createRedisAdapter } from "../repository/redis-adapter.js";
import { brokenAt } from "../chain.js";
import { config } from "../config.js";

const repository =
  config.stateAdapter == "redis"
    ? await createRedisAdapter(config.redisUrl)
    : await createFileAdapter({ dir: config.stateDir, persist: false });

let ok = true;

for (const [name, entries] of [["log", await repository.getLog()], ["audit", await repository.getAudit()]]) {
  const broken = brokenAt(entries);

  if (broken == -1) {
    console.log(`${name}: ${entries.length} entries, chain ok`);
  } else {
    ok = false;
    console.log(`${name}: BROKEN at entry ${broken} of ${entries.length}`);
  }
}

await repository.close();
process.exit(ok ? 0 : 1);
