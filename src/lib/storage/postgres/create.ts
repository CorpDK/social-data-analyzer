import type { Pool } from "pg";
import type { Storage } from "../ports";
import { createPostgresCatalogStore } from "./catalog";
import { createPostgresJobStore } from "./jobs";
import { createPostgresMaintenanceOps } from "./maintenance";
import { createPostgresSearchIndex } from "./search";
import { createPostgresSettingsStore } from "./settings";
import {
  readStorageEngineConfig,
  redactPostgresUrl,
} from "../engine-config";
import { createPostgresLibraryStatusPort } from "../library-status";

export function createPostgresStorage(pool: Pool): Storage {
  const configured = readStorageEngineConfig();
  const location =
    configured.engine === "postgres"
      ? `${redactPostgresUrl(configured.postgresUrl)} · schema ${configured.postgresSchema}`
      : "Configured PostgreSQL database";
  return {
    libraryStatus: createPostgresLibraryStatusPort(location),
    catalog: createPostgresCatalogStore(pool),
    search: createPostgresSearchIndex(pool),
    jobs: createPostgresJobStore(pool),
    settings: createPostgresSettingsStore(pool),
    maintenance: createPostgresMaintenanceOps(pool),
  };
}
