import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "@napi-rs/keyring"],
};

export default nextConfig;
