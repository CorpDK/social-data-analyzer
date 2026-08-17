import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type FixtureFile = {
  name: string;
  content: string;
};

/** Mutable counters shared across suites (mock fetch lives for the whole run). */
export type MockFetchState = {
  embeddingRequests: number;
  failEmbeddingRequests: boolean;
  embeddingBodies: Array<Record<string, unknown>>;
  embeddingUrls: string[];
};

export type TestContext = {
  tmpDb: string;
  fixtures: string;
  /** Sample saved_posts + collections JSON — set by the parse suite. */
  files: FixtureFile[];
  mockFetch: MockFetchState;
  cleanup: () => void;
};

/** Shared env for all Gate A suites — temp DB, memory keyring, inline worker. */
export async function setupTestContext(): Promise<TestContext> {
  const tmpDb = path.join(
    os.tmpdir(),
    `instagram-saves-test-${Date.now()}.db`,
  );
  process.env.INSTAGRAM_SAVES_DB = tmpDb;
  process.env.INSTAGRAM_SAVES_KEYRING = "memory";
  process.env.EMBEDDING_WORKER_INLINE = "1";
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.EMBEDDING_OLLAMA;
  delete process.env.OLLAMA_ENABLED;
  delete process.env.OPENAI_ENABLED;
  delete process.env.VOYAGE_ENABLED;
  delete process.env.LOCAL_ENABLED;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.VOYAGE_MODEL;
  delete process.env.EMBEDDING_TIMEOUT_MS;

  const { resetKeyringForTests } = await import("../../src/lib/settings/keyring");
  resetKeyringForTests();

  const fixtures = path.join(process.cwd(), "fixtures");
  const files: FixtureFile[] = [
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-posts.json"),
        "utf8",
      ),
    },
    {
      name: "your_instagram_activity/saved/saved_collections.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-collections.json"),
        "utf8",
      ),
    },
  ];

  return {
    tmpDb,
    fixtures,
    files,
    mockFetch: {
      embeddingRequests: 0,
      failEmbeddingRequests: false,
      embeddingBodies: [],
      embeddingUrls: [],
    },
    cleanup: () => {
      try {
        fs.unlinkSync(tmpDb);
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
