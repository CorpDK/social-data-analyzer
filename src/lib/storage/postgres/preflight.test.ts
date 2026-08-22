import { describe, expect, it, vi } from "vitest";
import {
  assertPostgresPreflightReady,
  classifyPostgresError,
  inspectPostgresPreflight,
  PostgresSetupError,
} from "./preflight";
import { redactPostgresUrl } from "../engine-config";

function queryable(options?: {
  installed?: boolean;
  available?: boolean;
  superuser?: boolean;
  databaseCreate?: boolean;
  schemaExists?: boolean;
  schemaUsage?: boolean;
  schemaCreate?: boolean;
  migration?: "absent" | "in_progress" | "complete";
}) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          server_version: "17.5",
          role_name: "instagram_saves",
          vector_installed: options?.installed ?? false,
          vector_available: options?.available ?? true,
          role_superuser: options?.superuser ?? true,
          database_create: options?.databaseCreate ?? false,
          schema_exists: options?.schemaExists ?? true,
          schema_usage: options?.schemaUsage ?? true,
          schema_create: options?.schemaCreate ?? true,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows:
        options?.migration === "absent" || options?.migration === undefined
          ? [{ name: null }]
          : [{ name: "engine_migration" }],
    });
  if (options?.migration && options.migration !== "absent") {
    query.mockResolvedValueOnce({ rows: [{ status: options.migration }] });
  }
  return { query };
}

describe("PostgreSQL dedicated-database preflight", () => {
  it("never returns the password in a display URL", () => {
    const display = redactPostgresUrl(
      "postgres://operator:very-secret@127.0.0.1:5432/library",
    );

    expect(display).toContain("operator");
    expect(display).not.toContain("very-secret");
  });

  it("reports the role and installable vector support", async () => {
    const result = await inspectPostgresPreflight(
      queryable({ available: true, superuser: true }) as never,
      "instagram_saves",
    );

    expect(result).toMatchObject({
      state: "ready",
      roleName: "instagram_saves",
      vector: { installed: false, available: true, installable: true },
      engineMigration: "absent",
    });
  });

  it("distinguishes missing vector from insufficient privilege", async () => {
    const missing = await inspectPostgresPreflight(
      queryable({ available: false, superuser: true }) as never,
      "instagram_saves",
    );
    const forbidden = await inspectPostgresPreflight(
      queryable({ available: true, superuser: false }) as never,
      "instagram_saves",
    );

    expect(missing.code).toBe("EXTENSION_MISSING");
    expect(forbidden.code).toBe("PERMISSION_DENIED");
  });

  it("allows a database owner to let migrate verify extension creation", async () => {
    const result = await inspectPostgresPreflight(
      queryable({
        available: true,
        superuser: false,
        databaseCreate: true,
      }) as never,
      "instagram_saves",
    );

    expect(result.state).toBe("ready");
    expect(result.vector.installable).toBe(true);
  });

  it("requires an existing usable schema for schema-only roles", async () => {
    const result = await inspectPostgresPreflight(
      queryable({
        installed: true,
        superuser: false,
        databaseCreate: false,
        schemaExists: false,
        schemaUsage: false,
        schemaCreate: false,
      }) as never,
      "shared_app",
    );

    expect(result).toMatchObject({
      state: "schema_unavailable",
      code: "SCHEMA_UNAVAILABLE",
      schema: {
        name: "shared_app",
        exists: false,
        usable: false,
        creatable: false,
      },
    });
  });

  it("blocks normal opens but permits explicit unfinished-copy recovery", async () => {
    const result = await inspectPostgresPreflight(
      queryable({
        installed: true,
        migration: "in_progress",
      }) as never,
      "instagram_saves",
    );

    expect(result.state).toBe("unfinished_copy");
    expect(() => assertPostgresPreflightReady(result)).toThrow(
      PostgresSetupError,
    );
    expect(() =>
      assertPostgresPreflightReady(result, { allowIncompleteMigration: true }),
    ).not.toThrow();
  });

  it("classifies permission by SQLSTATE without parsing driver messages", () => {
    const error = classifyPostgresError(
      { code: "42501", message: "localized or changed driver text" },
      "migrate",
    );

    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.sqlState).toBe("42501");
    expect(error.message).not.toContain("localized");
  });

  it("classifies unavailable extension setup by SQLSTATE", () => {
    const error = classifyPostgresError(
      { code: "0A000", message: "driver wording is not part of the contract" },
      "migrate",
    );

    expect(error.code).toBe("EXTENSION_MISSING");
    expect(error.sqlState).toBe("0A000");
  });
});
