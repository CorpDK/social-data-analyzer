/**
 * System keyring access for API secrets.
 * Uses @napi-rs/keyring (Secret Service / Keychain / Credential Manager).
 * Falls back to an in-memory map when INSTAGRAM_SAVES_KEYRING=memory (tests),
 * or reports unavailable so callers can use env vars instead.
 */

export type KeyringAccount = "openai" | "voyage" | "ollama";

export type KeyringStatus = {
  available: boolean;
  backend: "native" | "memory" | "unavailable";
  message: string | null;
};

const SERVICE = "instagram-saves";

type Backend = {
  get(account: KeyringAccount): string | null;
  set(account: KeyringAccount, password: string): void;
  delete(account: KeyringAccount): void;
};

const memoryStore = new Map<string, string>();

function memoryBackend(): Backend {
  return {
    get(account) {
      return memoryStore.get(account) ?? null;
    },
    set(account, password) {
      memoryStore.set(account, password);
    },
    delete(account) {
      memoryStore.delete(account);
    },
  };
}

function nativeBackend(): Backend {
  // Lazy require keeps Next from evaluating native code during edge/client bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return {
    get(account) {
      const entry = new Entry(SERVICE, account);
      return entry.getPassword() ?? null;
    },
    set(account, password) {
      const entry = new Entry(SERVICE, account);
      entry.setPassword(password);
    },
    delete(account) {
      const entry = new Entry(SERVICE, account);
      try {
        entry.deletePassword();
      } catch {
        // Missing credential is fine when clearing.
      }
    },
  };
}

let cached: { backend: Backend; status: KeyringStatus } | null = null;

function initKeyring(): { backend: Backend; status: KeyringStatus } {
  if (cached) return cached;

  if (process.env.INSTAGRAM_SAVES_KEYRING?.trim() === "memory") {
    cached = {
      backend: memoryBackend(),
      status: {
        available: true,
        backend: "memory",
        message: "Using in-memory keyring (test mode).",
      },
    };
    return cached;
  }

  try {
    const backend = nativeBackend();
    // Probe that the OS store is reachable without leaving junk.
    backend.get("openai");
    cached = {
      backend,
      status: {
        available: true,
        backend: "native",
        message: null,
      },
    };
    return cached;
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "unknown keyring error";
    cached = {
      backend: memoryBackend(),
      status: {
        available: false,
        backend: "unavailable",
        message: `System keyring unavailable (${detail}). API keys fall back to environment variables; Settings cannot persist secrets until a keyring is available.`,
      },
    };
    return cached;
  }
}

/** Reset cached backend — used by tests only. */
export function resetKeyringForTests() {
  cached = null;
  memoryStore.clear();
}

export function getKeyringStatus(): KeyringStatus {
  return initKeyring().status;
}

export function getKeyringSecret(account: KeyringAccount): string | null {
  const { backend, status } = initKeyring();
  if (!status.available && status.backend === "unavailable") {
    return null;
  }
  try {
    const value = backend.get(account)?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function setKeyringSecret(
  account: KeyringAccount,
  password: string,
): void {
  const { backend, status } = initKeyring();
  if (!status.available) {
    throw new Error(
      status.message ??
        "System keyring is unavailable; set keys via environment variables instead.",
    );
  }
  const trimmed = password.trim();
  if (!trimmed) {
    throw new Error("Cannot store an empty API key");
  }
  backend.set(account, trimmed);
}

export function deleteKeyringSecret(account: KeyringAccount): void {
  const { backend, status } = initKeyring();
  if (!status.available) {
    throw new Error(
      status.message ??
        "System keyring is unavailable; clear keys via environment variables instead.",
    );
  }
  backend.delete(account);
}
