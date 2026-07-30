/**
 * Lightweight structural schema inference for Instagram export JSON files.
 * Stores types/keys/nesting only — never large payloads or PII-heavy content.
 */

/** Pathological-depth guard only (JSON cannot cycle). Practical nesting is uncapped. */
export const SCHEMA_SAFETY_MAX_DEPTH = 256;
/** @deprecated Prefer full-file reads; kept as Infinity so callers never truncate. */
export const SCHEMA_SAMPLE_BYTES = Number.POSITIVE_INFINITY;
/**
 * Max array elements to sample when inferring element schema.
 * Strategy: first ~7, last ~7, and ~6 random from the middle (≤20 total).
 * If length ≤ 20, use every element.
 */
export const SCHEMA_ARRAY_SAMPLE = 20;
export const SCHEMA_STRING_SAMPLE_MAX = 48;

const ARRAY_SAMPLE_FIRST = 7;
const ARRAY_SAMPLE_LAST = 7;
const ARRAY_SAMPLE_RANDOM = 6;

export type JsonPrimitiveType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array";

export type JsonSchemaNode = {
  type: JsonPrimitiveType | JsonPrimitiveType[];
  /** Object keys → nested shapes */
  keys?: Record<string, JsonSchemaNode>;
  /** Merged element shape for arrays */
  items?: JsonSchemaNode;
  /** Sampled array length stats */
  arrayLength?: { min: number; max: number; sample: number };
  /** Whether sampled array elements share one top-level type */
  homogeneous?: boolean;
  /** Tiny truncated example (type-only preferred; never long strings) */
  sample?: string | number | boolean | null;
  /** Present when merging schemas where a key is missing in some samples */
  optional?: boolean;
  /** Safety depth ceiling hit (pathological nesting only) */
  truncated?: boolean;
};

export type FileSchemaCatalogEntry = {
  filePath: string;
  byteSize: number;
  truncatedRead: boolean;
  parseError?: string;
  topLevelType: JsonPrimitiveType | "unknown";
  schema: JsonSchemaNode | null;
};

function primitiveTypeOf(value: unknown): JsonPrimitiveType | "unknown" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function asTypeList(
  type: JsonPrimitiveType | JsonPrimitiveType[],
): JsonPrimitiveType[] {
  return Array.isArray(type) ? type : [type];
}

function mergeTypes(
  a: JsonPrimitiveType | JsonPrimitiveType[],
  b: JsonPrimitiveType | JsonPrimitiveType[],
): JsonPrimitiveType | JsonPrimitiveType[] {
  const set = new Set([...asTypeList(a), ...asTypeList(b)]);
  const list = [...set];
  return list.length === 1 ? list[0]! : list;
}

function truncateSample(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) return undefined;
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    // Avoid storing URLs / long free text — keep only a short shape hint.
    if (cleaned.length > SCHEMA_STRING_SAMPLE_MAX) {
      return `${cleaned.slice(0, SCHEMA_STRING_SAMPLE_MAX)}…`;
    }
    return cleaned;
  }
  return undefined;
}

/**
 * Pick up to SCHEMA_ARRAY_SAMPLE indices: first 7, last 7, and up to 6 random
 * from the middle. Length ≤ 20 → every index. Exported for tests.
 */
export function sampleArrayIndices(
  length: number,
  random: () => number = Math.random,
): number[] {
  if (length <= 0) return [];
  if (length <= SCHEMA_ARRAY_SAMPLE) {
    return Array.from({ length }, (_, i) => i);
  }

  const indices = new Set<number>();
  for (let i = 0; i < ARRAY_SAMPLE_FIRST; i++) indices.add(i);
  for (let i = 0; i < ARRAY_SAMPLE_LAST; i++) indices.add(length - 1 - i);

  const midStart = ARRAY_SAMPLE_FIRST;
  const midEnd = length - ARRAY_SAMPLE_LAST;
  const mid: number[] = [];
  for (let i = midStart; i < midEnd; i++) {
    if (!indices.has(i)) mid.push(i);
  }

  let remaining = ARRAY_SAMPLE_RANDOM;
  while (remaining > 0 && mid.length > 0) {
    const pick = Math.floor(random() * mid.length);
    indices.add(mid[pick]!);
    mid.splice(pick, 1);
    remaining -= 1;
  }

  return [...indices].sort((a, b) => a - b);
}

