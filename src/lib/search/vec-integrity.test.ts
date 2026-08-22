import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as sqliteVec from "sqlite-vec";
import { assessVectorIntegrity } from "./vec-integrity";
import { embeddingToBuffer } from "./embeddings";

function memoryVecDb() {
  const sqlite = new Database(":memory:");
  sqliteVec.load(sqlite);
  sqlite.exec(`
    CREATE TABLE saved (media_id INTEGER PRIMARY KEY);
    CREATE VIRTUAL TABLE saved_items_vec_local USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding FLOAT[4]
    );
    CREATE TABLE embedding_index_profiles (
      index_name TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      endpoint TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return sqlite;
}

describe("assessVectorIntegrity", () => {
  it("reports ok for a matching items+vec table", () => {
    const sqlite = memoryVecDb();
    sqlite.prepare(`INSERT INTO saved (media_id) VALUES (1)`).run();
    sqlite.prepare(`INSERT INTO saved (media_id) VALUES (2)`).run();
    const emb = embeddingToBuffer(new Float32Array([0.1, 0.2, 0.3, 0.4]));
    sqlite
      .prepare(
        `INSERT INTO saved_items_vec_local(item_id, embedding) VALUES (?, ?)`,
      )
      .run(BigInt(1), emb);
    sqlite
      .prepare(
        `INSERT INTO saved_items_vec_local(item_id, embedding) VALUES (?, ?)`,
      )
      .run(BigInt(2), emb);
    sqlite
      .prepare(
        `INSERT INTO embedding_index_profiles(index_name, provider, model, dimensions)
         VALUES ('local', 'local', 'hash', 4)`,
      )
      .run();

    const report = assessVectorIntegrity("saves", "local", sqlite);
    expect(report.tablePresent).toBe(true);
    expect(report.orphanVecRows).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("fails when orphan vector rows exist", () => {
    const sqlite = memoryVecDb();
    sqlite.prepare(`INSERT INTO saved (media_id) VALUES (1)`).run();
    const emb = embeddingToBuffer(new Float32Array(4).fill(0.5));
    sqlite
      .prepare(
        `INSERT INTO saved_items_vec_local(item_id, embedding) VALUES (?, ?)`,
      )
      .run(BigInt(1), emb);
    sqlite
      .prepare(
        `INSERT INTO saved_items_vec_local(item_id, embedding) VALUES (?, ?)`,
      )
      .run(BigInt(99), emb);

    const report = assessVectorIntegrity("saves", "local", sqlite);
    expect(report.ok).toBe(false);
    expect(report.orphanVecRows).toBe(1);
    expect(report.issues[0]).toMatch(/orphan/i);
  });

  it("treats missing vec table as ok (empty)", () => {
    const sqlite = new Database(":memory:");
    sqliteVec.load(sqlite);
    sqlite.exec(`CREATE TABLE saved (media_id INTEGER PRIMARY KEY);`);
    const report = assessVectorIntegrity("saves", "local", sqlite);
    expect(report).toMatchObject({
      ok: true,
      tablePresent: false,
      orphanVecRows: 0,
    });
  });
});
