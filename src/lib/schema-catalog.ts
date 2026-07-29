import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import {
  mergeSchemaNodes,
  type JsonPrimitiveType,
  type JsonSchemaNode,
} from "./json-schema-infer";

const { imports, importSchemas } = schema;

export type SchemaImportOption = {
  id: number;
  filename: string;
  importedAt: Date;
  status: string;
  schemaFileCount: number;
  hasSchemas: boolean;
};

export type SchemaFileEntry = {
  filePath: string;
  byteSize: number;
  truncatedRead: boolean;
  topLevelType: string;
  schema: JsonSchemaNode | null;
  parseError: string | null;
  /** Imports that contain this path (All view) */
  imports?: Array<{ id: number; filename: string }>;
  /** Present in per-import view */
  importId?: number;
};

export type SchemaCatalogResult = {
  mode: "all" | "import";
  importId: number | null;
  imports: SchemaImportOption[];
  files: SchemaFileEntry[];
  emptyReason: string | null;
};

function parseStoredSchema(schemaJson: string): {
  schema: JsonSchemaNode | null;
  parseError: string | null;
} {
  try {
    const parsed = JSON.parse(schemaJson) as {
      schema?: JsonSchemaNode | null;
      parseError?: string | null;
    };
    return {
      schema: parsed.schema ?? null,
      parseError: parsed.parseError ?? null,
    };
  } catch {
    return { schema: null, parseError: "Invalid stored schema_json" };
  }
}

export function listSchemaImportOptions(): SchemaImportOption[] {
  const db = getDb();
  const rows = db
    .select({
      id: imports.id,
      filename: imports.filename,
      importedAt: imports.importedAt,
      status: imports.status,
    })
    .from(imports)
    .orderBy(desc(imports.importedAt))
    .all();

  const counts = db
    .select({
      importId: importSchemas.importId,
      total: sql<number>`count(*)`,
    })
    .from(importSchemas)
    .groupBy(importSchemas.importId)
    .all();

  const countByImport = new Map(
    counts.map((row) => [row.importId, Number(row.total)]),
  );

  return rows.map((row) => {
    const count = countByImport.get(row.id) ?? 0;
    return {
      id: row.id,
      filename: row.filename,
      importedAt: row.importedAt,
      status: row.status,
      schemaFileCount: count,
      hasSchemas: count > 0,
    };
  });
}

export function getSchemasForImport(importId: number): SchemaFileEntry[] {
  const db = getDb();
  const rows = db
    .select()
    .from(importSchemas)
    .where(eq(importSchemas.importId, importId))
    .orderBy(importSchemas.filePath)
    .all();

  return rows.map((row) => {
    const stored = parseStoredSchema(row.schemaJson);
    return {
      filePath: row.filePath,
      byteSize: row.byteSize,
      truncatedRead: row.truncatedRead,
      topLevelType: row.topLevelType,
      schema: stored.schema,
      parseError: stored.parseError,
      importId: row.importId,
    };
  });
}

function mergeTopLevelTypes(a: string, b: string): string {
  if (a === b) return a;
  if (a === "unknown") return b;
  if (b === "unknown") return a;
  const set = new Set(
    [...a.split("|"), ...b.split("|")].map((t) => t.trim()).filter(Boolean),
  );
  return [...set].sort().join("|");
}

export function getAggregatedSchemas(): SchemaFileEntry[] {
  const db = getDb();
  const rows = db
    .select({
      importId: importSchemas.importId,
      filename: imports.filename,
      filePath: importSchemas.filePath,
      byteSize: importSchemas.byteSize,
      truncatedRead: importSchemas.truncatedRead,
      topLevelType: importSchemas.topLevelType,
      schemaJson: importSchemas.schemaJson,
    })
    .from(importSchemas)
    .innerJoin(imports, eq(importSchemas.importId, imports.id))
    .orderBy(importSchemas.filePath, desc(imports.importedAt))
    .all();

  const byPath = new Map<
    string,
    {
      filePath: string;
      byteSize: number;
      truncatedRead: boolean;
      topLevelType: string;
      schema: JsonSchemaNode | null;
      parseError: string | null;
      imports: Array<{ id: number; filename: string }>;
    }
  >();

  for (const row of rows) {
    const stored = parseStoredSchema(row.schemaJson);
    const existing = byPath.get(row.filePath);
    if (!existing) {
      byPath.set(row.filePath, {
        filePath: row.filePath,
        byteSize: row.byteSize,
        truncatedRead: row.truncatedRead,
        topLevelType: row.topLevelType,
        schema: stored.schema,
        parseError: stored.parseError,
        imports: [{ id: row.importId, filename: row.filename }],
      });
      continue;
    }

    existing.byteSize = Math.max(existing.byteSize, row.byteSize);
    existing.truncatedRead = existing.truncatedRead || row.truncatedRead;
    existing.topLevelType = mergeTopLevelTypes(
      existing.topLevelType,
      row.topLevelType,
    );
    if (existing.schema && stored.schema) {
      existing.schema = mergeSchemaNodes(existing.schema, stored.schema);
    } else {
      existing.schema = existing.schema ?? stored.schema;
    }
    if (!existing.parseError && stored.parseError) {
      existing.parseError = stored.parseError;
    }
    if (!existing.imports.some((imp) => imp.id === row.importId)) {
      existing.imports.push({ id: row.importId, filename: row.filename });
    }
  }

  return [...byPath.values()]
    .map((entry) => ({
      filePath: entry.filePath,
      byteSize: entry.byteSize,
      truncatedRead: entry.truncatedRead,
      topLevelType: entry.topLevelType,
      schema: entry.schema,
      parseError: entry.parseError,
      imports: entry.imports.sort((a, b) => b.id - a.id),
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function getSchemaCatalog(
  importIdParam: string | null | undefined,
): SchemaCatalogResult {
  const options = listSchemaImportOptions();
  const withSchemas = options.filter((o) => o.hasSchemas);

  if (!importIdParam || importIdParam === "all") {
    const files = getAggregatedSchemas();
    return {
      mode: "all",
      importId: null,
      imports: options,
      files,
      emptyReason:
        files.length === 0
          ? withSchemas.length === 0
            ? "No schema catalogs yet. Re-import a zip to capture JSON schemas from every file in the archive."
            : "No schema files found."
          : null,
    };
  }

  const importId = Number(importIdParam);
  if (!Number.isFinite(importId) || importId <= 0) {
    return {
      mode: "import",
      importId: null,
      imports: options,
      files: [],
      emptyReason: "Invalid import id.",
    };
  }

  const option = options.find((o) => o.id === importId);
  if (!option) {
    return {
      mode: "import",
      importId,
      imports: options,
      files: [],
      emptyReason: "Import not found.",
    };
  }

  const files = getSchemasForImport(importId);
  return {
    mode: "import",
    importId,
    imports: options,
    files,
    emptyReason:
      files.length === 0
        ? "This import has no schema catalog. Re-import the zip to capture schemas (older imports only stored saved posts)."
        : null,
  };
}

export type { JsonPrimitiveType, JsonSchemaNode };