function sampleArrayElements<T>(arr: T[]): T[] {
  return sampleArrayIndices(arr.length).map((i) => arr[i]!);
}

export function inferSchemaFromValue(
  value: unknown,
  depth = 0,
): JsonSchemaNode {
  const t = primitiveTypeOf(value);
  if (t === "unknown") {
    return { type: "null", sample: null };
  }

  if (t === "string" || t === "number" || t === "boolean" || t === "null") {
    const sample = truncateSample(value);
    return sample === undefined ? { type: t } : { type: t, sample };
  }

  // JSON values cannot cycle; this ceiling only avoids stack overflow on
  // pathological nesting. Normal Instagram export shapes are far shallower.
  if (depth >= SCHEMA_SAFETY_MAX_DEPTH) {
    return { type: t, truncated: true };
  }

  if (t === "array") {
    const arr = value as unknown[];
    // Sample ≤20 elements from first / last / random middle; merge their schemas.
    const samples = sampleArrayElements(arr);
    let items: JsonSchemaNode | undefined;
    const elementTypes = new Set<JsonPrimitiveType>();

    for (const el of samples) {
      const elType = primitiveTypeOf(el);
      if (elType !== "unknown") elementTypes.add(elType);
      const elSchema = inferSchemaFromValue(el, depth + 1);
      items = items ? mergeSchemaNodes(items, elSchema) : elSchema;
    }

    return {
      type: "array",
      items,
      arrayLength: {
        min: arr.length,
        max: arr.length,
        sample: samples.length,
      },
      homogeneous: elementTypes.size <= 1,
    };
  }

  // object
  const obj = value as Record<string, unknown>;
  const keys: Record<string, JsonSchemaNode> = {};
  for (const [key, child] of Object.entries(obj)) {
    keys[key] = inferSchemaFromValue(child, depth + 1);
  }
  return { type: "object", keys };
}

export function mergeSchemaNodes(
  a: JsonSchemaNode,
  b: JsonSchemaNode,
): JsonSchemaNode {
  const type = mergeTypes(a.type, b.type);
  const out: JsonSchemaNode = { type };

  if (a.truncated || b.truncated) out.truncated = true;
  if (a.optional || b.optional) out.optional = true;

  // Prefer keeping a tiny sample when types agree on a primitive.
  const aTypes = asTypeList(a.type);
  const bTypes = asTypeList(b.type);
  if (
    a.sample !== undefined &&
    b.sample !== undefined &&
    aTypes.length === 1 &&
    bTypes.length === 1 &&
    aTypes[0] === bTypes[0] &&
    aTypes[0] !== "object" &&
    aTypes[0] !== "array"
  ) {
    out.sample = a.sample;
  } else if (a.sample !== undefined && b.sample === undefined) {
    out.sample = a.sample;
  } else if (b.sample !== undefined && a.sample === undefined) {
    out.sample = b.sample;
  }

  const aHasObj = aTypes.includes("object") || Boolean(a.keys);
  const bHasObj = bTypes.includes("object") || Boolean(b.keys);
  if (aHasObj || bHasObj) {
    const aKeys = a.keys ?? {};
    const bKeys = b.keys ?? {};
    const allKeys = new Set([...Object.keys(aKeys), ...Object.keys(bKeys)]);
    const keys: Record<string, JsonSchemaNode> = {};
    for (const key of allKeys) {
      const ak = aKeys[key];
      const bk = bKeys[key];
      if (ak && bk) {
        keys[key] = mergeSchemaNodes(ak, bk);
      } else if (ak) {
        keys[key] = { ...ak, optional: true };
      } else if (bk) {
        keys[key] = { ...bk, optional: true };
      }
    }
    if (Object.keys(keys).length > 0) out.keys = keys;
  }

  const aHasArr = aTypes.includes("array") || Boolean(a.items);
  const bHasArr = bTypes.includes("array") || Boolean(b.items);
  if (aHasArr || bHasArr) {
    if (a.items && b.items) out.items = mergeSchemaNodes(a.items, b.items);
    else out.items = a.items ?? b.items;

    if (a.arrayLength && b.arrayLength) {
      out.arrayLength = {
        min: Math.min(a.arrayLength.min, b.arrayLength.min),
        max: Math.max(a.arrayLength.max, b.arrayLength.max),
        sample: Math.max(a.arrayLength.sample, b.arrayLength.sample),
      };
    } else {
      out.arrayLength = a.arrayLength ?? b.arrayLength;
    }

    if (a.homogeneous !== undefined && b.homogeneous !== undefined) {
      out.homogeneous = a.homogeneous && b.homogeneous;
    } else {
      out.homogeneous = a.homogeneous ?? b.homogeneous;
    }
  }

  return out;
}

