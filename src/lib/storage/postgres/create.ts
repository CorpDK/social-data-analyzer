import type { Pool } from "pg";
import type { Storage } from "../ports";
import { createPostgresCatalogStore } from "./catalog";
import { createPostgresJobStore } from "./jobs";
import { createPostgresMaintenanceOps } from "./maintenance";
import { createPostgresSearchIndex } from "./search";
import { createPostgresSettingsStore } from "./settings";

export function createPostgresStorage(pool: Pool): Storage {
  return {
    catalog: createPostgresCatalogStore(pool),
    search: createPostgresSearchIndex(pool),
    jobs: createPostgresJobStore(pool),
    settings: createPostgresSettingsStore(pool),
    maintenance: createPostgresMaintenanceOps(pool),
  };
}
