/**
 * Vector index integrity beyond COUNT(*) equality.
 *
 * Health historically treated `embeddedCount === totalItems` as "ready".
 * That misses orphan vec rows (item deleted), dimension drift vs profile,
 * and unreadable / wrong-width embedding payloads.
 */
import type Database from "better-sqlite3";
import {
  itemsTableName,
  type SearchLibrary,
  type VectorIndexName,
  vectorTableName,
} from "./library";
import {
  getIndexedEmbeddingProfile,
  vectorTableDimensions,
} from "./sync-vec-store";

/** Max embedding rows to sample for byte-width checks (keeps status cheap). */
export const VEC_INTEGRITY_SAMPLE_LIMIT = 64;

export type VecIntegrityReport = {
  ok: boolean;
  tablePresent: boolean;
  orphanVecRows: number;
  dimensions: number | null;
  profileDimensions: number | null;
  sampleChecked: number;
  sampleBadWidth: number;
  issues: string[];
};

function sampleEmbeddingWidthIssues(
  sqlite: Database.Database,
  table: string,
  expectedBytes: number,
  limit: number,
): { checked: number; bad: number } {
  try {
    const rows = sqlite
      .prepare(
        `SELECT length(embedding) AS nbytes
         FROM ${table}
         LIMIT ?`,
      )
      .all(limit) as Array<{ nbytes: number | null }>;
    let bad = 0;
    for (const row of rows) {
      if (row.nbytes == null || row.nbytes !== expectedBytes) bad += 1;
    }
    return { checked: rows.length, bad };
  } catch {
    // Some sqlite-vec builds may not expose length(embedding); treat as
    // unsampled rather than failing the whole check.
    return { checked: 0, bad: 0 };
  }
}

/**
 * Content-aware vec checks for one library+provider table.
 * Empty / missing tables are ok (health already covers empty).
 */
export function assessVectorIntegrity(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database,
  options?: { sampleLimit?: number },
): VecIntegrityReport {
  const issues: string[] = [];
  const table = vectorTableName(library, index);
  const items = itemsTableName(library);
  const dimensions = vectorTableDimensions(library, index, sqlite);

  if (dimensions === null) {
    return {
      ok: true,
      tablePresent: false,
      orphanVecRows: 0,
      dimensions: null,
      profileDimensions: null,
      sampleChecked: 0,
      sampleBadWidth: 0,
      issues: [],
    };
  }

  let profileDimensions: number | null = null;
  try {
    profileDimensions =
      getIndexedEmbeddingProfile(library, index, sqlite)?.dimensions ?? null;
  } catch {
    // Profiles table may be absent in minimal test DBs; treat as unknown.
    profileDimensions = null;
  }

  const orphanVecRows = (
    sqlite
      .prepare(
        `SELECT count(*) AS c
         FROM ${table} AS v
         WHERE NOT EXISTS (
           SELECT 1 FROM ${items} AS i WHERE i.id = v.item_id
         )`,
      )
      .get() as { c: number }
  ).c;

  if (orphanVecRows > 0) {
    issues.push(`${orphanVecRows} orphan vector row(s) without matching items`);
  }

  if (
    profileDimensions != null &&
    profileDimensions > 0 &&
    dimensions !== profileDimensions
  ) {
    issues.push(
      `table FLOAT[${dimensions}] disagrees with profile dimensions ${profileDimensions}`,
    );
  }

  const sampleLimit = options?.sampleLimit ?? VEC_INTEGRITY_SAMPLE_LIMIT;
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  const sample = sampleEmbeddingWidthIssues(
    sqlite,
    table,
    expectedBytes,
    sampleLimit,
  );
  if (sample.bad > 0) {
    issues.push(
      `${sample.bad}/${sample.checked} sampled embedding(s) have unexpected byte width`,
    );
  }

  return {
    ok: issues.length === 0,
    tablePresent: true,
    orphanVecRows,
    dimensions,
    profileDimensions,
    sampleChecked: sample.checked,
    sampleBadWidth: sample.bad,
    issues,
  };
}