/**
 * Best-effort parse of a possibly truncated UTF-8 JSON prefix.
 * Kept for repair/tests; import path now reads full file contents.
 */
export function parseJsonPrefix(text: string, wasTruncated: boolean): unknown {
  try {
    return JSON.parse(text);
  } catch {
    if (!wasTruncated) throw new Error("Invalid JSON");
  }

  let inString = false;
  let escape = false;
  const stack: string[] = [];
  let lastSafe = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) {
        stack.pop();
        if (stack.length === 0) lastSafe = i + 1;
      }
      continue;
    }
    if ((ch === "," || ch === ":") && stack.length > 0) {
      // keep scanning
    }
  }

  // Prefer the largest complete top-level value; otherwise close open brackets.
  if (lastSafe > 0) {
    try {
      return JSON.parse(text.slice(0, lastSafe));
    } catch {
      // fall through
    }
  }

  let candidate = text.trimEnd();
  if (inString) {
    // Incomplete string — drop back to before its opening quote.
    const open = candidate.lastIndexOf('"');
    if (open >= 0) candidate = candidate.slice(0, open).trimEnd();
    inString = false;
  }
  // Drop trailing incomplete property / element fragments.
  candidate = candidate
    .replace(/,\s*$/, "")
    .replace(/,?\s*"[^"]*"\s*:\s*$/, "")
    .replace(/,?\s*"[^"]*"\s*$/, "")
    .replace(/:\s*$/, "")
    .replace(/,\s*$/, "");

  // Recompute closers from the cleaned candidate.
  const closers: string[] = [];
  let scanString = false;
  let scanEscape = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (scanString) {
      if (scanEscape) {
        scanEscape = false;
        continue;
      }
      if (ch === "\\") {
        scanEscape = true;
        continue;
      }
      if (ch === '"') scanString = false;
      continue;
    }
    if (ch === '"') {
      scanString = true;
      continue;
    }
    if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") closers.pop();
  }
  while (closers.length) candidate += closers.pop();

  return JSON.parse(candidate);
}

export function inferFileSchema(
  filePath: string,
  content: string,
  options?: { byteSize?: number; truncatedRead?: boolean },
): FileSchemaCatalogEntry {
  const contentBytes = Buffer.byteLength(content, "utf8");
  const size = options?.byteSize ?? contentBytes;
  const wasTruncated =
    options?.truncatedRead ?? contentBytes < size;

  try {
    // Full-file parse (local app; tens of MB is acceptable). Schema only is stored.
    const value = wasTruncated
      ? parseJsonPrefix(content, true)
      : JSON.parse(content);
    const top = primitiveTypeOf(value);
    return {
      filePath,
      byteSize: size,
      truncatedRead: wasTruncated,
      topLevelType: top === "unknown" ? "unknown" : top,
      schema: inferSchemaFromValue(value),
    };
  } catch (error) {
    return {
      filePath,
      byteSize: size,
      truncatedRead: wasTruncated,
      parseError:
        error instanceof Error ? error.message : "Failed to parse JSON",
      topLevelType: "unknown",
      schema: null,
    };
  }
}

/** Full content — no byte truncation. Large files are parsed entirely on import. */
export function sampleContentForSchema(content: string): {
  sample: string;
  truncated: boolean;
} {
  return { sample: content, truncated: false };
}

export function catalogSchemasFromFiles(
  files: Array<{ name: string; content: string; byteSize?: number }>,
): FileSchemaCatalogEntry[] {
  return files.map((file) => {
    const size = file.byteSize ?? Buffer.byteLength(file.content, "utf8");
    return inferFileSchema(file.name, file.content, {
      byteSize: size,
      truncatedRead: false,
    });
  });
}
