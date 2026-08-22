import { describe, expect, it } from "vitest";
import {
  storageEnginePublicStatus,
  validPostgresSchema,
} from "./engine-config";

describe("PostgreSQL schema configuration", () => {
  it("accepts safe unquoted identifiers only", () => {
    expect(validPostgresSchema("instagram_saves")).toBe(true);
    expect(validPostgresSchema("tenant_42")).toBe(true);
    expect(validPostgresSchema("public")).toBe(true);
    expect(validPostgresSchema("Tenant")).toBe(false);
    expect(validPostgresSchema("tenant-name")).toBe(false);
    expect(validPostgresSchema("42tenant")).toBe(false);
  });

  it("includes schema and tenancy without exposing the password", () => {
    const status = storageEnginePublicStatus({
      engine: "postgres",
      postgresUrl: "postgres://operator:secret@localhost/shared",
      postgresSchema: "instagram_saves",
      postgresTenancy: "schema",
      sqlitePath: "/tmp/library.db",
    });

    expect(status).toMatchObject({
      postgresSchema: "instagram_saves",
      postgresTenancy: "schema",
    });
    expect(status.postgresUrl).not.toContain("secret");
  });
});
