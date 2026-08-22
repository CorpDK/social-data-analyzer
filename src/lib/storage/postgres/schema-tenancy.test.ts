import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresPool } from "./connection";
import {
  markPostgresEngineMigration,
  postgresEngineMigrationStatus,
  wipeIncompletePostgresLibrary,
} from "./engine-migration";

const postgresUrl = process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim();
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const appSchema = `instagram_saves_test_${suffix}`;
const decoyTable = `instagram_saves_decoy_${suffix}`;

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Unsafe test identifier: ${name}`);
  }
  return `"${name}"`;
}

describe.skipIf(!postgresUrl).sequential("PostgreSQL schema tenancy", () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${quote(appSchema)}`);
    await admin.query(
      `CREATE TABLE public.${quote(decoyTable)} (id integer PRIMARY KEY)`,
    );
    await admin.query(
      `INSERT INTO public.${quote(decoyTable)} (id) VALUES (1)`,
    );
    pool = await createPostgresPool(postgresUrl!, {
      postgresSchema: appSchema,
      trackLibraryStatus: false,
    });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (admin) {
      await admin
        .query(`DROP TABLE IF EXISTS public.${quote(decoyTable)}`)
        .catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quote(appSchema)} CASCADE`)
        .catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("sets every pooled connection to the named schema", async () => {
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        const current = await client.query<{ name: string }>(
          "SELECT current_schema() AS name",
        );
        expect(current.rows[0]?.name).toBe(appSchema);
      }
    } finally {
      for (const client of clients) client.release();
    }
  });

  it("places the journal and application tables outside public", async () => {
    const result = await admin.query<{ schema_name: string; table_name: string }>(
      `SELECT schemaname AS schema_name, tablename AS table_name
       FROM pg_tables
       WHERE tablename IN ('__drizzle_migrations', 'imports')
         AND schemaname IN ($1, 'public')`,
      [appSchema],
    );

    expect(result.rows).toEqual(
      expect.arrayContaining([
        { schema_name: appSchema, table_name: "__drizzle_migrations" },
        { schema_name: appSchema, table_name: "imports" },
      ]),
    );
    expect(
      result.rows.some(
        (row) =>
          row.schema_name === "public" &&
          row.table_name === "__drizzle_migrations",
      ),
    ).toBe(false);
  });

  it("wipes only the application schema", async () => {
    await markPostgresEngineMigration(pool, appSchema, "in_progress");
    expect(await postgresEngineMigrationStatus(pool, appSchema)).toBe(
      "in_progress",
    );

    await wipeIncompletePostgresLibrary(pool, appSchema);

    const decoy = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.${quote(decoyTable)}`,
    );
    expect(decoy.rows[0]?.count).toBe(1);
    expect(await postgresEngineMigrationStatus(pool, appSchema)).toBe("absent");
  });
});
