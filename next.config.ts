import type { NextConfig } from "next";
import { IMPORT_MAX_FILE_SIZE_LIMIT } from "./src/lib/import-limits";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "@napi-rs/keyring"],
  // App Router Route Handlers have no bodyParser sizeLimit (unlike Pages API).
  // Keep these aligned with IMPORT_MAX_FILE_* for Server Actions / future proxy.
  experimental: {
    proxyClientMaxBodySize: IMPORT_MAX_FILE_SIZE_LIMIT,
    serverActions: {
      bodySizeLimit: IMPORT_MAX_FILE_SIZE_LIMIT,
    },
  },
};

export default nextConfig;
