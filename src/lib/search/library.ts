import {
  isEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";

export type SearchLibrary = "saves" | "likes";

export type VectorIndexName = EmbeddingProvider;

export const ALL_VECTOR_INDEXES: VectorIndexName[] = [
  "local",
  "ollama",
  "openai",
  "voyage",
];

export const SEARCH_LIBRARIES: SearchLibrary[] = ["saves", "likes"];

/** sqlite-vec table for a library + provider. */
export function vectorTableName(
  library: SearchLibrary,
  index: VectorIndexName,
): string {
  const prefix = library === "saves" ? "saved_items_vec" : "liked_items_vec";
  return `${prefix}_${index}`;
}

/**
 * Profile / job target key.
 * Saves keep bare provider names for backward compatibility (`local`, `openai`, …).
 * Likes use a `likes-` prefix (`likes-local`, `likes-openai`, …).
 */
export function profileIndexName(
  library: SearchLibrary,
  index: VectorIndexName,
): string {
  return library === "saves" ? index : `likes-${index}`;
}

export function itemsTableName(library: SearchLibrary): string {
  return library === "saves" ? "saved_items" : "liked_items";
}

export function ftsTableName(library: SearchLibrary): string {
  return library === "saves" ? "saved_items_fts" : "liked_items_fts";
}

export type ConcreteJobTarget = string;

export type ParsedJobTarget =
  | { kind: "all-configured" }
  | { kind: "provider"; library: SearchLibrary; provider: EmbeddingProvider };

export function parseLibraryJobTarget(value: string): ParsedJobTarget | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "all-configured") return { kind: "all-configured" };

  if (isEmbeddingProvider(trimmed)) {
    return { kind: "provider", library: "saves", provider: trimmed };
  }

  const likesMatch = /^likes-(local|ollama|openai|voyage)$/.exec(trimmed);
  if (likesMatch) {
    return {
      kind: "provider",
      library: "likes",
      provider: likesMatch[1] as EmbeddingProvider,
    };
  }

  return null;
}

export function formatJobTarget(
  library: SearchLibrary,
  provider: EmbeddingProvider,
): ConcreteJobTarget {
  return profileIndexName(library, provider);
}

export function libraryLabel(library: SearchLibrary): string {
  return library === "saves" ? "Saves" : "Likes";
}
