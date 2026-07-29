import { loadEnvConfig } from "@next/env";
import { rebuildSearchIndex } from "../src/lib/search/sync";
import { getSqlite } from "../src/lib/db";

loadEnvConfig(process.cwd());

async function main() {
  getSqlite();
  const requireRemote = process.argv.includes("--remote");
  const result = await rebuildSearchIndex({ requireRemote });
  const remote =
    result.remoteUpdated.length > 0
      ? result.remoteUpdated.join(", ")
      : "none";
  console.log(
    `Reindexed ${result.items} items (providers: ${result.providers.join(", ")}, remote: ${remote})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
