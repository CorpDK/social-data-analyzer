import type Database from "better-sqlite3";
import type { SettingsStore } from "../ports";
import {
  getAppSetting,
  getEmbeddingTimeoutMs,
  getPreferredEmbeddingProvider,
  getProviderLibraryEnables,
  getRuntimeAppSettings,
  isProviderIndexEnabled,
  setAppSetting,
  setProviderLibraryEnabled,
} from "../../settings/app-settings";

export function createSqliteSettingsStore(
  sqlite: Database.Database,
): SettingsStore {
  return {
    getAppSetting: async (key) => getAppSetting(key, sqlite),
    setAppSetting: async (key, value) => {
      setAppSetting(key, value, sqlite);
    },
    getRuntimeAppSettings: async () => getRuntimeAppSettings(sqlite),
    getPreferredEmbeddingProvider: async () =>
      getPreferredEmbeddingProvider(sqlite),
    getEmbeddingTimeoutMs: async () => getEmbeddingTimeoutMs(sqlite),
    getProviderLibraryEnables: async (provider) =>
      getProviderLibraryEnables(provider, sqlite),
    setProviderLibraryEnabled: async (provider, library, enabled) => {
      setProviderLibraryEnabled(provider, library, enabled, sqlite);
    },
    isProviderIndexEnabled: async (provider, library) =>
      isProviderIndexEnabled(provider, library, sqlite),
  };
}
