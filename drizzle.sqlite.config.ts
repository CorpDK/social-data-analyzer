import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/storage/sqlite/schema.ts",
  out: "./drizzle/sqlite",
});
