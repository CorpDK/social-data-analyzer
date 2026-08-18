import type { NextConfig } from "next";
import { IMPORT_MAX_FILE_SIZE_LIMIT } from "./src/lib/import-limits";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "@napi-rs/keyring"],
  // App Router Route Handlers have no bodyParser sizeLimit (unlike Pages API).
  // Aligned with IMPORT_MAX_FILE_* (512mb): formData buffers multipart in memory;
  // true streaming upload is deferred (Phase 4).
  experimental: {
    proxyClientMaxBodySize: IMPORT_MAX_FILE_SIZE_LIMIT,
    serverActions: {
      bodySizeLimit: IMPORT_MAX_FILE_SIZE_LIMIT,
    },
  },
};

export default nextConfig;
